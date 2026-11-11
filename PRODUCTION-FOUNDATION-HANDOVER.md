# Wimblo Production Foundation Handover

## Certified checkpoint

- Product direction: industry-neutral, multi-customer SaaS with isolated organizations.
- Branch: `feat/wimblo-production-foundation`
- Certified code commit: `ba8a5c863957a40e67cf488546336abe71e29682`
- Certification date: 2026-11-11 (America/New_York)
- PostgreSQL target class: local PostgreSQL 17.10 on the fixed loopback verification port, using a new disposable database and new non-superuser roles for every run.
- Cost boundary: no push, pull request, merge, deployment, paid Git feature, hosting upgrade, provider activation or other billable cloud action was performed.

The certified commit is an empty secure SaaS foundation. It is not a completed CRM, production deployment, customer migration, provider activation, customer UAT or customer acceptance.

## What the certified foundation contains

- Fail-closed production runtime profiles for separately operated web and worker processes.
- Distinct tenant-data and control-plane PostgreSQL roles.
- Control-plane grants explicitly revoke tenant module/job table privileges, including repair of previously granted roles.
- Twelve forward-only checksum-protected migrations.
- Forced row-level security over all 13 tenant-scoped foundation tables.
- Global identities, isolated memberships and append-only control audit.
- Required MFA for active production identities, encrypted factors and one-use recovery/challenge state.
- Opaque tenant-bound sessions with CSRF, MFA, identity-security and membership-version binding.
- An industry-neutral capability catalog with reviewed enable, suspend, retire and disable lifecycles.
- Tenant-serialized capability transitions that preserve every enabled dependency.
- Tenant-scoped durable jobs with idempotency, leases, heartbeats, retries, exhausted-crash recovery, dead letters and bounded workers.
- Credential-bound one-use MFA challenges while the enrolled factor remains usable after a legitimate password/security rotation.
- Tenant-serialized membership changes that retain at least one active owner under concurrency.
- Separate executable web and worker compositions with graceful shutdown.
- A narrow control-only global dead-letter aggregate for read-only readiness inspection.
- A redacted read-only configured-environment readiness command.
- A two-tenant disposable-PostgreSQL E2E covering forged/stale sessions, cross-tenant reads/writes/jobs, client-supplied tenant substitution, missing scope, control-plane denial, absent legacy exports and immutable audit evidence.

The large existing evaluator CRM remains a separate synthetic/evaluation runtime. Its existing feature breadth is not evidence that those modules have been migrated onto this production foundation.

## Verification evidence

| Area | Exact command | Result |
|---|---|---|
| TDD discipline | `npm run test:discipline` | Passed: 0 focused, 0 skipped |
| Production foundation | `npm run test:production-foundation` | Passed: 69/69 tests |
| PostgreSQL controls | `npm run verify:postgres-foundation` | Passed: schema 12/12; distinct non-bypassing roles; 13 forced-RLS tables; global dead letters 0; cross-tenant and missing-scope access refused |
| Full regression | `npm test` | Passed: 1,543/1,543 tests, 0 failed/skipped |
| Frontend build | `npm run build` | Passed; one existing 511.71 kB chunk-size warning remains |
| Dependency audit | `npm audit --audit-level=high` | Passed: 0 vulnerabilities |
| Live readiness | `npm run check:production-foundation` | Correctly blocked with fixed redacted reason codes because no configured deployed environment or recent private operator evidence was supplied |

Four targeted mutation checks also proved the owning tests detect inverted tenant RLS, bypassed membership-version invalidation, capabilities granted to disabled modules and removal of tenant-scoped job idempotency. Every mutation was restored before certification.

An independent whole-branch review then found and drove five additional TDD fixes: control-role tenant-table access, dependent-module invalidation, exhausted crashed leases, MFA lockout after identity security changes and concurrent final-owner demotions. Focused tests and disposable PostgreSQL now cover each case.

## Readiness command contract

`npm run check:production-foundation` performs only read-only database inspection. It returns redacted JSON and exits:

- `0` when every configured-environment gate is proven.
- `2` when one or more gates are absent or unsafe.
- `1` for invalid invocation or an internal checker failure.

The command requires the production runtime variables plus a recent private operator evidence file named by `WIMBLO_PROCESS_EVIDENCE_FILE`. The file must be an absolute regular non-symlink file, no larger than 64 KiB, inaccessible to group/other users, and bound to `WIMBLO_EVIDENCE_BINDING`. It records only recent web/worker health and backup configuration/observation metadata. Paths, bindings, credentials, URLs, role names, tenant IDs, bucket names and driver errors are never copied into output.

## Delivery state

| State | Status |
|---|---|
| Implemented | Production SaaS foundation complete at the certified code commit |
| Locally verified | Complete for the commands and scope above |
| CI / pull request | Not performed |
| Merged | Not performed |
| Deployed | Not performed |
| Production observed | Not performed |
| Customer data migrated | Not performed |
| Customer UAT | Not performed |
| Customer accepted | Not performed |

## Open production and product gates

- Configure real private document and backup storage; verify provider-side policy without exposing credentials.
- Establish secret/key custody, rotation and recovery procedures.
- Deploy web and worker independently with recent environment-bound process evidence.
- Run backup creation, immutable readback and restore drills; measure RPO/RTO.
- Add monitoring, queue/dead-letter alerting, incident routing and operational ownership.
- Complete security review, load/capacity testing and deployment rollback rehearsal.
- Build canonical Party, Person and Organization records plus universal CRM records.
- Build industry-neutral leads, opportunities, pipelines, activities, dashboards, reports and governed import/export.
- Convert relevant evaluator capabilities into independently governed optional packs.
- Add provider integrations, billing/entitlements, operated recovery, migration reconciliation and customer acceptance plans.

No external evaluation should describe this checkpoint as a finished production CRM. It is a locally certified security and tenancy foundation on which the production CRM can now be built.
