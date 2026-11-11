// Explicit, ordered, forward-only PostgreSQL migrations.
//
// Rules this module enforces, in code, not by convention:
//   1. Versions are contiguous integers starting at 1. A gap is refused.
//   2. Every migration carries a checksum over its exact statements. If a
//      migration that has already been applied is edited, the next run refuses
//      to start rather than silently diverging.
//   3. Migrations are forward-only. There is no down path, by design: a
//      reversal is a new forward migration written and reviewed deliberately.
//   4. Nothing migrates implicitly. applyMigrations() has to be called on
//      purpose; a repository that finds an unmigrated or differently-versioned
//      database refuses to open rather than migrating it on connect.
//   5. Tenant isolation is part of the schema, not of the calling code:
//      tenant-scoped primary keys and constraints, plus forced row-level
//      security bound to the wimblo.tenant_id session setting.

import {PERSISTENCE_CODES,persistenceFail,sha256,canonicalJson} from './contract.js';

const migration=(version,name,statements)=>Object.freeze({version,name,statements:Object.freeze(statements.map(s=>s.trim())),checksum:sha256(canonicalJson([version,name,statements.map(s=>s.trim().replace(/\s+/g,' '))]))});

export const MIGRATION_LEDGER_TABLE='wimblo_schema_migrations';

// The ledger is itself an explicit statement, executed only inside
// applyMigrations(). Opening a connection never creates it.
export const MIGRATION_LEDGER_DDL=`CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE}(
 version integer PRIMARY KEY,
 name text NOT NULL,
 checksum char(64) NOT NULL,
 applied_at timestamptz NOT NULL DEFAULT now(),
 applied_by text NOT NULL DEFAULT current_user
)`;

const TENANT_TABLES=['tenants','records','users','settings','audit_entries','gift_ledger','gift_allocations','object_metadata'];

export const MIGRATIONS=Object.freeze([
 migration(1,'foundation-tenants-records-users-settings-audit',[
  `CREATE FUNCTION wimblo_current_tenant() RETURNS uuid LANGUAGE plpgsql STABLE AS $fn$
   DECLARE value text;
   BEGIN
    value := current_setting('wimblo.tenant_id', true);
    IF value IS NULL OR value = '' THEN
     RAISE EXCEPTION 'wimblo.tenant_id is not set; every statement must declare its tenant scope' USING ERRCODE = '42501';
    END IF;
    RETURN value::uuid;
   END
  $fn$`,
  `CREATE TABLE tenants(
    tenant_id uuid PRIMARY KEY,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
    residency_profile text NOT NULL,
    database_region text NOT NULL,
    storage_region text NOT NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','exited')),
    created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE records(
    tenant_id uuid NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
    collection text NOT NULL CHECK (collection ~ '^[a-z][A-Za-z0-9]{0,63}$'),
    record_id text NOT NULL CHECK (record_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
    seq bigint GENERATED ALWAYS AS IDENTITY,
    data text NOT NULL,
    search_text text NOT NULL,
    checksum char(64) NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, collection, record_id)
   )`,
  `CREATE INDEX records_tenant_collection_seq ON records(tenant_id, collection, seq)`,
  `CREATE TABLE users(
    tenant_id uuid NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
    user_id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 320),
    role text NOT NULL CHECK (role IN ('admin','staff','viewer')),
    password_hash text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    PRIMARY KEY (tenant_id, user_id)
   )`,
  `CREATE UNIQUE INDEX users_tenant_email ON users(tenant_id, lower(email))`,
  `CREATE TABLE settings(
    tenant_id uuid PRIMARY KEY REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
    data text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE audit_entries(
    tenant_id uuid NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
    audit_id bigint GENERATED ALWAYS AS IDENTITY,
    actor text NOT NULL,
    action text NOT NULL,
    collection text,
    record_id text,
    at timestamptz NOT NULL DEFAULT now(),
    details text NOT NULL DEFAULT '{}',
    PRIMARY KEY (tenant_id, audit_id)
   )`,
  `CREATE INDEX audit_entries_tenant_recent ON audit_entries(tenant_id, audit_id DESC)`,
  `CREATE FUNCTION wimblo_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
   BEGIN
    RAISE EXCEPTION 'Audit is append-only';
   END
  $fn$`,
  `CREATE TRIGGER audit_entries_no_update BEFORE UPDATE ON audit_entries FOR EACH ROW EXECUTE FUNCTION wimblo_audit_append_only()`,
  `CREATE TRIGGER audit_entries_no_delete BEFORE DELETE ON audit_entries FOR EACH ROW EXECUTE FUNCTION wimblo_audit_append_only()`
 ]),
 migration(2,'financial-ledger-projection-in-integer-cents',[
  `CREATE TABLE gift_ledger(
    tenant_id uuid NOT NULL,
    gift_id text NOT NULL,
    collection text NOT NULL DEFAULT 'gifts' CHECK (collection = 'gifts'),
    gift_date date NOT NULL,
    amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
    status text NOT NULL CHECK (status IN ('Posted','Voided')),
    campaign_id text,
    constituent_id text,
    school_year text,
    PRIMARY KEY (tenant_id, gift_id),
    FOREIGN KEY (tenant_id, collection, gift_id) REFERENCES records(tenant_id, collection, record_id) ON DELETE CASCADE
   )`,
  `CREATE TABLE gift_allocations(
    tenant_id uuid NOT NULL,
    gift_id text NOT NULL,
    designation_id text NOT NULL,
    amount_cents bigint NOT NULL CHECK (amount_cents > 0),
    PRIMARY KEY (tenant_id, gift_id, designation_id),
    FOREIGN KEY (tenant_id, gift_id) REFERENCES gift_ledger(tenant_id, gift_id) ON DELETE CASCADE
   )`
 ]),
 // The search index is deliberately composite — (tenant_id, collection,
 // search_text gin_trgm_ops) via btree_gin — rather than a plain trigram index
 // on search_text alone. Reason, found by running the plan against a real
 // server rather than by assuming: under row-level security PostgreSQL will not
 // evaluate a non-leakproof qual before the security qual, and LIKE (~~) is not
 // leakproof. A trigram-only index is therefore never used by the application
 // role, whatever its size. The composite index still restricts the scan to one
 // tenant and collection through leakproof equality, so search cost is bounded
 // by the tenant's own rows instead of the whole table, and the trigram portion
 // is additionally usable by an administrative role for which RLS is not in
 // force. scripts/postgres-verify.mjs proves both halves of that statement.
 migration(3,'search-and-reporting-access-paths',[
  `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
  `CREATE EXTENSION IF NOT EXISTS btree_gin`,
  `CREATE INDEX records_tenant_search_trgm ON records USING gin (tenant_id, collection, search_text gin_trgm_ops)`,
  `CREATE INDEX gift_ledger_reporting ON gift_ledger(tenant_id, status, gift_date) INCLUDE (amount_cents)`,
  `CREATE INDEX gift_ledger_campaign ON gift_ledger(tenant_id, campaign_id, gift_date)`,
  `CREATE INDEX gift_ledger_constituent ON gift_ledger(tenant_id, constituent_id, gift_date)`,
  `CREATE INDEX gift_allocations_designation ON gift_allocations(tenant_id, designation_id) INCLUDE (amount_cents)`
 ]),
 migration(4,'private-object-metadata-retention-and-custody',[
  `CREATE TABLE object_metadata(
    tenant_id uuid NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
    object_id text NOT NULL,
    revision integer NOT NULL CHECK (revision >= 1),
    object_key text NOT NULL,
    provider text NOT NULL CHECK (provider IN ('s3','memory')),
    bucket text NOT NULL,
    namespace text NOT NULL,
    region text NOT NULL,
    residency_profile text NOT NULL,
    custody text NOT NULL CHECK (custody IN ('provider-managed-key','customer-managed-key','application-managed-key')),
    content_type text NOT NULL,
    size_bytes bigint NOT NULL CHECK (size_bytes > 0),
    sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    ciphertext_sha256 char(64) NOT NULL CHECK (ciphertext_sha256 ~ '^[a-f0-9]{64}$'),
    encryption_algorithm text NOT NULL,
    encryption_key_id text NOT NULL,
    provider_version text,
    state text NOT NULL CHECK (state IN ('staged','active','deletion_requested','deleted')),
    legal_hold boolean NOT NULL DEFAULT false,
    retain_until date,
    created_at timestamptz NOT NULL DEFAULT now(),
    state_changed_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CHECK ((state = 'deleted') = (deleted_at IS NOT NULL)),
    PRIMARY KEY (tenant_id, object_id, revision)
   )`,
  `CREATE UNIQUE INDEX object_metadata_key ON object_metadata(tenant_id, object_key)`,
  `CREATE INDEX object_metadata_state ON object_metadata(tenant_id, state, retain_until)`
 ]),
 migration(5,'forced-row-level-tenant-isolation',
  TENANT_TABLES.flatMap(table=>[
   `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
   `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
   `CREATE POLICY ${table}_tenant_isolation ON ${table} USING (tenant_id = wimblo_current_tenant()) WITH CHECK (tenant_id = wimblo_current_tenant())`
  ])
 ),
 migration(6,'platform-identities-memberships-sessions-and-mfa',[
  `CREATE SCHEMA IF NOT EXISTS wimblo_platform`,
  `CREATE TABLE wimblo_platform.global_identities(
    identity_id uuid PRIMARY KEY,
    normalized_email text NOT NULL CHECK (normalized_email = lower(btrim(normalized_email)) AND char_length(normalized_email) BETWEEN 3 AND 320),
    display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
    password_hash text NOT NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
    security_version integer NOT NULL DEFAULT 1 CHECK (security_version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (normalized_email)
   )`,
  `CREATE TABLE wimblo_platform.memberships(
    membership_id uuid NOT NULL UNIQUE,
    tenant_id uuid NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
    identity_id uuid NOT NULL REFERENCES wimblo_platform.global_identities(identity_id) ON DELETE RESTRICT,
    role text NOT NULL CHECK (role IN ('owner','admin','staff','viewer','helper')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, identity_id)
   )`,
  `CREATE INDEX memberships_identity ON wimblo_platform.memberships(identity_id, status)`,
  `CREATE TABLE wimblo_platform.invitations(
    invitation_id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
    token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
    normalized_email text NOT NULL CHECK (normalized_email = lower(btrim(normalized_email)) AND char_length(normalized_email) BETWEEN 3 AND 320),
    role text NOT NULL CHECK (role IN ('owner','admin','staff','viewer','helper')),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','consumed','revoked','expired')),
    created_by uuid NOT NULL REFERENCES wimblo_platform.global_identities(identity_id) ON DELETE RESTRICT,
    consumed_by uuid REFERENCES wimblo_platform.global_identities(identity_id) ON DELETE RESTRICT,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    revoked_at timestamptz,
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((status = 'consumed') = (consumed_at IS NOT NULL)),
    CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
   )`,
  `CREATE INDEX invitations_tenant_status ON wimblo_platform.invitations(tenant_id, status, expires_at)`,
  `CREATE TABLE wimblo_platform.opaque_sessions(
    token_hash char(64) PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
    csrf_hash char(64) NOT NULL CHECK (csrf_hash ~ '^[a-f0-9]{64}$'),
    tenant_id uuid NOT NULL,
    identity_id uuid NOT NULL,
    membership_version integer NOT NULL CHECK (membership_version >= 1),
    security_version integer NOT NULL CHECK (security_version >= 1),
    mfa_verified_at timestamptz,
    recent_authenticated_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    FOREIGN KEY (tenant_id, identity_id) REFERENCES wimblo_platform.memberships(tenant_id, identity_id) ON DELETE CASCADE
   )`,
  `CREATE INDEX opaque_sessions_identity ON wimblo_platform.opaque_sessions(identity_id, expires_at) WHERE revoked_at IS NULL`,
  `CREATE TABLE wimblo_platform.mfa_settings(
    identity_id uuid PRIMARY KEY REFERENCES wimblo_platform.global_identities(identity_id) ON DELETE CASCADE,
    state text NOT NULL CHECK (state IN ('required','enrolling','active','recovery_required','disabled')),
    secret_ciphertext text,
    enrolled_at timestamptz,
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (state NOT IN ('active','recovery_required') OR enrolled_at IS NOT NULL)
   )`,
  `CREATE TABLE wimblo_platform.mfa_recovery_codes(
    identity_id uuid NOT NULL REFERENCES wimblo_platform.global_identities(identity_id) ON DELETE CASCADE,
    code_hash char(64) NOT NULL CHECK (code_hash ~ '^[a-f0-9]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    used_at timestamptz,
    PRIMARY KEY (identity_id, code_hash)
   )`,
  `CREATE TABLE wimblo_platform.mfa_challenges(
    challenge_id uuid PRIMARY KEY,
    identity_id uuid NOT NULL REFERENCES wimblo_platform.global_identities(identity_id) ON DELETE CASCADE,
    purpose text NOT NULL CHECK (purpose IN ('enrollment','sign_in','recovery','step_up')),
    challenge_hash char(64) NOT NULL CHECK (challenge_hash ~ '^[a-f0-9]{64}$'),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
    expires_at timestamptz NOT NULL,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX mfa_challenges_identity ON wimblo_platform.mfa_challenges(identity_id, expires_at) WHERE completed_at IS NULL`,
  `CREATE TABLE wimblo_platform.control_audit(
    audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id uuid REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
    identity_id uuid REFERENCES wimblo_platform.global_identities(identity_id) ON DELETE RESTRICT,
    actor_identity_id uuid REFERENCES wimblo_platform.global_identities(identity_id) ON DELETE RESTRICT,
    action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 120),
    target_type text NOT NULL CHECK (char_length(target_type) BETWEEN 1 AND 80),
    target_id text NOT NULL CHECK (char_length(target_id) BETWEEN 1 AND 200),
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE FUNCTION wimblo_platform.control_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
   BEGIN
    RAISE EXCEPTION 'Control audit is append-only';
   END
  $fn$`,
  `CREATE TRIGGER control_audit_no_update BEFORE UPDATE ON wimblo_platform.control_audit FOR EACH ROW EXECUTE FUNCTION wimblo_platform.control_audit_append_only()`,
  `CREATE TRIGGER control_audit_no_delete BEFORE DELETE ON wimblo_platform.control_audit FOR EACH ROW EXECUTE FUNCTION wimblo_platform.control_audit_append_only()`
 ]),
 migration(7,'capability-catalog-and-tenant-modules',[
  `CREATE TABLE wimblo_platform.module_catalog(
    module_key text PRIMARY KEY CHECK (module_key ~ '^[a-z][a-z0-9_-]{1,63}$'),
    display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
    contract_version integer NOT NULL CHECK (contract_version >= 1),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deprecated','retired')),
    dependencies jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `INSERT INTO wimblo_platform.module_catalog(module_key,display_name,contract_version,dependencies) VALUES
    ('core','CRM Core',1,'[]'::jsonb),('sales','Sales',1,'["core"]'::jsonb),('marketing','Marketing',1,'["core"]'::jsonb),
    ('service','Service',1,'["core"]'::jsonb),('events','Events',1,'["core"]'::jsonb),('membership','Membership',1,'["core"]'::jsonb),
    ('fundraising','Fundraising',1,'["core","membership"]'::jsonb),('grants','Grants',1,'["core"]'::jsonb),('volunteer','Volunteer',1,'["core"]'::jsonb),
    ('payments','Payments',1,'["core"]'::jsonb),('intelligence','Intelligence',1,'["core"]'::jsonb)`,
  `CREATE TABLE wimblo_platform.tenant_modules(
    tenant_id uuid NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
    module_key text NOT NULL REFERENCES wimblo_platform.module_catalog(module_key) ON DELETE RESTRICT,
    state text NOT NULL CHECK (state IN ('disabled','enabled','suspended','retiring')),
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    enabled_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, module_key)
   )`,
  `CREATE TABLE wimblo_platform.module_events(
    tenant_id uuid NOT NULL,
    event_id uuid NOT NULL,
    module_key text NOT NULL,
    event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 120),
    actor_identity_id uuid REFERENCES wimblo_platform.global_identities(identity_id) ON DELETE RESTRICT,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, event_id),
    FOREIGN KEY (tenant_id, module_key) REFERENCES wimblo_platform.tenant_modules(tenant_id, module_key) ON DELETE RESTRICT
   )`,
  `ALTER TABLE wimblo_platform.tenant_modules ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE wimblo_platform.tenant_modules FORCE ROW LEVEL SECURITY`,
  `CREATE POLICY tenant_modules_tenant_isolation ON wimblo_platform.tenant_modules USING (tenant_id = wimblo_current_tenant()) WITH CHECK (tenant_id = wimblo_current_tenant())`,
  `ALTER TABLE wimblo_platform.module_events ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE wimblo_platform.module_events FORCE ROW LEVEL SECURITY`,
  `CREATE POLICY module_events_tenant_isolation ON wimblo_platform.module_events USING (tenant_id = wimblo_current_tenant()) WITH CHECK (tenant_id = wimblo_current_tenant())`
 ]),
 migration(8,'durable-jobs-attempts-and-dead-letter-state',[
  `CREATE TABLE wimblo_platform.durable_jobs(
    tenant_id uuid NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
    job_id uuid NOT NULL,
    queue text NOT NULL CHECK (queue ~ '^[a-z][a-z0-9_-]{0,63}$'),
    kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.:-]{0,127}$'),
    idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
    payload jsonb NOT NULL,
    state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','leased','retry_wait','completed','dead_lettered','cancelled')),
    priority smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
    available_at timestamptz NOT NULL DEFAULT now(),
    lease_owner text,
    lease_expires_at timestamptz,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 25),
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    PRIMARY KEY (tenant_id, job_id),
    UNIQUE (tenant_id, idempotency_key),
    CHECK ((state = 'leased') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
   )`,
  `CREATE INDEX durable_jobs_claim ON wimblo_platform.durable_jobs(queue, state, available_at, priority DESC)`,
  `CREATE TABLE wimblo_platform.durable_job_attempts(
    tenant_id uuid NOT NULL,
    job_id uuid NOT NULL,
    attempt integer NOT NULL CHECK (attempt >= 1),
    worker_id text NOT NULL,
    started_at timestamptz NOT NULL,
    finished_at timestamptz,
    outcome text CHECK (outcome IN ('completed','retry','dead_lettered','cancelled')),
    error_code text,
    error_detail text,
    PRIMARY KEY (tenant_id, job_id, attempt),
    FOREIGN KEY (tenant_id, job_id) REFERENCES wimblo_platform.durable_jobs(tenant_id, job_id) ON DELETE RESTRICT
   )`,
  `CREATE TABLE wimblo_platform.dead_letter_jobs(
    tenant_id uuid NOT NULL,
    job_id uuid NOT NULL,
    dead_lettered_at timestamptz NOT NULL DEFAULT now(),
    reason_code text NOT NULL,
    reason_detail text NOT NULL,
    reviewed_at timestamptz,
    reviewed_by uuid REFERENCES wimblo_platform.global_identities(identity_id) ON DELETE RESTRICT,
    resolution text,
    PRIMARY KEY (tenant_id, job_id),
    FOREIGN KEY (tenant_id, job_id) REFERENCES wimblo_platform.durable_jobs(tenant_id, job_id) ON DELETE RESTRICT
   )`,
  `ALTER TABLE wimblo_platform.durable_jobs ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE wimblo_platform.durable_jobs FORCE ROW LEVEL SECURITY`,
  `CREATE POLICY durable_jobs_tenant_isolation ON wimblo_platform.durable_jobs USING (tenant_id = wimblo_current_tenant()) WITH CHECK (tenant_id = wimblo_current_tenant())`,
  `ALTER TABLE wimblo_platform.durable_job_attempts ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE wimblo_platform.durable_job_attempts FORCE ROW LEVEL SECURITY`,
  `CREATE POLICY durable_job_attempts_tenant_isolation ON wimblo_platform.durable_job_attempts USING (tenant_id = wimblo_current_tenant()) WITH CHECK (tenant_id = wimblo_current_tenant())`,
  `ALTER TABLE wimblo_platform.dead_letter_jobs ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE wimblo_platform.dead_letter_jobs FORCE ROW LEVEL SECURITY`,
  `CREATE POLICY dead_letter_jobs_tenant_isolation ON wimblo_platform.dead_letter_jobs USING (tenant_id = wimblo_current_tenant()) WITH CHECK (tenant_id = wimblo_current_tenant())`
 ]),
 migration(9,'tenant-lifecycle-retention-and-versioning',[
  `ALTER TABLE tenants ADD COLUMN retention_until timestamptz`,
  `ALTER TABLE tenants ADD COLUMN deletion_scheduled_at timestamptz`,
  `ALTER TABLE tenants ADD COLUMN lifecycle_version integer NOT NULL DEFAULT 1 CHECK (lifecycle_version >= 1)`,
  `ALTER TABLE tenants ADD CONSTRAINT tenants_status_expand_check CHECK (status IN ('active','suspended','exited','export_pending','deletion_scheduled','legal_hold','closed')) NOT VALID`,
  `ALTER TABLE tenants VALIDATE CONSTRAINT tenants_status_expand_check`,
  `ALTER TABLE tenants DROP CONSTRAINT tenants_status_check`,
  `UPDATE tenants SET status = 'closed', lifecycle_version = lifecycle_version + 1 WHERE status = 'exited'`,
  `ALTER TABLE tenants DROP CONSTRAINT tenants_status_expand_check`,
  `ALTER TABLE tenants ADD CONSTRAINT tenants_status_check CHECK (status IN ('active','suspended','export_pending','deletion_scheduled','legal_hold','closed')) NOT VALID`,
  `ALTER TABLE tenants VALIDATE CONSTRAINT tenants_status_check`,
  `ALTER TABLE tenants ADD CONSTRAINT tenants_lifecycle_dates_check CHECK (status <> 'deletion_scheduled' OR deletion_scheduled_at IS NOT NULL) NOT VALID`,
  `ALTER TABLE tenants VALIDATE CONSTRAINT tenants_lifecycle_dates_check`,
  `CREATE FUNCTION wimblo_platform.tenant_state(requested_tenant uuid) RETURNS TABLE(tenant_id uuid,status text,lifecycle_version integer)
   LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
    SELECT t.tenant_id,t.status,t.lifecycle_version FROM public.tenants t WHERE t.tenant_id=requested_tenant
   $fn$`,
  `REVOKE ALL ON FUNCTION wimblo_platform.tenant_state(uuid) FROM PUBLIC`
 ]),
 migration(10,'durable-job-claim-access-paths',[
  `CREATE INDEX durable_jobs_due_claim_v2 ON wimblo_platform.durable_jobs(tenant_id, queue, available_at, priority DESC, created_at, job_id) WHERE state IN ('ready','retry_wait')`,
  `CREATE INDEX durable_jobs_expired_claim_v2 ON wimblo_platform.durable_jobs(tenant_id, queue, lease_expires_at, job_id) WHERE state = 'leased'`
 ]),
 migration(11,'worker-runnable-tenant-boundary',[
  `CREATE FUNCTION wimblo_platform.runnable_tenant_ids() RETURNS TABLE(tenant_id uuid)
   LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
    SELECT t.tenant_id FROM public.tenants t WHERE t.status='active' ORDER BY t.tenant_id
   $fn$`,
  `REVOKE ALL ON FUNCTION wimblo_platform.runnable_tenant_ids() FROM PUBLIC`
 ]),
 migration(12,'readiness-dead-letter-aggregate',[
  `CREATE FUNCTION wimblo_platform.dead_letter_count() RETURNS bigint
   LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, wimblo_platform AS $fn$
    SELECT count(*)::bigint FROM wimblo_platform.dead_letter_jobs
   $fn$`,
  `REVOKE ALL ON FUNCTION wimblo_platform.dead_letter_count() FROM PUBLIC`
 ]),
 migration(13,'canonical-party-person-organization-contact-relationships',[
  `CREATE TABLE parties(
    tenant_id uuid NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
    party_id uuid NOT NULL,
    party_type text NOT NULL CHECK (party_type IN ('person','organization')),
    display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','merged')),
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, party_id)
   )`,
  `CREATE TABLE people(
    tenant_id uuid NOT NULL,
    party_id uuid NOT NULL,
    first_name text NOT NULL CHECK (char_length(first_name) BETWEEN 1 AND 120),
    middle_name text CHECK (char_length(middle_name) BETWEEN 1 AND 120),
    last_name text NOT NULL CHECK (char_length(last_name) BETWEEN 1 AND 160),
    preferred_name text CHECK (char_length(preferred_name) BETWEEN 1 AND 160),
    birth_date date,
    is_deceased boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, party_id),
    FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, party_id) ON DELETE CASCADE
   )`,
  `CREATE TABLE organizations(
    tenant_id uuid NOT NULL,
    party_id uuid NOT NULL,
    legal_name text NOT NULL CHECK (char_length(legal_name) BETWEEN 1 AND 240),
    domain text CHECK (char_length(domain) BETWEEN 1 AND 253),
    industry text CHECK (char_length(industry) BETWEEN 1 AND 120),
    employee_count integer CHECK (employee_count >= 0),
    founded_on date,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, party_id),
    FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, party_id) ON DELETE CASCADE
   )`,
  `CREATE FUNCTION wimblo_party_subtype_matches() RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE parent_type text;
    BEGIN
     SELECT party_type INTO parent_type FROM parties WHERE tenant_id=NEW.tenant_id AND party_id=NEW.party_id;
     IF parent_type IS NULL THEN
      RAISE EXCEPTION 'Party subtype has no parent party' USING ERRCODE='23503';
     END IF;
     IF TG_TABLE_NAME='people' AND parent_type <> 'person' THEN
      RAISE EXCEPTION 'Person subtype requires a person party' USING ERRCODE='23514';
     END IF;
     IF TG_TABLE_NAME='organizations' AND parent_type <> 'organization' THEN
      RAISE EXCEPTION 'Organization subtype requires an organization party' USING ERRCODE='23514';
     END IF;
     RETURN NEW;
    END
   $fn$`,
  `CREATE TRIGGER people_party_type_matches BEFORE INSERT ON people FOR EACH ROW EXECUTE FUNCTION wimblo_party_subtype_matches()`,
  `CREATE TRIGGER organizations_party_type_matches BEFORE INSERT ON organizations FOR EACH ROW EXECUTE FUNCTION wimblo_party_subtype_matches()`,
  `CREATE FUNCTION wimblo_party_type_immutable() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
     IF NEW.party_type <> OLD.party_type THEN
      RAISE EXCEPTION 'Party type is immutable' USING ERRCODE='23514';
     END IF;
     RETURN NEW;
    END
   $fn$`,
  `CREATE TRIGGER party_type_immutable BEFORE UPDATE OF party_type ON parties FOR EACH ROW EXECUTE FUNCTION wimblo_party_type_immutable()`,
  `CREATE TABLE contact_points(
    tenant_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    party_id uuid NOT NULL,
    type text NOT NULL CHECK (type IN ('email','phone','address','website')),
    normalized_value text NOT NULL CHECK (char_length(normalized_value) BETWEEN 1 AND 320),
    display_value text NOT NULL CHECK (char_length(display_value) BETWEEN 1 AND 500),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','invalid','retired')),
    is_primary boolean NOT NULL DEFAULT false,
    verified_at timestamptz,
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, contact_id),
    UNIQUE (tenant_id, type, normalized_value),
    FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, party_id) ON DELETE CASCADE
   )`,
  `CREATE TABLE relationships(
    tenant_id uuid NOT NULL,
    relationship_id uuid NOT NULL,
    from_party_id uuid NOT NULL,
    to_party_id uuid NOT NULL,
    type text NOT NULL CHECK (type IN ('employee','owner','member','parent','partner','other')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended','merged')),
    effective_from date NOT NULL,
    effective_to date,
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, relationship_id),
    FOREIGN KEY (tenant_id, from_party_id) REFERENCES parties(tenant_id, party_id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, to_party_id) REFERENCES parties(tenant_id, party_id) ON DELETE CASCADE,
    CHECK (from_party_id <> to_party_id),
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
   )`,
  `CREATE TABLE party_events(
    tenant_id uuid NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
    event_id uuid NOT NULL,
    target_type text NOT NULL CHECK (target_type IN ('party','contact','relationship')),
    target_id uuid NOT NULL,
    action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 120),
    actor_identity_id uuid,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, event_id)
   )`,
  `CREATE FUNCTION wimblo_party_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
     RAISE EXCEPTION 'Party event history is append-only';
    END
   $fn$`,
  `CREATE TRIGGER party_event_no_update BEFORE UPDATE ON party_events FOR EACH ROW EXECUTE FUNCTION wimblo_party_event_append_only()`,
  `CREATE TRIGGER party_event_no_delete BEFORE DELETE ON party_events FOR EACH ROW EXECUTE FUNCTION wimblo_party_event_append_only()`,
  `CREATE INDEX parties_tenant_name ON parties(tenant_id, display_name, party_id)`,
  `CREATE INDEX contact_points_tenant_normalized ON contact_points(tenant_id, type, normalized_value)`,
  `CREATE INDEX contact_points_party ON contact_points(tenant_id, party_id, type, is_primary DESC)`,
  `CREATE INDEX relationships_from ON relationships(tenant_id, from_party_id, status)`,
  `CREATE INDEX relationships_to ON relationships(tenant_id, to_party_id, status)`,
  `CREATE INDEX party_events_target ON party_events(tenant_id, target_type, target_id, at DESC)`,
  ...['parties','people','organizations','contact_points','relationships','party_events'].flatMap(table=>[
   `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
   `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
   `CREATE POLICY ${table}_tenant_isolation ON ${table} USING (tenant_id = wimblo_current_tenant()) WITH CHECK (tenant_id = wimblo_current_tenant())`
  ])
 ]),
 migration(14,'production-crm-pipelines-leads-and-opportunities',[
  `CREATE TABLE pipelines(
    tenant_id uuid NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
    pipeline_id uuid NOT NULL,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
    is_default boolean NOT NULL DEFAULT false,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, pipeline_id)
   )`,
  `CREATE UNIQUE INDEX pipelines_one_default ON pipelines(tenant_id) WHERE is_default`,
  `CREATE TABLE pipeline_stages(
    tenant_id uuid NOT NULL,
    stage_id uuid NOT NULL,
    pipeline_id uuid NOT NULL,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 and 160),
    kind text NOT NULL CHECK (kind IN ('open','won','lost')),
    position integer NOT NULL CHECK (position BETWEEN 1 AND 100),
    probability integer NOT NULL CHECK (probability BETWEEN 0 AND 100),
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, stage_id),
    FOREIGN KEY (tenant_id, pipeline_id) REFERENCES pipelines(tenant_id, pipeline_id) ON DELETE CASCADE,
    UNIQUE (tenant_id, pipeline_id, position),
    UNIQUE (tenant_id, pipeline_id, stage_id)
   )`,
  `CREATE INDEX pipeline_stages_view ON pipeline_stages(tenant_id, pipeline_id, position)`,
  `CREATE TABLE leads(
    tenant_id uuid NOT NULL,
    lead_id uuid NOT NULL,
    party_id uuid NOT NULL,
    pipeline_id uuid NOT NULL,
    stage_id uuid NOT NULL,
    source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 120),
    status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','working','qualified','converted','disqualified')),
    owner_identity_id uuid,
    expected_value_cents bigint NOT NULL CHECK (expected_value_cents >= 0 AND expected_value_cents <= 9007199254740991),
    currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    probability integer NOT NULL CHECK (probability BETWEEN 0 AND 100),
    expected_close_date date NOT NULL,
    converted_opportunity_id uuid,
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((status = 'converted') = (converted_opportunity_id IS NOT NULL)),
    PRIMARY KEY (tenant_id, lead_id),
    FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, party_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, pipeline_id) REFERENCES pipelines(tenant_id, pipeline_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, pipeline_id, stage_id) REFERENCES pipeline_stages(tenant_id, pipeline_id, stage_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, owner_identity_id) REFERENCES wimblo_platform.memberships(tenant_id, identity_id) ON DELETE RESTRICT
   )`,
  `CREATE INDEX leads_qualification ON leads(tenant_id, status, probability, expected_value_cents)`,
  `CREATE TABLE opportunities(
    tenant_id uuid NOT NULL,
    opportunity_id uuid NOT NULL,
    party_id uuid NOT NULL,
    pipeline_id uuid NOT NULL,
    stage_id uuid NOT NULL,
    lead_id uuid,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
    amount_cents bigint NOT NULL CHECK (amount_cents >= 0 AND amount_cents <= 9007199254740991),
    currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    probability integer NOT NULL CHECK (probability BETWEEN 0 AND 100),
    expected_close_date date NOT NULL,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost')),
    owner_identity_id uuid,
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, opportunity_id),
    FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, party_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, pipeline_id) REFERENCES pipelines(tenant_id, pipeline_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, pipeline_id, stage_id) REFERENCES pipeline_stages(tenant_id, pipeline_id, stage_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, lead_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, owner_identity_id) REFERENCES wimblo_platform.memberships(tenant_id, identity_id) ON DELETE RESTRICT,
    UNIQUE (tenant_id, lead_id),
    UNIQUE (tenant_id, pipeline_id, opportunity_id)
   )`,
  `ALTER TABLE leads ADD CONSTRAINT leads_converted_opportunity_fk
    FOREIGN KEY (tenant_id, converted_opportunity_id) REFERENCES opportunities(tenant_id, opportunity_id) ON DELETE RESTRICT`,
  `CREATE INDEX opportunities_owner_status ON opportunities(tenant_id, owner_identity_id, status, expected_close_date)`,
  `CREATE INDEX opportunities_forecast ON opportunities(tenant_id, expected_close_date) INCLUDE (amount_cents, probability, currency)`,
  `CREATE TABLE opportunity_stage_events(
    tenant_id uuid NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
    event_id uuid NOT NULL,
    opportunity_id uuid NOT NULL,
    pipeline_id uuid NOT NULL,
    from_stage_id uuid,
    to_stage_id uuid,
    action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 120),
    actor_identity_id uuid,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, event_id),
    FOREIGN KEY (tenant_id, pipeline_id, opportunity_id) REFERENCES opportunities(tenant_id, pipeline_id, opportunity_id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, pipeline_id, from_stage_id) REFERENCES pipeline_stages(tenant_id, pipeline_id, stage_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, pipeline_id, to_stage_id) REFERENCES pipeline_stages(tenant_id, pipeline_id, stage_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, actor_identity_id) REFERENCES wimblo_platform.memberships(tenant_id, identity_id) ON DELETE RESTRICT
   )`,
  `CREATE INDEX opportunity_stage_events_view ON opportunity_stage_events(tenant_id, opportunity_id, at DESC)`,
  `CREATE FUNCTION wimblo_opportunity_stage_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
     RAISE EXCEPTION 'Opportunity stage history is append-only';
    END
   $fn$`,
  `CREATE TRIGGER opportunity_stage_event_no_update BEFORE UPDATE ON opportunity_stage_events FOR EACH ROW EXECUTE FUNCTION wimblo_opportunity_stage_event_append_only()`,
  `CREATE TRIGGER opportunity_stage_event_no_delete BEFORE DELETE ON opportunity_stage_events FOR EACH ROW EXECUTE FUNCTION wimblo_opportunity_stage_event_append_only()`,
  ...['pipelines','pipeline_stages','leads','opportunities','opportunity_stage_events'].flatMap(table=>[
   `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
   `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
   `CREATE POLICY ${table}_tenant_isolation ON ${table} USING (tenant_id = wimblo_current_tenant()) WITH CHECK (tenant_id = wimblo_current_tenant())`
  ])
 ]),
 migration(15,'production-crm-work-and-timeline',[
  `CREATE TABLE crm_subjects(
    tenant_id uuid NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
    subject_id uuid NOT NULL,
    subject_type text NOT NULL CHECK (subject_type IN ('party','lead','opportunity')),
    party_id uuid,
    lead_id uuid,
    opportunity_id uuid,
    owner_identity_id uuid,
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, subject_id),
    CHECK ((subject_type='party' AND party_id IS NOT NULL AND lead_id IS NULL AND opportunity_id IS NULL)
      OR (subject_type='lead' AND party_id IS NULL AND lead_id IS NOT NULL AND opportunity_id IS NULL)
      OR (subject_type='opportunity' AND party_id IS NULL AND lead_id IS NULL AND opportunity_id IS NOT NULL)),
    FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, party_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, lead_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities(tenant_id, opportunity_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, owner_identity_id) REFERENCES wimblo_platform.memberships(tenant_id, identity_id) ON DELETE RESTRICT,
    UNIQUE (tenant_id, party_id),
    UNIQUE (tenant_id, lead_id),
    UNIQUE (tenant_id, opportunity_id)
   )`,
  `INSERT INTO crm_subjects(tenant_id,subject_id,subject_type,party_id,created_at,updated_at)
   SELECT tenant_id,party_id,'party',party_id,created_at,updated_at FROM parties`,
  `INSERT INTO crm_subjects(tenant_id,subject_id,subject_type,lead_id,owner_identity_id,created_at,updated_at)
   SELECT tenant_id,lead_id,'lead',lead_id,owner_identity_id,created_at,updated_at FROM leads`,
  `INSERT INTO crm_subjects(tenant_id,subject_id,subject_type,opportunity_id,owner_identity_id,created_at,updated_at)
   SELECT tenant_id,opportunity_id,'opportunity',opportunity_id,owner_identity_id,created_at,updated_at FROM opportunities`,
  `CREATE TABLE crm_activities(
    tenant_id uuid NOT NULL,
    activity_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    activity_type text NOT NULL CHECK (activity_type IN ('call','meeting','email','message','other')),
    summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 500),
    outcome text CHECK (outcome IS NULL OR char_length(outcome) BETWEEN 1 AND 2000),
    actor_identity_id uuid NOT NULL,
    occurred_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, activity_id),
    FOREIGN KEY (tenant_id, subject_id) REFERENCES crm_subjects(tenant_id, subject_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, actor_identity_id) REFERENCES wimblo_platform.memberships(tenant_id, identity_id) ON DELETE RESTRICT
   )`,
  `CREATE TABLE crm_tasks(
    tenant_id uuid NOT NULL,
    task_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
    details text CHECK (details IS NULL OR char_length(details) BETWEEN 1 AND 4000),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','completed','cancelled')),
    owner_identity_id uuid NOT NULL,
    due_at timestamptz,
    reminder_at timestamptz,
    completed_at timestamptz,
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, task_id),
    CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
    FOREIGN KEY (tenant_id, subject_id) REFERENCES crm_subjects(tenant_id, subject_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, owner_identity_id) REFERENCES wimblo_platform.memberships(tenant_id, identity_id) ON DELETE RESTRICT,
    UNIQUE (tenant_id, subject_id, task_id)
   )`,
  `CREATE TABLE crm_task_events(
    tenant_id uuid NOT NULL,
    event_id uuid NOT NULL,
    task_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    action text NOT NULL CHECK (action IN ('created','updated','completed','reopened','cancelled')),
    actor_identity_id uuid NOT NULL,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, event_id),
    FOREIGN KEY (tenant_id, subject_id, task_id) REFERENCES crm_tasks(tenant_id, subject_id, task_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, actor_identity_id) REFERENCES wimblo_platform.memberships(tenant_id, identity_id) ON DELETE RESTRICT
   )`,
  `CREATE TABLE crm_notes(
    tenant_id uuid NOT NULL,
    note_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
    current_revision integer NOT NULL DEFAULT 1 CHECK (current_revision >= 1),
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, note_id),
    FOREIGN KEY (tenant_id, subject_id) REFERENCES crm_subjects(tenant_id, subject_id) ON DELETE RESTRICT,
    UNIQUE (tenant_id, subject_id, note_id)
   )`,
  `CREATE TABLE crm_note_revisions(
    tenant_id uuid NOT NULL,
    note_id uuid NOT NULL,
    revision integer NOT NULL CHECK (revision >= 1),
    subject_id uuid NOT NULL,
    body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000),
    actor_identity_id uuid NOT NULL,
    occurred_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, note_id, revision),
    FOREIGN KEY (tenant_id, subject_id, note_id) REFERENCES crm_notes(tenant_id, subject_id, note_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, actor_identity_id) REFERENCES wimblo_platform.memberships(tenant_id, identity_id) ON DELETE RESTRICT
   )`,
  `CREATE TABLE crm_attachment_links(
    tenant_id uuid NOT NULL,
    link_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    object_id text NOT NULL,
    object_revision integer NOT NULL CHECK (object_revision >= 1),
    file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
    content_type text NOT NULL CHECK (char_length(content_type) BETWEEN 1 AND 200),
    size_bytes bigint NOT NULL CHECK (size_bytes > 0),
    actor_identity_id uuid NOT NULL,
    occurred_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, link_id),
    FOREIGN KEY (tenant_id, subject_id) REFERENCES crm_subjects(tenant_id, subject_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, object_id, object_revision) REFERENCES object_metadata(tenant_id, object_id, revision) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, actor_identity_id) REFERENCES wimblo_platform.memberships(tenant_id, identity_id) ON DELETE RESTRICT,
    UNIQUE (tenant_id, subject_id, object_id, object_revision)
   )`,
  `CREATE TABLE crm_ownership_events(
    tenant_id uuid NOT NULL,
    event_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    from_owner_identity_id uuid,
    to_owner_identity_id uuid,
    actor_identity_id uuid NOT NULL,
    occurred_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, event_id),
    CHECK (from_owner_identity_id IS DISTINCT FROM to_owner_identity_id),
    FOREIGN KEY (tenant_id, subject_id) REFERENCES crm_subjects(tenant_id, subject_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, from_owner_identity_id) REFERENCES wimblo_platform.memberships(tenant_id, identity_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, to_owner_identity_id) REFERENCES wimblo_platform.memberships(tenant_id, identity_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, actor_identity_id) REFERENCES wimblo_platform.memberships(tenant_id, identity_id) ON DELETE RESTRICT
   )`,
  `CREATE INDEX crm_subjects_type ON crm_subjects(tenant_id, subject_type, subject_id)`,
  `CREATE INDEX crm_activities_timeline ON crm_activities(tenant_id, subject_id, occurred_at DESC, activity_id DESC)`,
  `CREATE INDEX crm_tasks_worklist ON crm_tasks(tenant_id, owner_identity_id, status, due_at, task_id) WHERE status IN ('open','in_progress')`,
  `CREATE INDEX crm_task_events_timeline ON crm_task_events(tenant_id, subject_id, occurred_at DESC, event_id DESC)`,
  `CREATE INDEX crm_note_revisions_timeline ON crm_note_revisions(tenant_id, subject_id, occurred_at DESC, note_id DESC, revision DESC)`,
  `CREATE INDEX crm_attachment_links_timeline ON crm_attachment_links(tenant_id, subject_id, occurred_at DESC, link_id DESC)`,
  `CREATE INDEX crm_ownership_events_timeline ON crm_ownership_events(tenant_id, subject_id, occurred_at DESC, event_id DESC)`,
  `CREATE FUNCTION wimblo_crm_work_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN RAISE EXCEPTION 'CRM work history is append-only'; END
   $fn$`,
  ...[
   ['crm_activities','crm_activity_append_only'],
   ['crm_task_events','crm_task_event_append_only'],
   ['crm_note_revisions','crm_note_revision_append_only'],
   ['crm_attachment_links','crm_attachment_link_append_only'],
   ['crm_ownership_events','crm_ownership_event_append_only']
  ].flatMap(([table,name])=>[
   `CREATE TRIGGER ${name}_update BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION wimblo_crm_work_append_only()`,
   `CREATE TRIGGER ${name}_delete BEFORE DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION wimblo_crm_work_append_only()`
  ]),
  ...['crm_subjects','crm_activities','crm_tasks','crm_task_events','crm_notes','crm_note_revisions','crm_attachment_links','crm_ownership_events'].flatMap(table=>[
   `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
   `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
   `CREATE POLICY ${table}_tenant_isolation ON ${table} USING (tenant_id = wimblo_current_tenant()) WITH CHECK (tenant_id = wimblo_current_tenant())`
  ])
 ])
]);

export const SCHEMA_VERSION=MIGRATIONS[MIGRATIONS.length-1].version;

export function validateMigrations(list=MIGRATIONS){
 if(!Array.isArray(list)||!list.length)persistenceFail(PERSISTENCE_CODES.MIGRATION,'At least one migration is required.');
 const versions=new Set();
 list.forEach((entry,index)=>{
  if(!Number.isInteger(entry.version)||entry.version<1)persistenceFail(PERSISTENCE_CODES.MIGRATION,'Migration versions must be positive integers.');
  if(entry.version!==index+1)persistenceFail(PERSISTENCE_CODES.MIGRATION,`Migrations must be contiguous and ordered; found version ${entry.version} at position ${index+1}.`);
  if(versions.has(entry.version))persistenceFail(PERSISTENCE_CODES.MIGRATION,`Duplicate migration version ${entry.version}.`);
  versions.add(entry.version);
  if(typeof entry.name!=='string'||!entry.name.trim())persistenceFail(PERSISTENCE_CODES.MIGRATION,`Migration ${entry.version} has no name.`);
  if(!Array.isArray(entry.statements)||!entry.statements.length)persistenceFail(PERSISTENCE_CODES.MIGRATION,`Migration ${entry.version} has no statements.`);
  if(entry.statements.some(s=>typeof s!=='string'||!s.trim()))persistenceFail(PERSISTENCE_CODES.MIGRATION,`Migration ${entry.version} contains an empty statement.`);
  if(entry.down!==undefined||entry.rollback!==undefined)persistenceFail(PERSISTENCE_CODES.MIGRATION,`Migration ${entry.version} declares a reversal; migrations are forward-only.`);
  if(!/^[a-f0-9]{64}$/.test(entry.checksum||''))persistenceFail(PERSISTENCE_CODES.MIGRATION,`Migration ${entry.version} has no checksum.`);
 });
 return list;
}

/**
 * Compare the code's migrations against the rows already recorded in a
 * database. Returns the pending list, or throws — it never rewrites history.
 *
 * @param {Array<{version:number,name:string,checksum:string}>} applied
 */
export function planMigrations(applied=[],list=MIGRATIONS){
 validateMigrations(list);
 const rows=[...applied].sort((a,b)=>a.version-b.version);
 rows.forEach((row,index)=>{
  if(row.version!==index+1)persistenceFail(PERSISTENCE_CODES.MIGRATION,`The database records a non-contiguous migration history at version ${row.version}. Manual review is required; this software will not guess.`);
  const expected=list[index];
  if(!expected)persistenceFail(PERSISTENCE_CODES.MIGRATION,`The database is at schema version ${row.version}, ahead of this build's ${list.length}. Migrations are forward-only; deploy the matching build.`);
  if(row.checksum!==expected.checksum)persistenceFail(PERSISTENCE_CODES.MIGRATION,`Migration ${row.version} (${row.name}) was changed after it was applied. Applied checksum ${row.checksum}, source checksum ${expected.checksum}. Write a new forward migration instead of editing an applied one.`);
  if(row.name!==expected.name)persistenceFail(PERSISTENCE_CODES.MIGRATION,`Migration ${row.version} was renamed after it was applied.`);
 });
 return {currentVersion:rows.length,targetVersion:list.length,pending:list.slice(rows.length)};
}

/**
 * Apply pending migrations. Explicit by construction: a caller has to ask.
 * Each migration and its ledger row commit in one transaction, so a failure
 * part-way through a migration records nothing.
 */
export async function applyMigrations(session,{list=MIGRATIONS,dryRun=false}={}){
 if(!session||typeof session.query!=='function')persistenceFail(PERSISTENCE_CODES.MIGRATION,'A database session is required to migrate.');
 await session.query(MIGRATION_LEDGER_DDL);
 const {rows}=await session.query(`SELECT version, name, checksum FROM ${MIGRATION_LEDGER_TABLE} ORDER BY version`);
 const plan=planMigrations(rows,list);
 if(dryRun)return {...plan,applied:[],dryRun:true};
 const applied=[];
 for(const entry of plan.pending){
  await session.query('BEGIN');
  try{
   for(const statement of entry.statements)await session.query(statement);
   await session.query(`INSERT INTO ${MIGRATION_LEDGER_TABLE}(version,name,checksum) VALUES($1,$2,$3)`,[entry.version,entry.name,entry.checksum]);
   await session.query('COMMIT');
  }catch(e){
   await session.query('ROLLBACK').catch(()=>{});
   persistenceFail(PERSISTENCE_CODES.MIGRATION,`Migration ${entry.version} (${entry.name}) failed and was rolled back: ${e.message}`);
  }
  applied.push({version:entry.version,name:entry.name,checksum:entry.checksum});
 }
 return {...plan,applied,currentVersion:plan.targetVersion,dryRun:false};
}

export async function readSchemaVersion(session){
 const present=await session.query(`SELECT to_regclass('${MIGRATION_LEDGER_TABLE}') AS ledger`);
 if(!present.rows[0]?.ledger)persistenceFail(PERSISTENCE_CODES.MIGRATION,'This database has never been migrated. Run the explicit migration step; nothing migrates on connect.');
 const {rows}=await session.query(`SELECT version, name, checksum FROM ${MIGRATION_LEDGER_TABLE} ORDER BY version`);
 const plan=planMigrations(rows);
 if(plan.pending.length)persistenceFail(PERSISTENCE_CODES.MIGRATION,`This database is at schema version ${plan.currentVersion}; this build requires ${plan.targetVersion}. Run the explicit migration step before serving traffic.`);
 return plan.currentVersion;
}
