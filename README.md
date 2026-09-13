# Jordan Everbright evaluator pilot

Jordan Everbright is a functional local evaluator pilot tailored to Jordan Education Foundation, built for Kode Kinetics using Node.js 24, React, Vite, Express, and SQLite. It demonstrates connected workflows with synthetic records and persistent local data. The product name and tailored workspace do not imply district endorsement or an official district product.

This release is suitable for reviewing workflows and identifying implementation gaps. It is not a production deployment or evidence of FERPA, PCI, SOC 2, ISO 27001, or Learn Platform approval. It does not replace the RFP's required three years of relevant experience and three qualifying references.

## Run from this repository

Requires Node.js 24 or newer. Build the frontend after installing locked dependencies:

```sh
git clone https://github.com/kodekinetics79/CRM.git
cd CRM
npm ci
npm run build
npm test
npm run evaluate
```

Open http://127.0.0.1:4321. This synthetic evaluator stays on your computer. Build output, installed dependencies, local databases and private environment settings are excluded from Git. The downloadable prebuilt handover package has a separate startup path below.

[Full RFP alignment review](./RFP-Alignment-Review-0.4.0.md) compares all 84 scored criteria with release 0.4.0 and distinguishes implemented local workflows, partial coverage and remaining evidence. This repository is a POC source deliverable, not a submitted bid or approved production service.

## Client testing handover

Install Node.js 24 or newer, unzip the handover package, and open a terminal in the Jordan-Everbright directory:

```sh
npm ci
npm run evaluate
```

Open [the independent evaluator](http://127.0.0.1:4321). It serves the bundled application and API together in one process, binds only to this computer, and uses a separate persistent synthetic database at `server/data/evaluator.sqlite`. No development preview is required. Stop it with Ctrl+C. Restarting retains test records and observations. A fresh round can use a new DB_PATH without deleting the previous round; see [CLIENT-TESTING-GUIDE.md](./CLIENT-TESTING-GUIDE.md).

Client testing includes eleven guided workflows, manually recorded Passed/Needs attention/Blocked outcomes, reproduction details and shared CSV/JSON exports. Board viewers can submit testing observations while business records remain read-only. [CONTROLS-AND-CONNECTIVITY.md](./CONTROLS-AND-CONNECTIVITY.md) describes implemented controls and external approval gaps.

For source development, use `npm run server` and `npm run dev` in separate terminals. Development preview runs at http://127.0.0.1:5174 with API port4311 and its own `server/data/foundation.sqlite`; it is separate from the handover evaluator.

## Demo accounts

| Role | Email | Password | Intended review |
|---|---|---|---|
| Administrator | `alex@foundation.example` | `FoundationDemo!2026` | Full workflow and administration review |
| Staff | `staff@foundation.example` | `FoundationDemo!2026` | Routine record entry and operations |
| Board viewer | `board@foundation.example` | `FoundationDemo!2026` | Read-only review |

These shared credentials are only for the synthetic local demo. Do not use them for real records or a public deployment.

## What to evaluate

- Constituent records, household and organization relationships, extra contacts, segmentation, and contact preferences.
- Gifts with school/classroom designations, split allocations, campaign links, revenue types, tribute information, soft credits, real pledge links, legacy pledge-reference labels, and traceable voids.
- Pledge commitments with monthly, quarterly or annual installment schedules, exact-cent distribution, received/balance/overdue amounts and linked gift history. Posted monetary receipts reconcile to the oldest installments; voids release fulfillment and commitments do not become received income.
- Grant requests, recorded award amounts/dates, matching-funder linked Grant receipts, explicit unknown legacy awards and as-of reconciliation reports. Requests/awards remain commitments; received records stay separate.
- Campaigns and reporting deadlines, event registration/check-in, and constituent/event-linked operational tasks.
- Volunteer clock intervals in a dated ledger, separate undated historical hours, and reason-required audited corrections that preserve original hours and dates.
- Communication drafts and interaction logs with local previews, plus a Stewardship queue for manually recording completed acknowledgments and linked logged interactions; no messages or tax receipts are issued.
- Database-derived dashboards, fiscal-year reports and local exports; direct/soft-credit, organization-descendant and household recognition reports distinguish monetary and noncash value. Recognition overlap across groups is not additional income.
- Shared saved report views that persist filters and can be applied by viewers; staff/admin can create/delete them. Dated volunteer reports preserve historical totals separately; pledge balance reports use an explicit as-of date.
- Authenticated access, role restrictions, server-side validation, stale-write protection, and audit records.

Follow [EVALUATOR-GUIDE.md](./EVALUATOR-GUIDE.md) for practical review steps. See [RFP-COVERAGE.md](./RFP-COVERAGE.md) for demonstrated workflows and remaining procurement/production gaps, and [FUTURE-CAPABILITIES.md](./FUTURE-CAPABILITIES.md) for the remaining roadmap. [API-CONTRACT.md](./API-CONTRACT.md) describes the initial API, while [PHASE-TWO-CONTRACT.md](./PHASE-TWO-CONTRACT.md) and [PHASE-TWO-ACCEPTANCE.md](./PHASE-TWO-ACCEPTANCE.md) cover the pledge, recognition, time-ledger, acknowledgment and saved-view additions.

## Build and verification

```sh
npm run build
npm test
```

The build generates the frontend in `dist/`. The test command runs the repository's automated checks; its output is the current source of truth for results.

## Production-mode configuration

The Express server serves `dist/` in production mode. This mode requires an exact HTTPS `APP_ORIGIN`, rejects insecure API requests, and uses Secure cookies. Running the production build over ordinary localhost HTTP will therefore not provide a working authenticated session. A controlled HTTPS reverse proxy is required for a production-mode review.

| Variable | Behavior |
|---|---|
| `NODE_ENV=production` | Enable production mode; serve built frontend files |
| `APP_ORIGIN` | Required exact HTTPS origin, such as `https://crm.example.org`, without trailing slash/path/query |
| `DB_PATH` | SQLite file path; use a fresh separate file for a nondemo installation |
| `APP_HOST` | Listener address; defaults to `127.0.0.1` |
| `PORT` | Listener port; defaults to `4311` |
| `TRUST_PROXY=true` | Trust one controlled reverse proxy; set only when that proxy terminates HTTPS correctly |
| `ALLOW_DEMO=true` | Explicitly allow synthetic demo accounts/seeding in production mode; never appropriate for real records |
| `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` | Provision the initial administrator on a fresh nondemo production database. Password must have at least 16 characters and uppercase, lowercase, number, and symbol |

After a build, configure these variables privately for the intended HTTPS setup and run `npm run start`. Fresh nondemo production startup fails if administrator provisioning values are missing. An existing demo-account database is rejected unless `ALLOW_DEMO=true`; use a separate fresh `DB_PATH` for a nondemo environment. `ALLOW_DEMO` is the only demo authorization variable; do not substitute `DEMO_MODE`.

These configuration controls do not establish readiness for public hosting. Production hosting, encryption at rest, recovery, institutional review, and operational support remain separate work.

## Remaining work before real use

SSO and MFA, production hosting and encryption, managed backups and tested disaster recovery, external security assessment/certification, Learn Platform approval, a signed district DPA, verified NonProfitEasy mapping and migration, and live payment/productivity/email integrations remain outside this release. Google Workspace, Microsoft Office, Mailchimp, Stripe, other processors, and giving-platform connections are not live integrations. Importing a CSV or recording a payment method does not authorize, settle, or reconcile a transaction.

The fiscal start month is configurable and defaults to July for demonstration; the buyer's actual fiscal configuration must be verified. Manual pledge receipt reconciliation compares recorded gifts to commitments, not bank or processor settlements. Completed acknowledgment records describe staff-entered activity, not provider-confirmed delivery. Tax-receipt or acknowledgment output requires policy/legal review before issuing real donor documents. Synthetic event registrations, grant records, and volunteer time do not establish qualifying institutional experience.

Release0.4.0 adds Operations, volunteer capacity/waitlist/cancellation workflows, exact shared-email review, eleven client scenarios and administrator workspace checks. See [PHASE-FOUR-ACCEPTANCE.md](./PHASE-FOUR-ACCEPTANCE.md) and [CTO-PROJECT-PLAN.md](./CTO-PROJECT-PLAN.md) for current scope and expansion gates.
