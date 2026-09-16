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
 )
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
