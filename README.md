> Latest peer-fundraising pass: **678/678 tests pass** (35.60s), build passes (1.26s). Reviewed ownership/goals, exact existing-gift attribution, reasoned unlink/retirement, private reports, transactional source/merge guards and recovery are verified. The corrected uninterrupted built journey and ranked mobile register passed. See [PEER-FUNDRAISING-RELEASE.md](PEER-FUNDRAISING-RELEASE.md). A2.6 is Partial; public pages, payments, production operations and buyer acceptance remain open. Current inventory: 46 local basic / 27 partial / 8 missing / 3 external evidence. Earlier checkpoints below are historical.

> Latest communications-workflow pass: **644/644 tests pass** (29.93s), build passes (1.24s). Prospective reviewed audience-entry draft production, full saved-record verification, durable retry/duplicate protection, retained source-aware UI/reporting and restore-boundary suppression are verified. Synthetic activation→new entry→one draft→retirement and mobile journeys passed. See [COMMUNICATION-WORKFLOWS-RELEASE.md](COMMUNICATION-WORKFLOWS-RELEASE.md). A7.3 is Partial; no provider sending or buyer acceptance is claimed. Current inventory:46 local basic /26 partial /9 missing /3 external evidence. Earlier checkpoints below are historical.

> Latest contract-conversion pass: **612/612 tests pass** (28.30s), build passes (1.26s). Signed exact original revision import/replay, immutable custody/lineage, administrator-only reports and encrypted recovery are verified. Synthetic browser save/replay and mobile journeys passed. See [CONTRACT-REVISION-CONVERSION.md](CONTRACT-REVISION-CONVERSION.md). C2 is Partial; actual exports and buyer acceptance remain open. Current inventory:46 local basic /25 partial /10 missing /3 external evidence. Earlier checkpoints below are historical.

> Latest private-reminder pass: **584/584 tests pass** (26.61s), build passes (2.34s). Owned UTC schedules, unique current-source inbox delivery, reasoned retained cancellation, safe suspension/retry ordering and native recovery are verified. Synthetic source completion and mobile journeys passed. See [TASK-REMINDERS-RELEASE.md](TASK-REMINDERS-RELEASE.md). A8.5 remains Partial; no external delivery or buyer acceptance is claimed. Earlier checkpoints below are historical.

> Latest saved-audience pass: **554/554 tests pass** (20.79s), build passes (1.22s). Exact saved segmentation, explicit digest-bound correspondence selection, fresh authority/consent checks and safe role-aware reports are verified. See [SAVED-AUDIENCES-RELEASE.md](SAVED-AUDIENCES-RELEASE.md). Provider synchronization/sending and buyer acceptance remain separate. Earlier checkpoints below are historical.

> Latest restricted helper pass: **531/531 tests pass** (26.62s), build passes (2.07s). Assigned-ticket check-in, default-deny access, reasoned/session-revoking assignments and desktop/mobile synthetic journeys are verified. See [EVENT-HELPER-ACCESS-RELEASE.md](EVENT-HELPER-ACCESS-RELEASE.md). A8.3 remains Partial; no production or buyer acceptance is claimed. Earlier checkpoints below remain historical.

> Latest persisted-history pass: **508/508 tests pass** (18.81s), build passes (2.67s). Saved fields and resolved links are verified transactionally, including reused dependencies; synthetic follow-on import and fixed-cutoff saved reporting passed. See [PERSISTED-HISTORY-INTEGRITY.md](PERSISTED-HISTORY-INTEGRITY.md). Earlier checkpoints below remain historical.

> Latest connected-history pass: **504/504 tests pass** (17.91s), build passes (2.13s). Campaign links, explicitly shared dated Logged interactions, strict constituent contacts and current campaign revenue cutoffs are implemented and browser-verified with synthetic commit/replay. See [CONNECTED-HISTORY-CONVERSION.md](CONNECTED-HISTORY-CONVERSION.md). Earlier checkpoints below remain historical.

> Latest conversion reliability pass: **484/484 tests pass** (17.73s), final build passes (1.16s). Unified mapping contract, indexed duplicate previews, preserved opt-out guidance, bounded request checks and mobile saved reconciliation are verified. Browser synthetic commit/replay passed with no duplicate revenue. See [MIGRATION-RELIABILITY-DEPTH.md](MIGRATION-RELIABILITY-DEPTH.md) for scope and remaining conversion/custody work. Earlier checkpoints below remain historical.

> Requirements-depth checkpoint: all 84 scored criteria reviewed; 46 local basic / 24 partial / 11 missing / 3 external evidence. Latest integrated verification: 477/477 tests and build pass. See [REQUIREMENTS-DEPTH-AUDIT.md](REQUIREMENTS-DEPTH-AUDIT.md) for accurate scope, limits and closure order. Local basic coverage is not production or buyer acceptance.

# Wimblo 0.5.0 local release

Wimblo is an independently branded nonprofit CRM by Kode Kinetics, currently available as a functional local evaluator pilot built using Node.js 24, React, Vite, Express, and SQLite. It demonstrates connected workflows with synthetic records and persistent local data. Wimblo is the product identity throughout the application.

This release is suitable for reviewing workflows and identifying implementation gaps. It is not a production deployment or evidence of FERPA, PCI, SOC 2, ISO 27001, or Learn Platform approval. It does not replace the RFP's required three years of relevant experience and three qualifying references.

Current release: **0.5.0 — requirements-first local implementation**. Current inventory: **46 Local / 27 Partial / 8 Missing / 3 Evidence required** across 84 criteria. [Current requirements matrix](CURRENT-RFP-REQUIREMENTS-MATRIX.md), [closure progress](REQUIREMENTS-CLOSURE-PROGRESS.md) and [requirements-first sequence](REQUIREMENTS-FIRST-CLOSURE.md) distinguish actual workflows, limits and remaining acceptance. Earlier phase reports/release ZIPs are historical. Default product/workspace identity is Wimblo; known legacy defaults migrate while customized organization settings/business records are preserved. This source is captured in the local 0.5.0 release commit and review package; consult the external handover note for its commit and checksum. No 0.5.0 cloud deployment is claimed.

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

[Current RFP requirements matrix](./CURRENT-RFP-REQUIREMENTS-MATRIX.md) compares all 84 scored criteria with current source and acceptance gaps. [Release 0.4.0 alignment review](./RFP-Alignment-Review-0.4.0.md) remains historical. This repository is a POC source deliverable, not a submitted bid or approved production service.

## Client testing handover

Install Node.js 24 or newer, unzip the handover package, and open a terminal in the Wimblo application directory:

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

- Constituents/contacts/preferences, managed households/membership, organization hierarchy, controlled duplicate merge and protected retained aliases.
- Gifts with school/classroom designations, split allocations, campaign links, revenue types, tribute information, soft credits, real pledge links, legacy pledge-reference labels, and traceable voids.
- Pledge commitments with monthly, quarterly or annual installment schedules, exact-cent distribution, received/balance/overdue amounts and linked gift history. Posted monetary receipts reconcile to the oldest installments; voids release fulfillment and commitments do not become received income.
- Grant requests, recorded award amounts/dates, matching-funder linked Grant receipts, explicit unknown legacy awards and as-of reconciliation reports. Requests/awards remain commitments; received records stay separate.
- Owned major asks/activity, planned instruments/commitments and matching ratio/cap claims with versioned existing-receipt links/unlink history. Commitments are not income; future/voided receipts are excluded from current received balances.
- Offline staff event tables/seats, tickets/check-in/cancellation, sponsor benefits, auction items/bids/winners and compatible existing payment links; no checkout, public bidding or processor refund.
- Campaigns/reporting deadlines and constituent/event-linked tasks.
- Volunteer clock intervals in a dated ledger, separate undated historical hours, and reason-required audited corrections that preserve original hours and dates.
- Communication drafts/logs, selected-recipient/annual Payroll correspondence templates and immutable human review. Finalized correspondence remains Not sent; Stewardship manually records completed acknowledgments.
- Receipt profile/preparation/history and validated manual print/hand-sign confirmation issuance, numbering, void/reissue APIs. Browser proof is preparation only; no buyer tax-valid document/physical signature/provider email is established.
- Database-derived dashboards, fiscal-year reports and local exports; direct/soft-credit, organization-descendant and household recognition reports distinguish monetary and noncash value. Recognition overlap across groups is not additional income.
- Shared saved report views that persist filters and can be applied by viewers; staff/admin can create/delete them. Dated volunteer reports preserve historical totals separately; pledge balance reports use an explicit as-of date.
- Real custom field/filter/group/calculation reports with versioned saved reruns, current source previews and internal persisted schedules; deterministic cohort/campaign/distribution/frequency analytics with source drill-through. The catalog is curated stored business fields/metadata, not arbitrary raw secrets/binary access or SQL. Source/output caps and full buyer field/history inventory remain acceptance work.
- Record-linked document upload/download/revisions/visibility/archive (PDF/PNG/JPEG/TXT/CSV, at most 1 MiB/file) and normalized constituent/designation/campaign/posted-gift/Logged-interaction migration preview/commit/replay (500 total rows, at most ten files). No complete NonProfitEasy/XLSX/history adapter.
- Authenticated roles/lifecycle/session revocation, optional own-account workspace TOTP/recovery, stale-write/CSRF protections, audit and manual encrypted full-workspace backup/offline NEW-path restore.

Follow [EVALUATOR-GUIDE.md](./EVALUATOR-GUIDE.md) for practical review steps. See [RFP-COVERAGE.md](./RFP-COVERAGE.md) for demonstrated workflows and remaining procurement/production gaps, and [FUTURE-CAPABILITIES.md](./FUTURE-CAPABILITIES.md) for the remaining roadmap. [API-CONTRACT.md](./API-CONTRACT.md) describes the initial API, while [PHASE-TWO-CONTRACT.md](./PHASE-TWO-CONTRACT.md) and [PHASE-TWO-ACCEPTANCE.md](./PHASE-TWO-ACCEPTANCE.md) cover the pledge, recognition, time-ledger, acknowledgment and saved-view additions.

## Build and verification

```sh
npm run build
npm test
```

The build generates the frontend in `dist/`. The test command runs the repository's automated checks; its output is the current source of truth for results. The current integrated 0.5.0 source passed **325/325 tests**, zero failures/skips, in 10.8 seconds, followed by a successful production build in 1.13 seconds. The earlier 290/296/316 checkpoints are historical; focused runs overlap and must not be summed. See [CURRENT-RELEASE-EVIDENCE.md](CURRENT-RELEASE-EVIDENCE.md), [VERIFICATION.md](VERIFICATION.md) and [closure progress](REQUIREMENTS-CLOSURE-PROGRESS.md) for scope and remaining acceptance.

## Production-mode configuration

The Express server serves `dist/` in production mode. This mode requires an exact HTTPS `APP_ORIGIN`, rejects insecure API requests, and uses Secure cookies. Running the production build over ordinary localhost HTTP will therefore not provide a working authenticated session. A controlled HTTPS reverse proxy is required for a production-mode review.

| Variable | Behavior |
|---|---|
| `NODE_ENV=production` | Enable production mode; serve built frontend files |
| `APP_ORIGIN` | Required exact HTTPS origin, such as `https://crm.example.org`, without trailing slash/path/query |
| `DB_PATH` | SQLite file path; use a fresh separate file for a nondemo installation |
| `APP_HOST` | Listener address; production defaults to `0.0.0.0`, local mode to `127.0.0.1` |
| `PORT` | Listener port; defaults to `4311` |
| `TRUST_PROXY=true` | Trust one controlled reverse proxy; set only when that proxy terminates HTTPS correctly |
| `ALLOW_DEMO`, `EVALUATOR_MODE` | Must be false/unset in production; demonstration startup is rejected |
| `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` | Provision the initial legacy-workspace administrator on a fresh nondemo production database; password requires at least 16 characters, uppercase, lowercase, number and symbol |
| `MFA_ENCRYPTION_KEY` | Required production key for workspace/platform MFA: exactly 32 bytes as 64 hex characters or canonical padded base64; no default |
| `BACKUP_ENCRYPTION_KEY` | Operator-only 32-byte key for encrypted CLI backup/restore, retained separately from archives |
| `ENABLE_ACCEPTANCE` | Keep false/unset in production; acceptance tools belong in a separate local synthetic deployment |
| `PERSISTENT_DATA_DIR`, `PERSISTENT_STORAGE_CONFIRMED=true` | Pre-existing absolute provider-verified durable mount; both DB_PATH and PLATFORM_DATA_DIR must be inside it |
| `PLATFORM_DATA_DIR` | Durable platform registry and isolated tenant directory |
| `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_NAME`, `PLATFORM_ADMIN_PASSWORD` | Separate initial platform administrator; strong password, remove bootstrap password after enrollment |

After a build, configure these variables privately for the intended HTTPS setup and run `npm run start`. Fresh nondemo production startup fails if administrator provisioning values are missing. Production rejects demonstration startup and existing demonstration accounts. Use a separate fresh DB_PATH and PLATFORM_DATA_DIR on the verified durable mount. Never substitute DEMO_MODE for a security policy.

See [production handover](PRODUCTION-HANDOVER.md) for the current deployment blockers and verified control scope. These configuration controls do not establish readiness for public hosting. Durable hosting, live database/disk encryption, hosted recovery/key custody, institutional review and operational support remain separate work. [Platform and intelligence status](PLATFORM-AND-INTELLIGENCE-STATUS.md) lists separate platform/provider variables; neither tenant labels nor AI configuration implement billing or approved real-data transfer.

## Account MFA and offline recovery

All workspace roles can enroll their own authenticator only when a protected valid `MFA_ENCRYPTION_KEY` is configured. Enrollment requires current-password reauthentication and TOTP confirmation; recovery codes are shown once. Enabling/disabling revokes sessions and requires fresh sign-in. Missing/wrong keys fail closed for already enabled accounts. Production workspace administrators and platform administrators must enroll MFA before business/control-plane access. Initial password-only sessions can only enroll and sign out; confirmation revokes sessions and requires fresh factor sign-in. Verified sessions bind current account access, and required administrator MFA cannot be disabled. Staff/viewer MFA remains optional; preferred institutional SSO, key custody and adopted account recovery policy remain separate.

The ordinary administrator JSON snapshot export is records-oriented and is not a service restore. The separate encrypted operator utility provides full-workspace SQLite backup and offline restore into a **new** destination:

```sh
node scripts/backup.mjs --help
```

Provide private paths, the explicit original workspace UUID and server-side `BACKUP_ENCRYPTION_KEY` as described by that help. AES-256-GCM archives include installed workspace tables/document bytes and verify tenant/schema/counts/digests; outputs refuse overwrite. Restored sessions/challenges/pending enrollment are cleared. Retain the same separate `MFA_ENCRYPTION_KEY` for enabled restored MFA. The workspace archive excludes the platform registry and environment/provider keys. Use the separate full-platform recovery utility for registry plus tenant recovery; encryption keys still remain outside all archives. This is tested local recovery, with 128 MiB/200-table/500,000-row limits, not scheduled backup, durable cloud storage or a hosted RPO/RTO commitment.

## Remaining work before real use

Actual buyer source discovery/mapping/conversion, approved report/field/history/output acceptance, durable cloud hosting, production keys/encrypted storage and workspace/platform recovery, approved SSO/helper role policy, district DPA/LearnPlatform/iBoss/assurance and named funded training/support remain open. Google/Microsoft/Mailchimp/Stripe, card/ACH/public giving/recurrence, email/SMS sends and provider compatibility are not live. Recording a payment method does not authorize or settle a payment; finalized correspondence does not send or complete an acknowledgment.

Q&A86 prioritizes core revenue/account codes/donors/basic reports before the **November 30, 2026** source-download boundary, with new-system migration/use from November 1. Q&A49 manual CSV/Excel/payroll conversion and reconciliation outside CRM remain the primary model; JEF has no Stripe account and may not connect district payment accounts. July 1–June 30 fiscal assignment/authorized reassignment now works locally; buyer correction/output acceptance remains necessary. Q&A54 says users are JEF personnel, so school-level reporting restrictions are not mandatory; optional helpers/module/field/export policy still needs agreement.

The proposed license is one year plus up to four annual renewals, with four full users plus two optional no-added-cost nonadministrator helpers. No implemented billing, guaranteed award, signed service terms or IP buyout is claimed. Qualifying software-provider history/references and institutional acceptance cannot be created by synthetic workflows or local tests. [Product closure report](PRODUCT-CLOSURE-REPORT.md) records the current commercial/access/release boundaries.

## Security and compliance evidence

See [requirement/control register](RFP-SECURITY-COMPLIANCE.md), [ranked security findings](security_best_practices_report.md) and [draft operations procedures](SECURITY-OPERATIONS.md). Current local source includes account access changes with session revocation and production acceptance-tool gating. Institutional production remains blocked by the documented configuration/helper-policy, hosted storage/recovery, external service, qualification and assurance gaps. Local workspace MFA, encrypted operator recovery and controlled private metadata/file access now exist; they do not prove district approval or hosted service operation.
