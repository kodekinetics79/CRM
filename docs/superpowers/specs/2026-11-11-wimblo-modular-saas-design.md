# Wimblo Modular SaaS Production Design

**Status:** Proposed for owner approval  
**Date:** 2026-11-11  
**Product direction:** Industry-neutral, multi-customer CRM with a full modular suite  
**Delivery rule:** Strict test-driven development (red, green, refactor)

## 1. Decision summary

Wimblo will become a generalized multi-tenant SaaS CRM. Every customer will receive a secure core CRM and can enable additional capability packs without exposing irrelevant terminology or workflows.

The existing public evaluator remains a synthetic, resettable demonstration environment. It will not be converted in place, connected to production data, or used as the production database. A separate production runtime, database, storage boundary, secrets set, domain, monitoring path and recovery process will be created.

The existing tested workflows are assets to preserve. The production program will introduce stable domain and persistence boundaries around them, then generalize or package them incrementally. It is not a visual rebrand and it is not a wholesale rewrite.

## 2. Goals

- Support multiple unrelated paying customers with strong organization-level isolation.
- Provide an industry-neutral core covering the complete customer lifecycle.
- Preserve useful existing capabilities as configurable modules rather than deleting them.
- Use durable PostgreSQL persistence and private object storage for real customer data.
- Enforce authorization on the server and data isolation at both application and database layers.
- Provide auditable administration, imports, exports, integrations, backups and recovery.
- Make every production change through strict TDD and keep the existing regression suite green.
- Keep the initial operating footprint economical without weakening data durability or security.
- Define verifiable release gates for design-partner, production and general-availability stages.

## 3. Non-goals

- No real customer data will be entered into the current evaluator.
- No claim of SOC 2, ISO 27001, HIPAA, PCI, FERPA or other certification will be made without the required external scope and evidence.
- No direct card data will be stored. Payment providers must host sensitive payment entry.
- No arbitrary customer-authored SQL or executable code will be supported.
- No industry-specific terminology will be forced on customers who have not enabled that module.
- No provider integration will be described as live until its production credentials, webhook lifecycle, failure handling and acceptance tests pass.
- No database migration will be declared complete from schema creation alone; parity, reconciliation, rollback and restore evidence are required.

## 4. Product model

### 4.1 Universal core

The core product is enabled for every organization:

- Organizations and people, including relationships, duplicate review and merge history.
- Leads, opportunities, configurable pipelines, stages, ownership and forecasts.
- Activities, notes, tasks, reminders, assignments and timelines.
- Products/services, proposals or commitments, and non-card transaction records where enabled.
- Documents, revisions, access scope, retention metadata and private downloads.
- Custom fields, tags, lists, saved views and controlled bulk actions.
- Dashboards, reports, scheduled report preparation and exports.
- CSV import with preview, validation, mapping, reconciliation and replay protection.
- Users, teams, roles, permissions, MFA, sessions and access lifecycle.
- Audit history, workspace settings, branding, locale, currency and time zone.
- API and webhook foundations with tenant-scoped credentials and idempotency.

### 4.2 Optional capability packs

Capability packs are enabled per tenant and controlled by entitlements. A disabled pack exposes neither navigation nor callable APIs.

- **Sales:** leads, opportunities, products, quotes, pipeline analytics and forecasts.
- **Marketing and communications:** audiences, consent, templates, campaigns, delivery events and provider connectors.
- **Service and operations:** cases, queues, SLAs, assignments, tasks and operational dashboards.
- **Events:** events, registrations, capacity, check-in, helpers, sponsorships and follow-up.
- **Membership:** plans, terms, renewals, status history and member engagement.
- **Fundraising:** gifts, pledges, campaigns, designations, receipts, recognition and peer fundraising.
- **Grants:** applications, funders, awards, milestones, documents and reconciliation.
- **Volunteer management:** opportunities, shifts, reservations, time records and volunteer portals.
- **Payments:** hosted provider checkout, payment/refund/dispute events and accounting references; no stored card data.
- **Intelligence:** bounded assistance and deterministic priorities under explicit tenant data policy.

Existing nonprofit capabilities map into Fundraising, Grants, Membership, Events and Volunteer packs. Their business rules remain intact unless a test-backed product decision changes them.

### 4.3 Configuration boundary

Labels, fields, pipelines, task types, currencies and enabled packs are configurable. Security rules, tenant isolation, audit retention, provider signature validation and protected lifecycle states are not customer-overridable.

Custom fields use typed definitions and validated values. They do not create arbitrary database columns or permit executable formulas. Calculated fields use a constrained expression catalog with bounded execution.

### 4.4 Canonical industry-neutral domain

The neutral core is built around a **Party** aggregate, distinct from login identities:

- `parties` contains the tenant-owned stable identity, lifecycle, display name and party type.
- `people` and `organizations` contain type-specific attributes in a one-to-one relationship with a party.
- `relationships` links two parties using a typed, dated and versioned relationship.
- `contact_points` stores typed email, phone and address channels with verification, preference and consent metadata.
- `leads` records acquisition and qualification state while referencing a party when identity is known.
- `opportunities` records a tenant-owned commercial or engagement pursuit, pipeline, stage, value, currency, probability, owner and close state.
- `activities`, `tasks`, `notes` and `documents` link through validated subject references rather than module-specific free text.
- `custom_field_definitions` and `custom_field_values` hold typed, tenant-scoped extension data. Values use constrained JSONB representations validated against immutable field type/version metadata.

Current `constituents` map to people or organizations; households and organization hierarchies map to typed relationships or groups. Current campaigns become Marketing or Fundraising pack records. Gifts, pledges, designations and receipts remain Fundraising records and never become generic opportunity revenue implicitly. Every conversion is explicit, versioned and reconciliation-tested.

### 4.5 Capability-pack lifecycle

The platform owns a versioned module catalog with module code, schema version, dependencies, permissions, navigation registration, API registration and data classification. Each tenant module has a lifecycle of `Provisioning`, `Active`, `Suspended`, `Retiring` or `Disabled` plus an entitlement version.

- Dependencies must be active before a module can be enabled and prevent unsafe disablement while dependants remain active.
- Enablement runs idempotent schema/configuration admission and does not make routes available until it succeeds.
- Suspension immediately denies writes and new background jobs while authorized administrators retain read/export access.
- Retirement provides reviewed export and retention choices; it does not silently delete records.
- Disabled modules are hidden from ordinary navigation and deny ordinary APIs, while retained records remain available only through explicitly authorized administration, export, legal-hold and recovery paths.
- Re-enablement resumes retained compatible data after version admission checks.
- Pack migrations are versioned, tenant-aware and resumable; failures leave the previous active version usable or the pack suspended with an operator-visible reason.

The design-partner release may enable an approved subset. “Full suite” at general availability means every pack advertised in section 4.2 has passed its module acceptance suite, security/isolation checks, data-lifecycle checks, operated recovery checks and provider acceptance where the pack depends on an external provider.

## 5. Architecture

### 5.1 Runtime separation

Four explicit environments are used:

1. **Local/test:** disposable data and isolated test providers.
2. **Synthetic evaluator:** the existing resettable demonstration deployment.
3. **Staging:** production-like infrastructure containing synthetic or approved test data only.
4. **Production:** separate secrets, database, object storage, origin, monitoring and backup policy.

An environment marker is included in runtime health metadata and audit events. Production startup fails closed if evaluator/demo flags, synthetic accounts, temporary storage or missing durability controls are detected.

### 5.2 Application structure

The initial production system remains a modular Node.js/Express application with a React frontend. This avoids premature distributed services while clear boundaries are introduced:

- **Platform control plane:** tenant provisioning, subscription/entitlement state, platform operators and platform audit.
- **Identity and access:** accounts, tenant memberships, roles, MFA, sessions and recovery lifecycle.
- **CRM core:** universal customer, pipeline, activity, task, document and report services.
- **Capability packs:** modules registered through explicit server and frontend contracts.
- **Integration adapters:** provider-specific implementations behind stable ports.
- **Persistence adapters:** asynchronous repositories and transactions independent of SQLite-specific APIs.
- **Background jobs:** durable job/outbox records claimed by bounded workers.

The system can remain one deployable codebase initially, but web and worker execution use separate supervised Node.js processes from the first production stage. Domain packages may not query each other's private tables directly. Shared behavior is exposed through tested service contracts.

### 5.3 Persistence

Production business data uses managed PostgreSQL. SQLite remains supported only for the evaluator, local fixtures and controlled migration-source tests.

PostgreSQL design rules:

- Every tenant-owned row has a non-null `tenant_id` and a stable UUID primary key.
- Foreign keys include or validate tenant ownership so cross-tenant references cannot be created.
- Row-level security is enabled for tenant-owned tables.
- Each request transaction sets a verified tenant context; repositories cannot operate without it.
- Platform tables are stored in a separate schema and are not visible to ordinary workspace connections.
- Money uses integer minor units plus ISO currency; dates and timestamps have explicit semantics.
- Mutable records use optimistic versions; important state transitions retain append-only history.
- Schema migrations are versioned, forward-tested and rehearsed against production-shaped copies.
- Connection pooling is bounded and observable.

The current synchronous SQLite access cannot be wrapped and called from the request thread as a production PostgreSQL solution. Repositories and transactions must become asynchronous, module by module, with contract tests proving equivalent behavior.

Existing work in `server/persistence/contract.js`, `migrations.js`, `roles.js`, the repository adapters and their tests is retained where its contracts and behavior pass the new architecture tests. The synchronous compatibility path in `syncPostgres.js` and `syncPostgresWorker.js` is explicitly prohibited from production startup because synchronous round trips can block request processing. It may remain temporarily as a test-only migration reference until every depended-on behavior has an asynchronous replacement and parity evidence, then it is removed through a test-backed change.

### 5.4 Object storage

Document bytes, large imports and generated exports use private encrypted object storage. PostgreSQL stores metadata, ownership, hash, scan status and version lineage.

- Objects are never public by default.
- Download authorization is rechecked before issuing a short-lived response.
- Uploads use size, type and content checks; active HTML/SVG content is not served inline.
- Object keys are generated by the server and namespaced by environment and tenant.
- Malware scanning and quarantine are explicit lifecycle states.
- Deleting a business record cannot silently orphan or erase retained evidence.

### 5.5 Jobs and integrations

Email, messaging, scheduled reports, provider synchronization, imports and webhook follow-up use durable jobs and an outbox pattern. The initial worker may run in the same deployment, but jobs survive restarts and support bounded retries, idempotency, dead-letter review and audit.

Provider adapters must implement common contracts for configuration validation, credential health, request idempotency, webhook signature verification, event ordering, retries, reconciliation and safe disablement.

Web requests and background jobs never execute in the same Node.js event loop. During the lowest-volume design-partner stage they may use separate bounded Node processes on the same compute instance if the platform provides independent process supervision and resource limits. General availability uses separately deployable web and worker process types. Jobs are claimed transactionally with leases; handlers checkpoint long work, observe per-tenant concurrency, apply backpressure and cannot hold a database transaction across provider calls.

Queue lag above 60 seconds for interactive jobs, sustained worker CPU above 70% for 15 minutes, web event-loop lag above 100 ms, or web p95 latency above 500 ms triggers capacity review and process/replica separation. These are initial engineering thresholds and are revised from measured service objectives rather than silently relaxed.

## 6. Tenant isolation and authorization

- Tenant selection comes from an authenticated membership, not from a slug or cookie alone.
- A user can belong to multiple tenants but receives a separate tenant-bound session context.
- Server authorization checks the tenant, role, module entitlement, record scope and action.
- Database row-level security provides a second isolation boundary.
- Platform operators cannot read tenant business data by default.
- Any future support access requires a time-limited, reasoned, customer-visible break-glass workflow with separate audit.
- Suspended tenants and users lose active sessions immediately; historical records remain retained.
- Module APIs deny access when the module is disabled even if a route is guessed directly.
- Exports, bulk actions, sensitive fields and integrations are distinct permissions.

Default roles are Owner, Administrator, Manager, Member, Viewer and Limited Helper. Tenants can create roles by combining approved permissions; they cannot create permissions outside the catalog.

### 6.1 Global identity and membership lifecycle

Authentication identities are global platform records; CRM people/parties are tenant business records and are never treated as login accounts automatically.

- A normalized verified email is unique per active global identity.
- Tenant access is represented by a versioned membership with tenant-specific display name, role set, status and invitation lineage.
- Invitations are tenant-scoped, single-use, expiring and bound to the invited email. Acceptance never reveals other tenant memberships.
- Joining another tenant adds a membership to the existing verified identity after fresh authentication; it does not merge tenant business records.
- MFA factors, recovery codes and primary credentials belong to the global identity. Tenant policy can require stronger recent-authentication rules but cannot weaken the platform production minimum.
- A session is bound to identity ID, tenant ID, membership version, identity security version and MFA state.
- Switching tenants issues or rotates into a newly tenant-bound session after rechecking that membership; changing role, membership, password, MFA, identity status or tenant status invalidates affected sessions.
- Removing the last owner requires a reviewed ownership transfer. Suspension retains audit and business history without preserving active access.
- Identity recovery uses an adopted human verification procedure, invalidates sessions and recovery challenges, and produces security audit visible to affected tenant owners.
- Platform operator identities use a separate administrative realm and cannot be tenant members through the same privileged session.

## 7. Authentication and application security

- Authentication uses server-managed opaque sessions in Secure, HttpOnly, deliberately scoped cookies.
- State-changing cookie-authenticated requests require CSRF protection and origin validation.
- Every interactive production user requires MFA, preserving the current production control. Tenant policy may require stronger approved factors or more frequent recent authentication but cannot disable the platform minimum. High-risk actions require recent authentication.
- Passwords use an approved adaptive hash and never appear in logs, exports or recovery archives.
- Login, MFA, recovery, public forms and webhooks have purpose-specific rate limits.
- Request bodies and query parameters have strict schemas and explicit limits.
- Security headers include a production CSP, frame protection, nosniff and a deliberate referrer policy.
- Reverse-proxy trust is restricted to the actual deployment topology rather than blindly trusting forwarded headers.
- Secrets stay server-side in the deployment secret store and are rotated independently by environment.
- Logs use structured redaction and do not contain passwords, cookies, tokens, private document bodies or provider secrets.
- Dependency installs are lockfile-reproducible; vulnerability findings are triaged before release.

## 8. Frontend design

The React application uses a capability catalog returned after authentication. Navigation, routes and actions are generated from authorized enabled capabilities, while the server remains the enforcement boundary.

The shell provides:

- Organization switcher for users with multiple memberships.
- Universal search constrained to the active tenant and permissions.
- Configurable dashboards and pipeline views.
- Consistent list, detail, activity, task, document and reporting patterns.
- Clear empty, loading, error, stale-write and permission states.
- Accessible keyboard, focus, contrast and responsive behavior.
- Visible environment marker outside production and irreversible-action confirmation.

User strings render through ordinary React escaping. Raw HTML is avoided; rich content, if later required, uses centralized allowlist sanitization and CSP hardening. Authentication tokens are not stored in browser storage.

## 9. TDD delivery contract

The implementation follows the iron rule: no new production behavior without a test that was first observed failing for the intended reason.

For every behavior:

1. **Red:** write one minimal test describing a customer-visible or security-relevant outcome.
2. Run it and record that it fails because the behavior is absent or incorrect, not because of test setup.
3. **Green:** implement only enough production code to pass.
4. Run the focused test and the affected module suite.
5. **Refactor:** improve structure without adding behavior.
6. Run the full regression suite before the change is considered complete.

Test layers:

- **Characterization tests:** preserve valuable current behavior before extracting boundaries.
- **Domain tests:** rules, transitions, calculations and permission decisions.
- **Repository contract tests:** the same observable contract against SQLite fixtures and PostgreSQL during migration.
- **PostgreSQL integration tests:** real transactions, constraints, RLS, concurrency and migrations against an ephemeral test database.
- **HTTP contract tests:** schemas, authentication, authorization, CSRF, idempotency and safe errors.
- **React behavior tests:** real rendered components and user outcomes, avoiding assertions on mocks.
- **End-to-end journeys:** critical workflows through the built application.
- **Migration tests:** source fixtures, counts, digests, rejected rows, reconciliation and replay.
- **Security tests:** tenant-crossing attempts, direct-route authorization, malicious files/URLs, session revocation and webhook forgery.
- **Recovery tests:** backup creation, independent readback, new-environment restore and reconciliation.

Mocks are limited to genuinely external or slow boundaries. Provider fixtures mirror real documented structures, while tests assert Wimblo's observable outcome rather than mock call existence.

TDD evidence is enforced rather than assumed:

- Each implementation slice records the focused test command and expected RED failure before production code changes.
- CI rejects focused tests, `.only`, unexpected skips and a non-zero skipped-test count unless a time-bounded quarantine is separately approved and tracked.
- The focused test, affected module suite, complete suite, production build and dependency audit must pass before merge.
- This repository's production migrations remain forward-only. Every schema change uses expand/contract stages with fresh-install and prior-version upgrade tests, old-version compatibility, reconciliation and a tested compensating forward migration where reversal is required; destructive pretend rollback is prohibited.
- Tenant isolation, authorization and money calculations receive targeted mutation checks; a realistic wrong tenant predicate, permission branch or amount operation must be caught by at least one test.
- Tests use isolated tenant fixtures and include cross-tenant negative cases for reads, writes, search, exports, jobs, documents and provider callbacks.

## 10. Migration and compatibility strategy

The transition uses a strangler pattern rather than a flag-day rewrite:

1. Freeze current evaluator behavior with characterization tests.
2. Define asynchronous repository and transaction contracts around one bounded module.
3. Make its contract tests fail against the new PostgreSQL adapter.
4. Implement the smallest PostgreSQL behavior until parity tests pass.
5. Migrate tenant, identity, authorization and audit foundations first.
6. Move universal CRM modules, then optional capability packs.
7. Keep legacy routes behind compatibility adapters only while tested consumers remain.
8. Remove a compatibility path only after migrated API and UI journeys pass.

Production customer migration is a separate reviewed workflow: discovery, mapping, dry run, exception review, approved cutover, reconciliation and signed acceptance. It does not reuse evaluator data.

## 11. Operations, recovery and observability

Production readiness requires operated evidence, not only code:

- Health, readiness and dependency checks that do not expose secrets.
- Structured application, security, job and provider metrics.
- Alerting for elevated errors, authentication abuse, queue backlog, webhook failures, backup failures and database capacity.
- Encrypted automated database backups with point-in-time recovery where supported.
- Versioned off-host object-storage recovery and separately held keys.
- Scheduled readback plus timed restore drills into a new environment.
- Defined RPO, RTO, retention, incident ownership and customer notification process.
- Deployment rollback and forward-fix procedures.
- Support runbooks, customer status communication and audit-preserving incident response.

### 11.1 Customer data lifecycle

Tenant lifecycle states include `Active`, `Suspended`, `ExportPending`, `DeletionScheduled`, `LegalHold` and `Closed`. Offboarding produces a versioned full export containing business records, attachments, schema/version metadata and integrity manifests before deletion can proceed.

- Retention schedules are recorded by data class and jurisdiction; legal hold overrides ordinary deletion and is separately audited.
- Deletion is a reviewed, delayed operation that removes active database rows, search projections, queued work, provider credentials and object versions, then records non-sensitive completion evidence.
- Backup expiry follows the published retention schedule; completion is not claimed while recoverable copies remain inside their approved retention window.
- Tenant envelope-encryption keys and platform keys rotate independently. Cryptographic destruction is used only after all legal, contractual and backup-retention conditions are satisfied.
- Region/residency changes use a copy, integrity verification, controlled cutover and source-retirement workflow; a tenant is never relabelled into another region without moving and verifying its data.
- Anonymization is used only where business/legal requirements permit it and relationship/history invariants remain valid.
- Tenant closure, export, retention and deletion behavior is tested in both ordinary and legal-hold cases before general availability.

## 12. Cost-control design

The economical starting topology is one production codebase deployed as separately supervised web and worker processes, one managed PostgreSQL database and one private object-storage account. The two processes may share a cost-controlled compute instance during the design-partner stage only when independent resource limits and monitoring are available. It intentionally avoids per-tenant infrastructure, Kubernetes and Redis until measured load justifies them.

Cost controls include bounded connection pools, upload/export limits, job concurrency, per-tenant quotas, provider budgets, log retention tiers and explicit preview-deployment policies. Infrastructure is not downgraded below durable-storage, backup, TLS or monitoring requirements. Subscription billing and usage limits must be explicit product behavior rather than plan labels only.

## 13. Release gates

### Design-partner gate

- Separate staging and production environments exist.
- PostgreSQL isolation, RLS and cross-tenant negative tests pass.
- Core CRM journeys and enabled packs pass their full suites.
- Production admin/MFA, session revocation and recovery lifecycle are exercised.
- Backup readback and timed new-environment restore pass.
- Monitoring and incident routing are active.
- Customer migration is reconciled and accepted.
- No critical/high unresolved security finding applies to the release scope.

### General-availability gate

- Multiple independent tenant journeys and load profile pass.
- Billing/entitlement lifecycle and failed-payment handling are operational.
- Provider integrations have production acceptance and reconciliation evidence.
- Support, status communication, retention, deletion and incident procedures are adopted.
- Recovery drills and operational objectives have repeated evidence.
- Legal terms, privacy disclosures and applicable compliance scope are approved.

## 14. Initial delivery order

The implementation plan should decompose the design into small TDD slices in this dependency order:

1. Baseline characterization and architecture seams.
2. PostgreSQL tenancy, memberships, sessions, RLS and audit.
3. Module/entitlement catalog and production-safe application shell.
4. Universal organizations, people, activities, tasks and documents.
5. Leads, opportunities, pipelines, reports, imports and exports.
6. Existing specialized features converted into optional packs.
7. Durable jobs and selected provider integrations.
8. Recovery, observability, billing, operations and production acceptance.

Each slice must leave the repository releasable and the evaluator regression suite intact. A slice is not complete merely because its code is merged; local verification, CI, deployment, production observation and customer acceptance remain separate statuses.

## 15. Approval assumptions

Approval of this design means:

- Wimblo is a multi-tenant, industry-neutral modular SaaS product.
- The public evaluator remains synthetic and separate.
- Managed PostgreSQL and private object storage are mandatory for real customer data.
- Existing specialized workflows become optional capability packs.
- Strict red-green-refactor TDD applies to all implementation and bug fixes.
- Implementation will proceed through a separate detailed plan after this design is approved.

