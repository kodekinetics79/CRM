# Wimblo Production CRM Handover

## Current checkpoint

- Direction: industry-neutral, multi-customer SaaS with isolated organizations.
- Branch: `feat/wimblo-crm-suite`.
- Scope: production PostgreSQL foundation plus canonical parties, sales, work timeline, reporting/import/export, and responsive production CRM workspace.
- Cost boundary: ordinary public-repository Git/CI is allowed; no paid Git feature, hosting upgrade, provider activation, new cloud resource, or other billable promotion is allowed.

The product is implemented and locally certifiable. It is not yet a deployed or customer-accepted production CRM.

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
- Deterministic local certification and the operator runbook at `docs/operations/WIMBLO-CRM-RUNBOOK.md`.

## Verification contract

```sh
npm run certify:crm:local
```

This runs focused CRM certification tests, disposable two-tenant PostgreSQL verification, encrypted backup/readback/fresh-target restore reconciliation, the full test suite, production and synthetic builds, a high-severity dependency audit, and the focused/skipped-test discipline gate. Results must be recorded from a fresh run at the exact commit being promoted.

The Task 6 post-review checkpoint completed locally on 2026-11-11: focused review-fix tests 27/27; PostgreSQL foundation schema version 16 with forced RLS on 35 tenant tables, two-tenant negatives, and a real capacity profile of 40 operations, 0 errors, pool maximum 2, observed concurrent queries 2, 40 actual queries, and 1 query per operation; real PostgreSQL/S3-compatible verification 46/46 including encrypted backup/readback/fresh-target restore reconciliation; full suite 1,660/1,660; production and synthetic builds passed; dependency audit found 0 vulnerabilities; discipline gate reported 0 focused and 0 skipped. The object store used for this check was an ephemeral local container that was stopped and removed afterward. These are local results, not CI, provider, deployment, or customer evidence.

Browser-engine acceptance is still unobserved on this machine because no compatible browser host is available. Do not describe source/render tests as browser acceptance.

## Delivery state

| State | Status |
|---|---|
| Implemented | Complete for the Task 1–6 CRM scope on the feature branch |
| Locally verified | Complete for the Task 6 implementation checkpoint; promotion requires rerunning at the final reviewed commit |
| Independent whole-branch review | Complete at `1639528`; security and DB/operations re-reviews found no remaining Critical or Important issue |
| CI / pull request | Not performed |
| Merged | Not performed |
| Deployed | Not performed |
| Production observed | Not performed |
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

## Cost-safe provider observation

Read-only provider inspection on 2026-11-11 found:

- GitHub repository `kodekinetics79/CRM` is public. `main` is unprotected and the existing `Build and tests` workflow uses a standard hosted runner; no paid Git feature was enabled.
- Vercel project `wimblo` is on the team plan and currently serves evaluator commit `95d3cfeb6549494c2249c558807a99d5ebc49c8a`. Automatic Git deployments were explicitly disabled before the feature-branch push because billed Wimblo build usage was observed. The current evaluator remains live until an explicitly approved, production-capable backend exists.
- Render project `WimbloCRM` serves evaluator commit `cb56128f7670fe0f84f8007294e83a172adbb685` from service `Wimblo_CRM`. The service is active on plan `0.5c-512mb`, but the project contains no Render database. The dashboard did not expose usable invoice details during inspection, so an actual settled `$7` charge is not claimed.
- No provider deploy, plan change, storage/database creation, secret write, billing action, or paid feature activation was performed. Production promotion is blocked by missing no-new-cost PostgreSQL, private object storage/backup scheduling, and a separately supervised worker.

Resolve these blockers only on existing no-new-cost capacity. If a provider requests payment, a plan upgrade, new paid Git checks, or owner-controlled billing action, stop that external action and preserve this local checkpoint.

## Known product boundary

Active same-tenant objects are tenant-wide metadata references in this release; CRM attachment links grant no byte access. No production download route is present. Any future object ACL, preview, or download work requires an explicit object-authorization model and security review.

The synthetic evaluator is for demonstrations only. It is build-separated and must never be used as customer production evidence.
