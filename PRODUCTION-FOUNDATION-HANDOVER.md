# Wimblo Production CRM Handover

## Current checkpoint

- Direction: industry-neutral, multi-customer SaaS with isolated organizations.
- Branch: `feat/wimblo-crm-suite`.
- Scope: production PostgreSQL foundation plus canonical parties, sales, work timeline, reporting/import/export, and responsive production CRM workspace.
- Cost boundary: no push, PR, merge, deployment, paid Git feature, hosting upgrade, provider activation, or other billable cloud action is part of local certification.

The product is implemented and locally certifiable. It is not yet a deployed or customer-accepted production CRM.

## What this version contains

- Canonical Party, Person, Organization, contact-point, and relationship records.
- Industry-neutral leads, pipelines, stages, opportunities, assignments, ownership, activities, tasks, notes, attachments, dashboards, governed reports, CSV preview/commit, and bounded formula-safe export.
- Distinct tenant/control PostgreSQL roles, forced RLS, composite tenant keys, explicit migrations, required MFA, opaque tenant-bound sessions, exact-origin CSRF, capability lifecycle, durable jobs, and immutable history.
- Production React workspace with organization switching, capability-aware navigation, people/organization search, pipeline controls, timeline, assignment, reporting/import/export journeys, responsive navigation, and a build-separated resettable synthetic evaluator.
- Startup certification before web listen or worker polling for current schema, tenant RLS role, control role, and role separation.
- Confirmed security fixes: failed logout no longer claims sign-out unless server termination succeeds or the server reports 401; saved-report updates authorize the persisted dataset before any replacement; attachment links explicitly grant metadata reference only and never byte access.
- Deterministic local certification and the operator runbook at `docs/operations/WIMBLO-CRM-RUNBOOK.md`.

## Verification contract

```sh
npm run certify:crm:local
```

This runs focused CRM certification tests, disposable two-tenant PostgreSQL verification, encrypted backup/readback/fresh-target restore reconciliation, the full test suite, production and synthetic builds, a high-severity dependency audit, and the focused/skipped-test discipline gate. Results must be recorded from a fresh run at the exact commit being promoted.

The Task 6 implementation checkpoint completed locally on 2026-11-11: certification tests 9/9; PostgreSQL foundation schema version 16 with forced RLS on 35 tenant tables and two-tenant negatives; real PostgreSQL/S3-compatible verification 46/46 including encrypted backup/readback/fresh-target restore reconciliation; full suite 1,654/1,654; production and synthetic builds passed; dependency audit found 0 vulnerabilities; discipline gate reported 0 focused and 0 skipped. The object store used for this check was an ephemeral local container that was stopped and removed afterward. These are local results, not CI, provider, deployment, or customer evidence.

Browser-engine acceptance is still unobserved on this machine because no compatible browser host is available. Do not describe source/render tests as browser acceptance.

## Delivery state

| State | Status |
|---|---|
| Implemented | Complete for the Task 1–6 CRM scope on the feature branch |
| Locally verified | Complete for the Task 6 implementation checkpoint; promotion requires rerunning at the final reviewed commit |
| Independent whole-branch review | Security diff scan completed; two low findings remediated TDD-first; final post-fix logic/DB review still required |
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
4. Exact provider project/service plans, persistent storage, database, environment variables, billing state, deployed SHA, restart behavior, and live `/health`/`/ready` are not yet observed.
5. Browser acceptance and customer UAT remain separate gates.

Resolve these blockers only on existing no-new-cost capacity. If a provider requests payment, a plan upgrade, new paid Git checks, or owner-controlled billing action, stop that external action and preserve this local checkpoint.

## Known product boundary

Active same-tenant objects are tenant-wide metadata references in this release; CRM attachment links grant no byte access. No production download route is present. Any future object ACL, preview, or download work requires an explicit object-authorization model and security review.

The synthetic evaluator is for demonstrations only. It is build-separated and must never be used as customer production evidence.
