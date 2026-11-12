# Wimblo Production Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the independently deployable, PostgreSQL-backed identity, tenant-isolation, module-entitlement and durable-job foundation for Wimblo's industry-neutral multi-customer SaaS without changing the synthetic evaluator.

**Architecture:** Preserve the current React/Express evaluator and its SQLite regression suite while adding a separate production SaaS composition. Two least-privilege PostgreSQL pools separate the global control-plane identity schema from tenant-scoped business access; web and worker run as separate supervised processes from the same codebase. Existing PostgreSQL migrations, pooling, RLS and repository contracts are reused, while `syncPostgres.js` and `syncPostgresWorker.js` are prohibited from the SaaS runtime.

**Tech Stack:** Node.js 24 ESM, Express 5.3, React 19, Zod 4, PostgreSQL through `pg` 8, Node built-in test runner, Helmet 8, existing Wimblo TOTP/AES-256-GCM primitives.

**Spec:** `docs/superpowers/specs/2026-11-11-wimblo-modular-saas-design.md`

## Global Constraints

- No production code is written until its focused test has been observed failing for the expected missing-behavior reason.
- Run the focused test, affected suite and complete `npm test` after every green/refactor cycle; the current 1,474-test evaluator baseline must remain green.
- The public evaluator, its Render service, its Vercel route and its resettable SQLite data remain unchanged throughout this plan.
- Real customer data is forbidden until all design-partner release gates in the spec have passed.
- Every interactive production user requires MFA; tenant configuration cannot weaken this minimum.
- Production tenant data uses PostgreSQL with forced RLS and an explicit transaction-scoped tenant UUID.
- Control-plane and tenant-data connections use different NOSUPERUSER/NOBYPASSRLS roles; runtime connections never use the migration owner.
- `syncPostgres.js` and `syncPostgresWorker.js` are never imported by the production SaaS web or worker entrypoints.
- Web and worker execute in separate supervised Node.js processes and never share one event loop.
- Cookies are Secure, HttpOnly and deliberately scoped; cookie-authenticated writes require CSRF and exact-origin checks.
- Secrets stay server-side, never enter client bundles, logs, fixtures, commits or returned runtime metadata.
- No cloud resource, paid plan, domain, provider account or deployment is created by this plan; deployment spending requires a separately reviewed operations plan.
- Migrations are forward-only in this repository. Use expand/contract migrations, prior-version compatibility tests and compensating forward migrations rather than destructive down execution.

## Program Decomposition

This is plan 1 of the approved production program. It ends with a secure empty SaaS workspace foundation, not a completed CRM.

1. **This plan:** identity, memberships, MFA, tenant sessions, PostgreSQL isolation, module lifecycle, durable jobs and production composition.
2. **Follow-on plan:** canonical Party/Person/Organization, relationships, contacts, activities, tasks, documents, custom fields and search.
3. **Follow-on plan:** leads, opportunities, pipelines, reports, imports/exports and configurable dashboards.
4. **Follow-on plan:** convert existing fundraising, grants, membership, events and volunteer behavior into optional packs.
5. **Follow-on plan:** provider integrations, billing, recovery operations, observability, migration acceptance and general availability.

## File Structure

- `server/production/runtimeConfig.js`: validates the explicit SaaS web/worker runtime and fail-closed production requirements.
- `server/production/controlRepository.js`: asynchronous global identity, membership, invitation, session and control-audit persistence.
- `server/production/identityService.js`: normalized global identities, invitation acceptance and membership lifecycle.
- `server/production/mfaService.js`: asynchronous global-identity MFA lifecycle using existing tested TOTP/encryption primitives.
- `server/production/sessionService.js`: opaque identity and tenant-bound sessions, CSRF tokens and version rechecks.
- `server/production/moduleService.js`: module catalog, dependencies and tenant module lifecycle.
- `server/production/jobRepository.js`: durable transactional outbox/lease behavior.
- `server/production/app.js`: Express web composition and secure HTTP boundary.
- `server/production/worker.js`: separate bounded job process.
- `server/production/web.js`: production web process entrypoint.
- `server/persistence/migrations.js`: forward schema versions for control plane, tenant lifecycle, modules and jobs.
- `server/persistence/roles.js`: separate tenant and control-plane grants plus runtime role assertions.
- `scripts/tdd-gate.mjs`: executable focused/skipped-test discipline check.
- `scripts/postgres-foundation-verify.mjs`: real-PostgreSQL migration, RLS, role and concurrency verification.
- `tests/production-*.test.js`: behavior tests for each new production boundary.

## Review Focus

- One verified email invited to two tenants must create one global identity, two isolated memberships and no CRM-record merge; Task 5 owns this test.
- A role, membership, tenant, password or MFA change must invalidate every stale affected session before another business request succeeds; Task 7 owns this test.
- A missing or forged tenant context must fail closed under PostgreSQL RLS for reads, writes, search, exports and jobs; Tasks 3 and 11 own these tests.
- Failed module enablement must not expose routes or leave ambiguous entitlement state; Task 8 owns this test.
- An expired/reclaimed worker lease must produce one idempotent business effect, never two; Task 9 owns this test.

---

### Task 1: Enforce TDD Test Discipline Without Changing Runtime Behavior

**Files:**
- Create: `scripts/tdd-gate.mjs`
- Create: `tests/tdd-gate.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `findTestDisciplineViolations({root, files?}) -> Promise<{focused:string[], skipped:string[]}>`
- Produces: `npm run test:discipline`, exiting non-zero when committed tests contain `.only`, `test.skip`, `describe.skip`, `it.skip` or `{ skip: true }`.

- [ ] **Step 1: Write the failing scanner behavior test**

  Add `production test discipline reports focused and skipped tests with file and line` using a temporary fixture tree. Assert that ordinary `test(...)` returns empty lists and each forbidden form returns its fixture path and line.

- [ ] **Step 2: Run the focused test and verify RED**

  Run: `node --test tests/tdd-gate.test.js`

  Expected: FAIL because `scripts/tdd-gate.mjs` does not exist.

- [ ] **Step 3: Implement the smallest executable scanner**

  Export `findTestDisciplineViolations({root, files})` and provide a CLI path that scans `tests/**/*.test.js`. Use a small lexical state machine to ignore string literals, template literals and comments while detecting executable test modifiers; report malformed/unclosed input rather than silently accepting it.

- [ ] **Step 4: Add the package command and verify GREEN**

  Add `"test:discipline": "node scripts/tdd-gate.mjs"`.

  Run: `node --test tests/tdd-gate.test.js && npm run test:discipline`

  Expected: PASS and `0 focused, 0 skipped`.

- [ ] **Step 5: Run the complete baseline**

  Run: `npm test && npm run build && npm audit --audit-level=high`

  Expected: 1,474 tests pass, build passes, audit reports zero high/critical findings.

- [ ] **Step 6: Commit**

  ```bash
  git add scripts/tdd-gate.mjs tests/tdd-gate.test.js package.json
  git commit -m "test: enforce production TDD discipline"
  ```

### Task 2: Add an Explicit Fail-Closed SaaS Runtime Profile

**Files:**
- Create: `server/production/runtimeConfig.js`
- Create: `tests/production-runtime-config.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `resolveSaasRuntimeConfig(env, root) -> {processRole, appOrigin, tenantDatabaseUrl, controlDatabaseUrl, cookieName, objectStorage, limits}`.
- Produces: scripts `start:saas:web` and `start:saas:worker`; their entrypoints are created in Task 10.

- [ ] **Step 1: Write failing configuration tests**

  Add tests named:

  - `SaaS production requires web or worker process role and exact HTTPS origin`.
  - `SaaS production requires distinct tenant and control database URLs with TLS`.
  - `SaaS production rejects evaluator demo temporary storage and sync-postgres driver flags`.
  - `resolved metadata never exposes database URLs keys or secret values`.

  Use literal environment objects; assert exact refusal messages for one missing requirement at a time.

- [ ] **Step 2: Run the focused tests and verify RED**

  Run: `node --test tests/production-runtime-config.test.js`

  Expected: FAIL because `resolveSaasRuntimeConfig` is missing.

- [ ] **Step 3: Implement `resolveSaasRuntimeConfig(env, root)`**

  Require `NODE_ENV=production`, `WIMBLO_RUNTIME=saas`, `PROCESS_ROLE=web|worker`, exact HTTPS `APP_ORIGIN`, `DATABASE_URL`, `CONTROL_DATABASE_URL`, server-only 32-byte MFA key, session secret, backup key, private object-storage configuration and bounded numeric limits. Reject identical role credentials by comparing parsed PostgreSQL usernames. Return a separate `publicMetadata()` closure containing no secret-bearing values.

- [ ] **Step 4: Verify focused and runtime suites GREEN**

  Run: `node --test tests/production-runtime-config.test.js tests/runtime-config.test.js tests/client-evaluation-runtime.test.js`

  Expected: PASS with evaluator behavior unchanged.

- [ ] **Step 5: Commit**

  ```bash
  git add server/production/runtimeConfig.js tests/production-runtime-config.test.js package.json
  git commit -m "feat: define fail-closed SaaS runtime"
  ```

### Task 3: Expand PostgreSQL Schema and Least-Privilege Roles

**Files:**
- Modify: `server/persistence/migrations.js`
- Modify: `server/persistence/roles.js`
- Modify: `server/persistence/pool.js`
- Create: `scripts/postgres-foundation-verify.mjs`
- Create: `tests/production-foundation-migrations.test.js`
- Modify: `package.json`

**Interfaces:**
- Extends: `MIGRATIONS` with contiguous forward-only versions 6 through 9.
- Produces: `controlPlaneRoleGrants(role) -> string[]` and `assertControlPlaneRole(session) -> Promise<RoleEvidence>`.
- Produces: `controlPoolFromEnv(env)` alongside existing tenant `poolFromEnv(env)`.

- [ ] **Step 1: Write failing migration-planning tests**

  Assert versions remain contiguous; old checksums 1–5 remain unchanged; versions 6–9 are planned from a version-5 ledger; a failed new migration records no ledger row; and an ahead/edited database still refuses startup.

- [ ] **Step 2: Run the migration test and verify RED**

  Run: `node --test tests/production-foundation-migrations.test.js`

  Expected: FAIL because schema version 9 and the control-plane role boundary do not exist.

- [ ] **Step 3: Add forward-only expand migrations**

  Add these exact responsibilities:

  - Version 6: `wimblo_platform` schema with global identities, memberships, invitations, opaque sessions, MFA settings/recovery/challenges and append-only control audit.
  - Version 7: module catalog, tenant modules, module events and forced RLS on every tenant-module row.
  - Version 8: durable jobs, attempts and dead-letter state with forced RLS and unique tenant/idempotency constraints.
  - Version 9: expanded tenant lifecycle (`active`, `suspended`, `export_pending`, `deletion_scheduled`, `legal_hold`, `closed`) plus retention and lifecycle-version columns using an expand/validate/replace constraint sequence.

- [ ] **Step 4: Add role grants and pool separation**

  Extend tenant grants for new tenant tables. Add a control-plane role that can use only `wimblo_platform` tables/functions required by the repository and cannot read tenant business tables. `controlPoolFromEnv` consumes `CONTROL_DATABASE_URL` and applies the same TLS/timeouts/circuit behavior as the existing pool.

- [ ] **Step 5: Write the real-PostgreSQL verification script**

  `scripts/postgres-foundation-verify.mjs` must create isolated schema state through explicit admin migration, connect through separate tenant/control roles, prove role privileges and forced RLS, run two-tenant negative reads/writes, prove a missing tenant GUC fails, and remove only its uniquely named test data.

- [ ] **Step 6: Run unit and real database verification**

  Run: `node --test tests/production-foundation-migrations.test.js tests/persistence-migrations.test.js`

  Expected: PASS.

  Run with an explicitly disposable PostgreSQL database: `npm run verify:postgres-foundation`

  Expected: PASS with evidence for versions 6–9, two distinct runtime roles, forced RLS and cross-tenant denial. If no disposable PostgreSQL target is available, stop this task before commit; do not mark it green or add a skipped test.

- [ ] **Step 7: Commit**

  ```bash
  git add server/persistence/migrations.js server/persistence/roles.js server/persistence/pool.js scripts/postgres-foundation-verify.mjs tests/production-foundation-migrations.test.js package.json
  git commit -m "feat: add isolated SaaS foundation schema"
  ```

### Task 4: Implement the Asynchronous Control-Plane Repository

**Files:**
- Create: `server/production/controlRepository.js`
- Create: `tests/production-control-repository.test.js`
- Modify: `scripts/postgres-foundation-verify.mjs`

**Interfaces:**
- Produces: `createControlRepository({pool, clock})`.
- Produces methods: `createIdentity`, `findIdentityByEmail`, `getIdentity`, `createMembership`, `getMembership`, `listMemberships`, `changeMembership`, `createInvitation`, `consumeInvitation`, `revokeInvitation`, `putMfaState`, `createSession`, `getSession`, `revokeSessions`, `appendAudit`.
- All methods return Promises and accept/return plain objects with explicit `version` or `securityVersion` fields.

- [ ] **Step 1: Write the failing repository contract tests**

  Define one behavior per test: normalized case-insensitive email uniqueness; immutable identity UUID; separate memberships for the same identity; version-conflict refusal; invitation token hash only; append-only audit; session lookup by SHA-256 token hash; and transaction rollback when membership creation fails.

- [ ] **Step 2: Run focused tests and verify RED**

  Run: `node --test tests/production-control-repository.test.js`

  Expected: FAIL because the repository does not exist.

- [ ] **Step 3: Implement `createControlRepository({pool, clock})`**

  Use only parameterized PostgreSQL statements. Normalize email once at the boundary, never store invitation/session plaintext tokens, use optimistic `WHERE version = $expected`, and append control audit in the same transaction as each security-sensitive mutation.

- [ ] **Step 4: Add real PostgreSQL contract execution**

  Extend `postgres-foundation-verify.mjs` to execute the repository contract against a disposable control schema and to prove the tenant application role receives permission denied for `wimblo_platform.global_identities`.

- [ ] **Step 5: Verify GREEN**

  Run: `node --test tests/production-control-repository.test.js && npm run verify:postgres-foundation`

  Expected: PASS; no test uses a synchronous worker bridge.

- [ ] **Step 6: Commit**

  ```bash
  git add server/production/controlRepository.js tests/production-control-repository.test.js scripts/postgres-foundation-verify.mjs
  git commit -m "feat: add asynchronous control repository"
  ```

### Task 5: Implement Global Identity, Invitations and Memberships

**Files:**
- Create: `server/production/identityService.js`
- Create: `tests/production-identity-service.test.js`

**Interfaces:**
- Consumes: `createControlRepository` from Task 4.
- Produces: `createIdentityService({repository, passwordHash, verifyPassword, invitationSecret, clock})`.
- Produces methods: `issueInvitation`, `acceptInvitation`, `revokeInvitation`, `authenticatePassword`, `listActiveMemberships`, `changeMembership`, `suspendIdentity`.

- [ ] **Step 1: Write failing identity and invitation tests**

  Cover issuance by an active owner/admin; single-use expiring tokens; signed role/tenant immutability; existing-email acceptance only after authenticating that matching identity; new-email acceptance creating one identity; replay/revoke/expiry refusal; final-owner removal denial; and identity/membership version increments.

- [ ] **Step 2: Add the Review Focus multi-tenant identity test**

  Test `one verified email accepts invitations to two tenants without merging tenant data`: assert one global identity ID, two membership IDs, different tenant IDs and no business-record operation in the control repository.

- [ ] **Step 3: Run focused tests and verify RED**

  Run: `node --test tests/production-identity-service.test.js`

  Expected: FAIL because `createIdentityService` is missing.

- [ ] **Step 4: Implement the smallest service**

  Use random 256-bit tokens shown once, HMAC-bound tenant/email/roles/expiry claims, stored token hashes, adaptive password hashing supplied by the caller and generic authentication errors. Return no password hashes, token hashes or membership records from other identities.

- [ ] **Step 5: Verify GREEN and run existing invitation regressions**

  Run: `node --test tests/production-identity-service.test.js tests/tenant-administration.test.js tests/platform.test.js`

  Expected: PASS with tenant-local evaluator invitations unchanged.

- [ ] **Step 6: Commit**

  ```bash
  git add server/production/identityService.js tests/production-identity-service.test.js
  git commit -m "feat: add global identities and memberships"
  ```

### Task 6: Port MFA to the Asynchronous Global Identity Boundary

**Files:**
- Create: `server/production/mfaService.js`
- Create: `tests/production-mfa-service.test.js`
- Modify: `server/mfa.js`

**Interfaces:**
- Consumes: pure `totp`, `encodeBase32` and key validation from `server/mfa.js`; asynchronous state methods from Task 4.
- Produces: `identitySecurityBinding(identity) -> string` using credential hash, active status and `securityVersion` but no tenant role.
- Produces: `createGlobalMfaService({repository, key, clock, issuer})` with `status`, `beginEnrollment`, `confirmEnrollment`, `createChallenge`, `verifyChallenge` and `regenerateRecoveryCodes`.

- [ ] **Step 1: Write failing async MFA behavior tests**

  Cover encrypted secret storage, five-minute enrollment/challenge expiry, TOTP replay denial, single-use recovery codes, bounded failures, security-binding invalidation, session revocation on confirmation and mandatory-MFA status for every interactive production identity.

- [ ] **Step 2: Run focused tests and verify RED**

  Run: `node --test tests/production-mfa-service.test.js`

  Expected: FAIL because the asynchronous service and identity binding do not exist.

- [ ] **Step 3: Extract only shared pure crypto from the evaluator MFA module**

  Export the existing tested encryption-key parser/encrypt/decrypt primitives under names that do not expose secret values. Do not convert or alter `createMfaService` behavior; existing evaluator MFA tests must remain byte-for-byte compatible at their public boundary.

- [ ] **Step 4: Implement `createGlobalMfaService`**

  Persist through the control repository only, perform state transitions in repository transactions, increment `securityVersion` when factors/recovery change and revoke all identity sessions before returning success.

- [ ] **Step 5: Verify GREEN and evaluator regression**

  Run: `node --test tests/production-mfa-service.test.js tests/mfa.test.js tests/mfa-api.test.js tests/workspace-mfa-policy.test.js`

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add server/production/mfaService.js tests/production-mfa-service.test.js server/mfa.js
  git commit -m "feat: add global production MFA service"
  ```

### Task 7: Implement Tenant-Bound Sessions and Authentication HTTP Flow

**Files:**
- Create: `server/production/sessionService.js`
- Create: `server/production/authRoutes.js`
- Create: `tests/production-auth-flow.test.js`

**Interfaces:**
- Consumes: identity service from Task 5, MFA service from Task 6 and control repository from Task 4.
- Produces: `createSessionService({repository, clock, sessionTtlMs, cookieName})`.
- Produces middleware: `requireIdentitySession`, `requireTenantSession`, `requireCsrf`, `requireRecentAuthentication`.
- Produces routes under `/api/auth`: `login`, `mfa/verify`, `mfa/enroll`, `mfa/confirm`, `tenants`, `tenant`, `me`, `logout`.

- [ ] **Step 1: Write failing cookie/session tests**

  Assert opaque random tokens are stored only as hashes; cookies are Secure/HttpOnly/SameSite=Lax with no broad Domain; all writes require matching CSRF; tenant selection requires an active membership; multi-tenant switching rotates the token; and logout revokes the current session.

- [ ] **Step 2: Add the Review Focus stale-session matrix**

  For each mutation—membership role/version, membership suspension, tenant suspension, password/security-version change and MFA change—issue a session first, mutate state, then assert the next protected request is refused and the session is revoked.

- [ ] **Step 3: Run focused tests and verify RED**

  Run: `node --test tests/production-auth-flow.test.js`

  Expected: FAIL because session service/routes are missing.

- [ ] **Step 4: Implement session service and routes**

  Bind each tenant session to identity ID, tenant ID, membership version, identity security version and verified MFA timestamp. Password-only first sign-in may access MFA enrollment and logout only. Exact-origin validation precedes cookie-authenticated state changes.

- [ ] **Step 5: Verify GREEN and auth regressions**

  Run: `node --test tests/production-auth-flow.test.js tests/mfa-api.test.js tests/all-user-mfa-integrity.test.js tests/platform.test.js`

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add server/production/sessionService.js server/production/authRoutes.js tests/production-auth-flow.test.js
  git commit -m "feat: add tenant-bound production sessions"
  ```

### Task 8: Implement the Capability-Pack Catalog and Lifecycle

**Files:**
- Create: `server/production/moduleService.js`
- Create: `server/production/moduleRoutes.js`
- Create: `tests/production-module-lifecycle.test.js`

**Interfaces:**
- Consumes: tenant pool and tenant-bound authorization from Tasks 3 and 7.
- Produces: `createModuleService({tenantPool, catalog, clock})` with `list`, `enable`, `suspend`, `beginRetirement`, `disable`, `authorize`.
- Produces middleware: `requireModule(code, action)`.

- [ ] **Step 1: Write failing catalog and dependency tests**

  Seed literal catalog entries `core`, `sales`, `marketing`, `service`, `events`, `membership`, `fundraising`, `grants`, `volunteer`, `payments`, `intelligence`. Assert immutable codes, explicit dependencies, versioned entitlements and unknown-module refusal.

- [ ] **Step 2: Write the Review Focus failed-enablement test**

  Force an admission callback failure and assert the module remains non-callable, records a reasoned event, exposes no enabled navigation/API capability and can be retried idempotently after repair.

- [ ] **Step 3: Write disable/retention tests**

  Assert suspension denies writes/jobs but permits authorized read/export; retirement requires dependency and export review; disable hides ordinary routes without deleting retained records; re-enable preserves compatible data.

- [ ] **Step 4: Run focused tests and verify RED**

  Run: `node --test tests/production-module-lifecycle.test.js`

  Expected: FAIL because module service/routes do not exist.

- [ ] **Step 5: Implement service, authorization and admin routes**

  Register `GET /api/modules` and administrator-only reasoned/versioned transitions. Perform tenant-module changes in tenant-scoped transactions and expose only authorized active capabilities to the frontend.

- [ ] **Step 6: Verify GREEN**

  Run: `node --test tests/production-module-lifecycle.test.js tests/entitlements.test.js tests/tenant-administration.test.js`

  Expected: PASS.

- [ ] **Step 7: Commit**

  ```bash
  git add server/production/moduleService.js server/production/moduleRoutes.js tests/production-module-lifecycle.test.js
  git commit -m "feat: add capability pack lifecycle"
  ```

### Task 9: Add the Durable Outbox and Separate Worker Process

**Files:**
- Create: `server/production/jobRepository.js`
- Create: `server/production/worker.js`
- Create: `tests/production-jobs.test.js`

**Interfaces:**
- Produces: `createJobRepository({tenantPool, clock})` with `enqueue`, `claim`, `heartbeat`, `complete`, `retry`, `deadLetter`.
- Produces: `runWorker({repository, handlers, signal, concurrency}) -> Promise<void>`.
- Job identity: `{tenantId, jobId, kind, idempotencyKey, payload, state, attempts, availableAt, leaseOwner, leaseExpiresAt}`.

- [ ] **Step 1: Write failing queue-state tests**

  Cover unique tenant/idempotency keys, scheduled availability, atomic claims, bounded attempts, exponential retry ceilings, heartbeat ownership, dead-letter transition and per-tenant concurrency.

- [ ] **Step 2: Add the Review Focus lease-recovery test**

  Simulate worker A's expired lease and worker B's reclaim. Assert an idempotent handler records exactly one externally visible effect and both completion attempts cannot succeed.

- [ ] **Step 3: Run focused tests and verify RED**

  Run: `node --test tests/production-jobs.test.js`

  Expected: FAIL because the repository and worker do not exist.

- [ ] **Step 4: Implement transactional claim/lease behavior**

  Claim with `FOR UPDATE SKIP LOCKED`, short transactions and no provider call inside a transaction. Require handlers to receive the job idempotency key. Bound global and per-tenant concurrency and expose queue lag/attempt/dead-letter metrics without payload contents.

- [ ] **Step 5: Verify GREEN and worker shutdown**

  Run: `node --test tests/production-jobs.test.js`

  Expected: PASS, including graceful signal handling that finishes or safely releases claimed work.

- [ ] **Step 6: Commit**

  ```bash
  git add server/production/jobRepository.js server/production/worker.js tests/production-jobs.test.js
  git commit -m "feat: add durable production job worker"
  ```

### Task 10: Compose the Separate Production Web Application

**Files:**
- Create: `server/production/app.js`
- Create: `server/production/web.js`
- Create: `tests/production-app.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: runtime, pools, repositories and services from Tasks 2–9.
- Produces: `createProductionApp({config, controlPool, tenantPool, clock}) -> Express.Application`.
- Produces executable entrypoints: `node server/production/web.js` and `node server/production/worker.js`.

- [ ] **Step 1: Write failing secure-baseline tests**

  Assert Helmet headers and CSP, disabled `x-powered-by`, bounded JSON bodies, exact CORS origin, HTTPS enforcement, generic production errors, custom 404, authentication rate limits and no stack/secret leakage.

- [ ] **Step 2: Write process-isolation tests**

  Assert the web entrypoint never starts worker polling and the worker entrypoint never listens on HTTP. Assert both refuse startup when `PROCESS_ROLE` does not match.

- [ ] **Step 3: Run focused tests and verify RED**

  Run: `node --test tests/production-app.test.js`

  Expected: FAIL because the production composition does not exist.

- [ ] **Step 4: Implement the minimal production application**

  Mount health/readiness, auth and module routes only. Do not mount legacy CRM record routes yet. Use separate control and tenant pools, async error handling, exact trusted proxy configuration and shutdown hooks that stop accepting requests before closing pools.

- [ ] **Step 5: Add explicit scripts**

  Add `start:saas:web`, `start:saas:worker` and `test:production-foundation`. Leave `start:evaluation` and current evaluator scripts unchanged.

- [ ] **Step 6: Verify GREEN and evaluator deployment config regressions**

  Run: `node --test tests/production-app.test.js tests/client-evaluation-runtime.test.js tests/client-evaluation-deployment-config.test.js tests/runtime-config.test.js`

  Expected: PASS.

- [ ] **Step 7: Commit**

  ```bash
  git add server/production/app.js server/production/web.js package.json tests/production-app.test.js
  git commit -m "feat: compose isolated production SaaS runtime"
  ```

### Task 11: Prove End-to-End Isolation and Foundation Readiness

**Files:**
- Create: `tests/production-foundation-e2e.test.js`
- Create: `scripts/production-foundation-check.mjs`
- Create: `PRODUCTION-FOUNDATION-HANDOVER.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: completed production web/worker foundation.
- Produces: `npm run check:production-foundation`, a read-only readiness check with redacted JSON output and non-zero exit on a missing gate.

- [ ] **Step 1: Write the failing two-tenant end-to-end test**

  Provision Tenant A and Tenant B, accept the same verified identity into both, enroll MFA, create tenant-bound sessions, enable different modules and enqueue tenant jobs. Assert each session sees only its membership/module/job state and direct tenant-ID substitution fails.

- [ ] **Step 2: Add cross-boundary negative tests**

  Exercise reads, writes, module transitions, job claims, session switching, exports and control-plane table access with missing, stale and forged tenant context. Assert denial and retained audit without data mutation.

- [ ] **Step 3: Run focused E2E and verify RED**

  Run with a disposable PostgreSQL database: `node --test tests/production-foundation-e2e.test.js`

  Expected: FAIL on the first not-yet-composed boundary.

- [ ] **Step 4: Fix only integration seams exposed by the E2E test**

  Do not add CRM business modules. Make the smallest composition/configuration changes needed for the already-defined foundation contracts to work together.

- [ ] **Step 5: Implement the read-only readiness check**

  Check runtime profile, distinct non-superuser roles, migration version, forced RLS, control-schema privilege separation, object-storage private confirmation, MFA key validity, web/worker process evidence, zero dead-letter jobs and backup configuration metadata. Return statuses and reasons only, never credentials or URLs containing credentials.

- [ ] **Step 6: Run all verification gates**

  Run:

  ```bash
  npm run test:discipline
  npm run test:production-foundation
  npm run verify:postgres-foundation
  npm test
  npm run build
  npm audit --audit-level=high
  npm run check:production-foundation
  ```

  Expected: no focused/skipped tests; production foundation/E2E/PostgreSQL checks pass; all 1,474 existing tests plus new tests pass; build passes; no high/critical dependency finding; readiness output contains no `Blocked` gate.

- [ ] **Step 7: Perform targeted mutation checks**

  Temporarily and one at a time invert the tenant predicate, bypass membership-version comparison, allow a disabled module and remove the job idempotency constraint in an isolated branch/worktree. Confirm the owning tests fail, then restore each mutation without committing it.

- [ ] **Step 8: Write the handover truthfully**

  Record exact commit, commands/counts, PostgreSQL target class, observed role/RLS evidence and remaining follow-on plans. State explicitly that this is an empty production foundation, not a completed CRM, deployment, customer migration or customer acceptance.

- [ ] **Step 9: Commit**

  ```bash
  git add tests/production-foundation-e2e.test.js scripts/production-foundation-check.mjs PRODUCTION-FOUNDATION-HANDOVER.md package.json
  git commit -m "test: certify production SaaS foundation"
  ```

## Plan Self-Review

- **Spec coverage:** This plan covers runtime separation, identity/membership, all-role MFA, tenant sessions, PostgreSQL/RLS, module lifecycle, worker separation and the first readiness gate. Canonical CRM entities, packs, external providers, billing, full recovery operations and GA acceptance are intentionally assigned to the listed follow-on plans.
- **Step scan:** Every task has an observable RED, minimal implementation boundary, GREEN command, regression command and commit boundary. Real PostgreSQL absence blocks Tasks 3 onward rather than producing a skip.
- **Type consistency:** Tasks 4–10 consume the exact pool/repository/service names established earlier; tenant ID, identity security version, membership version and module entitlement version remain explicit across boundaries.
- **Review Focus:** The five highest-risk inputs are each owned by named tests in Tasks 3, 5, 7, 8, 9 and 11.
- **Proportion:** The plan fixes interfaces and behavior without prescribing function bodies except where exact database/runtime safety constraints require the decision.

