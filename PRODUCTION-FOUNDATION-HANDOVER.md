# Wimblo Production CRM Handover

## Current checkpoint

- Direction: industry-neutral, multi-customer SaaS with isolated organizations.
- Release: merged to `main` through PR #1 at `ac2fcb9e0f1919dfb3cea0d734e107827d7f2590`.
- Scope: production PostgreSQL foundation plus canonical parties, sales, work timeline, reporting/import/export, and responsive production CRM workspace.
- Cost boundary: ordinary public-repository Git/CI is allowed; no paid Git feature, hosting upgrade, provider activation, new cloud resource, or other billable promotion is allowed.

The reviewed product scope is implemented, merged, and CI-certified. It is not yet a deployed or customer-accepted production CRM.

## What this version contains

- Canonical Party, Person, Organization, contact-point, and relationship records.
- Industry-neutral leads, pipelines, stages, opportunities, assignments, ownership, activities, tasks, notes, attachments, dashboards, governed reports, CSV preview/commit, and bounded formula-safe export.
- Distinct tenant/control PostgreSQL roles, forced RLS, composite tenant keys, explicit migrations, required MFA, opaque tenant-bound sessions, exact-origin CSRF, capability lifecycle, durable jobs, and immutable history.
- Durable CRM task reminders now run through a registered worker handler: due reminders create exactly one deterministic in-product timeline event and clear their schedule atomically; stale, rescheduled, completed, cancelled, unscheduled, missing-subject, and inactive-owner work is safely suppressed. No email, SMS, or push delivery is claimed.
- Production React workspace with organization switching, capability-aware navigation, people/organization search, pipeline controls, timeline, assignment, reporting/import/export journeys, responsive navigation, and a build-separated resettable synthetic evaluator.
- Startup certification before web listen or worker polling for current schema, tenant RLS role, control role, and role separation.
- Startup failure cleanup closes initialized pools exactly once; control-role certification also proves its audit-sequence and runtime-function privileges.
- Confirmed security fixes: failed logout no longer claims sign-out unless server termination succeeds or the server reports 401; saved-report updates authorize the persisted dataset before any replacement; attachment links explicitly grant metadata reference only and never byte access.
- Certification failures redact configured database/object-store credentials and identifiers through both direct verifier and composed certifier paths.
- Capacity evidence comes from 40 measured CRM repository operations on disposable PostgreSQL, not synthetic counters.
- Worker polling failures drain active work before pool shutdown, and shutdown-raced claims that never reached a handler are released without consuming an attempt or entering dead-letter state.
- Authenticated database TLS, effective PostgreSQL target comparison, complete control-plane privilege denial (including column grants and PostgreSQL 17 `MAINTAIN`), a 24-hour backup-evidence RPO, and CRM-plus-tenant-foundation fresh-target restore reconciliation are enforced before readiness.
- Authenticated responses use explicit public projections; MFA activation and recovery-code custody are transactional and resumable; transient control-plane read failures cannot revoke valid sessions.
- Saved tasks and notes resume after reload through bounded metadata lists and exact authorized detail reads. Manually edited import targets can be reconciled only through an explicit, reasoned, audited, version-checked action; stale or no-drift attempts are refused.
- Deterministic local certification and the operator runbook at `docs/operations/WIMBLO-CRM-RUNBOOK.md`.

## Verification contract

```sh
npm run certify:crm:local
```

This runs focused CRM certification tests, disposable two-tenant PostgreSQL verification, encrypted backup/readback/fresh-target restore reconciliation, the full test suite, production and synthetic builds, a high-severity dependency audit, and the focused/skipped-test discipline gate. Results must be recorded from a fresh run at the exact commit being promoted.

The final post-review candidate completed local verification on 2026-11-12: full suite 1,741/1,741; PostgreSQL foundation schema version 18; explicit PostgreSQL boundary/integration tests 4/4; real PostgreSQL/S3-compatible verification 46/46 including encrypted backup/readback/fresh-target restore reconciliation; production and synthetic builds passed; dependency audit found 0 vulnerabilities; discipline gate reported 0 focused and 0 skipped. The bounded capacity profile remained 40 operations, 0 errors, pool maximum 2, observed concurrent queries 2, 40 actual queries, and 1 query per operation. Dedicated PostgreSQL and object-store containers were loopback-only, ephemeral, and removed after evidence capture. These are local results, not deployment, provider-backup, browser, or customer-acceptance evidence.

Browser-engine acceptance is still unobserved on this machine because no compatible browser host is available. Do not describe source/render tests as browser acceptance.

## Delivery state

| State | Status |
|---|---|
| Implemented | Complete for the reviewed CRM release scope on `main` |
| Locally verified | Complete for release head `ff29dab`; full suite 1,741/1,741 plus production and PostgreSQL gates |
| Independent whole-branch review | Multiple security, DB/operations, worker, and CRM reviews completed; reproduced blockers were closed under RED/GREEN tests |
| CI / pull request | PR #1 merged; exact-head run `43162218349` and post-merge `main` run `43162642191` passed build, audit, 1,741 tests, PostgreSQL boundaries, and PostgreSQL foundation verification |
| Merged | Complete at `ac2fcb9e0f1919dfb3cea0d734e107827d7f2590` on 2026-11-12 |
| Deployed | No SaaS production deployment; existing evaluator deployments remain unchanged |
| Production observed | Evaluator liveness only; no SaaS readiness or customer-production evidence |
| Provider backup/restore observed | Not performed |
| Browser acceptance | Blocked locally by unavailable browser host |
| Customer UAT | Not performed |
| Customer accepted | Not performed |

## Deployment blockers

1. `render.yaml` still deploys the legacy SQLite `npm start` runtime, not the SaaS web and worker processes.
2. No checked-in deployment topology currently serves the production frontend `dist` bundle and proxies it to the SaaS API on the exact configured origin.
3. Object-storage and backup configuration is validated, but the SaaS entrypoints do not yet compose customer byte upload/download or provider backup scheduling/restore consumers.
4. The live Render project has one `0.5c-512mb` web service and no attached database. It runs the synthetic evaluator from `main`, with auto-deploy and PR previews off, no persistent production PostgreSQL, and no separately supervised SaaS worker. `/healthz` returns evaluator liveness, while `/ready` falls through to frontend HTML and is not a production-readiness probe.
5. Browser acceptance and customer UAT remain separate gates.
6. Authentication rate limiting is process-local for the current single-web-process design. Any future multi-replica web topology requires a reviewed shared durable limiter before production acceptance.

## Cost-safe provider observation

Read-only provider inspection on 2026-11-11, followed by a post-merge deployment check on 2026-11-12, found:

- GitHub repository `kodekinetics79/CRM` is public. `main` is unprotected and the existing `Build and tests` workflow uses a standard hosted runner; no paid Git feature was enabled.
- Vercel project `wimblo` is on the team plan and currently serves evaluator commit `95d3cfeb6549494c2249c558807a99d5ebc49c8a`. Although automatic Git deployments were marked disabled, two PR preview builds were still created. The Git integration was then disconnected from the project to prevent further branch-push builds. A post-merge query covering the merge window returned zero new deployments. The current production evaluator remains live and unchanged until an explicitly approved, production-capable backend exists.
- Render project `WimbloCRM` serves evaluator commit `cb56128f7670fe0f84f8007294e83a172adbb685` from service `Wimblo_CRM`. The service is active on plan `0.5c-512mb`, but the project contains no Render database. The dashboard did not expose usable invoice details during inspection, so an actual settled `$7` charge is not claimed.
- No provider deploy, plan change, storage/database creation, secret write, billing action, or paid feature activation was performed. Production promotion is blocked by missing no-new-cost PostgreSQL, private object storage/backup scheduling, and a separately supervised worker.

Resolve these blockers only on existing no-new-cost capacity. If a provider requests payment, a plan upgrade, new paid Git checks, or owner-controlled billing action, stop that external action and preserve this local checkpoint.

## Known product boundary

Active same-tenant objects are tenant-wide metadata references in this release; CRM attachment links grant no byte access. No production download route is present. Any future object ACL, preview, or download work requires an explicit object-authorization model and security review.

The synthetic evaluator is for demonstrations only. It is build-separated and must never be used as customer production evidence.
