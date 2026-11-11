# Wimblo Production CRM Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first complete industry-neutral production CRM slice on the certified Wimblo SaaS foundation, then certify and promote it without adding unapproved cost.

**Architecture:** Keep the evaluator runtime isolated. Add typed PostgreSQL CRM tables under the tenant application boundary, asynchronous repositories/services, strict Express routes, and a capability-driven React production shell. Web and worker remain separate processes; every tenant-owned table uses composite tenant keys, forced RLS, optimistic versions, and append-only transition evidence.

**Tech Stack:** Node.js 24, Express 5, PostgreSQL 17, React 19, Vite 6, Zod 4, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-11-wimblo-modular-saas-design.md`

## Global Constraints

- Strict RED-GREEN-REFACTOR: no production behavior before a test is observed failing for the intended reason.
- Migrations 1-12 are immutable; append only forward migrations with checksum and upgrade coverage.
- Every tenant-owned row has a non-null `tenant_id`, stable UUID, composite tenant foreign keys, forced RLS, and no control-plane access.
- Production business data uses typed PostgreSQL tables; the evaluator's generic SQLite/records runtime remains separate.
- Money uses integer minor units plus uppercase ISO currency; no card data is stored.
- Mutable records use optimistic versions; important state transitions append immutable history.
- Server authorization is authoritative; React never stores authentication tokens in browser storage or renders raw HTML.
- Private object storage holds bytes; PostgreSQL holds only metadata and validated links.
- No paid Git feature, hosting upgrade, provider activation, or external data transfer may be introduced. Promotion may use only existing no-new-cost capacity.
- Status must distinguish implemented, locally verified, CI, merged, deployed, production-observed, UAT, and accepted.

## Review Focus

- Cross-tenant parent and child identifiers must fail at the database boundary, even with forged tenant context.
- Concurrent default-pipeline, conversion, ownership, stage, and import operations must preserve uniqueness and history.
- Disabled/suspended core capability, tenant, membership, or session state must deny direct API access.
- Stale versions must never partially update a record or append misleading history.
- Export/import and evaluation fixtures must never leak secrets, raw private bytes, or claim production acceptance.

---

### Task 1: Canonical Party, Person, Organization, Contact and Relationship Core

**Files:**
- Modify: `server/persistence/migrations.js`
- Modify: `server/persistence/roles.js`
- Create: `server/production/crmRepository.js`
- Create: `server/production/crmService.js`
- Create: `server/production/crmRoutes.js`
- Modify: `server/production/app.js`
- Test: `tests/production-crm-migrations.test.js`
- Test: `tests/production-crm-parties.test.js`
- Test: `tests/production-crm-http.test.js`
- Modify: `scripts/postgres-foundation-verify.mjs`

**Interfaces:**
- Consumes: authenticated tenant session, tenant pool transactions, module authorization, persistence errors.
- Produces: `createCrmRepository`, `createCrmService`, `installCrmRoutes`; party/contact/relationship DTOs with UUIDs and optimistic versions.

- [ ] **Step 1: Write failing migration and PostgreSQL tests** for forward migration 13, typed party subtype invariants, normalized contact uniqueness, composite tenant foreign keys, relationship self-link refusal, forced RLS, least-privilege grants, and forged-tenant/control-role denial.
- [ ] **Step 2: Run tests and record the expected RED failures** because CRM tables and grants do not exist.
- [ ] **Step 3: Append migration 13 and role grants** with lean indexes for tenant/name lookup, normalized contact lookup, party contacts, and relationship direction; preserve migrations 1-12 byte-for-byte.
- [ ] **Step 4: Write failing repository/service/HTTP tests** for person and organization creation, duplicate contact conflict, relationship creation, list/detail reads, viewer read-only access, staff writes, CSRF, module state, stale versions, and safe errors.
- [ ] **Step 5: Implement repository, service and routes minimally** using asynchronous tenant transactions and Zod-bounded request schemas.
- [ ] **Step 6: Run focused tests, production-foundation tests, build and mutation checks** for wrong tenant predicates and missing version clauses.
- [ ] **Step 7: Commit** `feat: add canonical production CRM parties`.

### Task 2: Leads, Opportunities, Pipelines and Forecast Facts

**Files:**
- Modify: `server/persistence/migrations.js`
- Modify: `server/persistence/roles.js`
- Modify: `server/production/crmRepository.js`
- Modify: `server/production/crmService.js`
- Modify: `server/production/crmRoutes.js`
- Test: `tests/production-crm-sales.test.js`
- Test: `tests/production-crm-sales-http.test.js`
- Modify: `scripts/postgres-foundation-verify.mjs`

**Interfaces:**
- Consumes: party IDs and tenant session from Task 1.
- Produces: pipelines/stages, leads, opportunities, atomic lead conversion and stage history.

- [ ] **Step 1: Write failing migration and domain tests** for migration 14, one default pipeline, ordered open/won/lost stages, exact minor-unit currency, bounded probability, tenant-safe stage references, and append-only stage events.
- [ ] **Step 2: Verify RED** for absent tables and behavior.
- [ ] **Step 3: Implement migration 14 and indexes** for stage views, owner/status worklists, expected-close forecasts and lead qualification.
- [ ] **Step 4: Write failing service/HTTP tests** for pipeline setup, lead creation, atomic lead conversion, opportunity stage change, stale version rollback, direct-route authorization and concurrent default creation.
- [ ] **Step 5: Implement minimal sales repository/service/routes** so state change and history append share one transaction.
- [ ] **Step 6: Verify focused suites and realistic mutations** for wrong amount, wrong tenant and missing history append.
- [ ] **Step 7: Commit** `feat: add production CRM pipelines and opportunities`.

### Task 3: Activities, Tasks, Notes, Attachments and Unified Timeline

**Files:**
- Modify: `server/persistence/migrations.js`
- Modify: `server/persistence/roles.js`
- Modify: `server/production/crmRepository.js`
- Modify: `server/production/crmService.js`
- Modify: `server/production/crmRoutes.js`
- Modify: `server/production/jobRepository.js`
- Test: `tests/production-crm-work.test.js`
- Test: `tests/production-crm-timeline.test.js`
- Modify: `scripts/postgres-foundation-verify.mjs`

**Interfaces:**
- Consumes: canonical CRM subject IDs and durable jobs.
- Produces: immutable activities, versioned tasks/notes, object-metadata attachments, ownership history and cursor timeline.

- [ ] **Step 1: Write failing migration tests** for migration 15, subject registry/link integrity, task completion timestamp consistency, object revision link validation, one active owner, append-only events, forced RLS and bounded indexes.
- [ ] **Step 2: Verify RED** before schema code.
- [ ] **Step 3: Implement migration 15 and `enqueueInTransaction`** so reminder jobs commit atomically with tasks.
- [ ] **Step 4: Write failing behavior tests** for activity creation, task lifecycle, note revision, attachment metadata linking, ownership change, timeline order/cursor, stale writes, retention and cross-tenant denial.
- [ ] **Step 5: Implement minimal work/timeline behavior** without storing file bytes or duplicate audit payloads.
- [ ] **Step 6: Verify focused suites, PostgreSQL concurrency and mutation checks**.
- [ ] **Step 7: Commit** `feat: add production CRM work timeline`.

### Task 4: Dashboards, Reports and Governed Import/Export

**Files:**
- Modify: `server/persistence/migrations.js`
- Modify: `server/persistence/roles.js`
- Create: `server/production/crmReportingService.js`
- Create: `server/production/crmImportService.js`
- Modify: `server/production/crmRoutes.js`
- Test: `tests/production-crm-reporting.test.js`
- Test: `tests/production-crm-import.test.js`
- Test: `tests/production-crm-export.test.js`

**Interfaces:**
- Consumes: typed CRM tables from Tasks 1-3.
- Produces: bounded dashboard metrics, saved report definitions, preview-first CSV import, replay-safe source mappings and formula-safe exports.

- [ ] **Step 1: Write failing migration and service tests** for migration 16, saved views/reports, import batches/source mappings, idempotency, reconciliation counts, row/byte caps and no raw SQL.
- [ ] **Step 2: Verify RED** for absent behavior.
- [ ] **Step 3: Implement lean reporting/import schema and query paths**; retain definitions rather than materializing duplicate business ledgers.
- [ ] **Step 4: Write failing HTTP tests** for authorized dashboards, report execution, complete formula-safe CSV export, import preview/commit/replay, stale-source refusal and tenant isolation.
- [ ] **Step 5: Implement minimal services/routes** with strict schemas and bounded acquisition.
- [ ] **Step 6: Verify focused suites, scale fixtures and full regression**.
- [ ] **Step 7: Commit** `feat: add governed CRM reporting and imports`.

### Task 5: Capability-Driven Production UI and Synthetic Client Evaluation

**Files:**
- Create: `src/production/ProductionApp.jsx`
- Create: `src/production/productionApi.js`
- Create: `src/production/CrmWorkspace.jsx`
- Create: `src/production/PipelineBoard.jsx`
- Create: `src/production/RecordTimeline.jsx`
- Create: `src/production/ReportsWorkspace.jsx`
- Create: `src/production/production.css`
- Modify: `src/main.jsx`
- Test: `tests/production-crm-ui.test.js`
- Test: `tests/production-crm-evaluation.test.js`

**Interfaces:**
- Consumes: production CRM HTTP APIs and authorized capability catalog.
- Produces: accessible responsive shell, party/work/pipeline/report journeys and explicitly synthetic evaluator fixtures.

- [ ] **Step 1: Write failing rendered-behavior tests** for capability navigation, organization switch, search, loading/empty/error/conflict/permission states, keyboard access, labels, 44px targets, responsive restructuring and escaped user content.
- [ ] **Step 2: Verify RED** before UI code.
- [ ] **Step 3: Implement the production shell and core journeys** with ordinary React escaping, no raw HTML and no browser-stored auth token.
- [ ] **Step 4: Write failing evaluation tests** proving sample data is synthetic, resettable and isolated from production configuration.
- [ ] **Step 5: Implement synthetic evaluation seeding/entry selection** without changing the existing evaluator contract.
- [ ] **Step 6: Run UI behavior tests, browser smoke tests and production build**; preserve the evaluator regression suite.
- [ ] **Step 7: Commit** `feat: add production CRM workspace UI`.

### Task 6: Security, Capacity, Recovery and Operational Certification

**Files:**
- Create: `scripts/crm-production-certify.mjs`
- Create: `tests/production-crm-security.test.js`
- Create: `tests/production-crm-capacity.test.js`
- Create: `tests/production-crm-recovery.test.js`
- Create: `docs/operations/WIMBLO-CRM-RUNBOOK.md`
- Modify: `PRODUCTION-FOUNDATION-HANDOVER.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: complete CRM suite and existing readiness contract.
- Produces: deterministic certification command and honest operational handover.

- [ ] **Step 1: Write failing certification tests** for tenant crossing, direct-route authorization, request limits, session revocation, malicious CSV/formula content, attachment metadata abuse, concurrency, query budgets, backup/readback/restore reconciliation and redacted output.
- [ ] **Step 2: Verify RED** before certification code.
- [ ] **Step 3: Implement certification orchestration and runbook** without embedding secrets or claiming provider evidence that was not observed.
- [ ] **Step 4: Run real disposable-PostgreSQL two-tenant verification, load profile, recovery rehearsal, full tests, build, audit and TDD discipline**.
- [ ] **Step 5: Obtain independent whole-branch security, logic and database review; fix every Critical/Important finding TDD-first**.
- [ ] **Step 6: Update handover state precisely** for implemented/local/CI/deployed/UAT/accepted boundaries.
- [ ] **Step 7: Commit** `test: certify production CRM suite`.

### Task 7: Cost-Safe Integration, CI and Deployment Promotion

**Files:**
- Modify only when verified necessary: deployment manifests, environment documentation and readiness metadata.
- Test: existing production readiness and browser/client journeys.

**Interfaces:**
- Consumes: certified branch and provider state.
- Produces: exact-SHA CI/deployment evidence when possible without new cost; otherwise an explicit blocked operational handoff.

- [ ] **Step 1: Inspect exact local/remote SHA, remote protections, Vercel project, Render service/plan, persistent storage, database, secrets and build/deploy settings read-only.**
- [ ] **Step 2: Push the reviewed feature branch and create a PR only through ordinary existing Git hosting; do not enable paid checks or features.**
- [ ] **Step 3: Require green CI for the exact head SHA, then merge only if protections and checks are satisfied.**
- [ ] **Step 4: Promote backend/web/worker and frontend only on existing no-new-cost capacity; refuse any upgrade or billable activation.**
- [ ] **Step 5: Verify exact deployed SHA, migrations, `/health`, `/ready`, process evidence, persistent restart, backup/readback/restore, and authenticated synthetic client journey.**
- [ ] **Step 6: Record production observation separately from customer UAT and acceptance.**
- [ ] **Step 7: If any provider requires payment, credentials, owner-controlled billing, or unsupported production durability, stop only that external action and leave a precise no-cost handoff.**

