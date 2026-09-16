# Claude final handoff — implementation run of September 15, 2026

Kode Kinetics LLC / Wimblo. Engineering evidence for Codex as CTO and product owner. This is not a submitted proposal, a buyer acceptance, a certification, a production sign-off, or a predicted evaluation score. Earlier release documents and verification JSON files remain **historical** and are not superseded in content; this is a new checkpoint alongside them.

## 1. Result in one paragraph

Nine parallel specialist workstreams plus a chief architect closed every locally code-completable gap identified at the start of the run, under a single extension seam that kept the hub files conflict-free. The complete suite passes **1366/1366 with zero failures, zero skipped and zero todo** on the frozen source, the production build passes, and real browser journeys pass at desktop and phone sizes. Register dispositions moved from 47/32/2/3 to **51 Local / 30 Partial / 0 Missing / 3 Evidence required**, with **zero criteria accepted by the buyer**. Six genuine product defects were found and fixed during verification, including one that would have failed every hosted deployment and one that would have misinformed users behind UTC every evening.

## 2. Exact files changed

- **New server modules:** `extensions.js` (the seam), `messaging.js`, `recurringGiving.js`, `publicGiving.js`, `volunteerPortal.js`, `eventPlanning.js`, `accountStructure.js`, `reportPacks.js`, `tenantAdministration.js`, `observability.js`, `dataQuality.js`, plus `server/persistence/` (11 modules).
- **Changed server modules:** `app.js`, `platform.js`, `reporting.js`, `communications.js`, `ai.js`, `fundraising.js`.
- **New screens:** `Messaging`, `RecurringGiving`, `AccountStructure`, `VolunteerPortal`, `EventPlanning`, `BoardPack`, `TenantAdministration`, `DataQuality`, and the public `PublicGiving` (`/give`) and `PublicVolunteer` (`/volunteer`).
- **Changed UI:** `App.jsx` (routing, navigation, public pages), `ScreenGuide.jsx` (help text for every new screen), `styles.css`, `wimblo.css`, six workstream stylesheets, and 41 feature/component files in the accessibility sweep.
- **Tests:** 42 new test files; two existing files corrected (`tests/ai.test.js` under explicit single-purpose authorization, `tests/audience-access-integrity.test.js` telemetry exclusion, `tests/constituent-timeline.test.js` restored after the product fix).
- **Deployment:** `render.yaml` (new), `.gitignore` (excludes internal security working notes from this public repository).
- **Evidence:** this file, `CLAUDE-FINAL-VERIFICATION.json`, `CLAUDE-REMAINING-EXTERNAL-GATES.md`, `CODEX-SUPERVISION-HANDOFF.md`, and the register in CSV and JSON together.

The complete file list with SHA-256 for all 314 source files is in `CLAUDE-FINAL-VERIFICATION.json` (`sourceManifestSha256`: `67d5540aeec449bde303b76d1a4e68d4b6d7ecf8f40b93ece5be112efe2290f9`, computed over the canonical `path:sha256` lines).

## 3. What became functional

| Area | What now works locally |
|---|---|
| Email and SMS marketing (A7.1, A7.4) | Consent ledger where a provider observation can only withdraw; sticky suppression no route can clear; immutable reviewed recipient snapshots; execution-time recheck that refuses the whole run when stale; idempotent bounded retries; signed replay-defended event intake; TEST_ONLY transports only |
| Campaign tracking and acknowledgment email (A7.6, A7.7, A2.10) | One attribution per gift by constraint, so tracking cannot duplicate revenue; selective consented acknowledgment that leaves the Not sent ledger semantics intact |
| Recurring and public giving (A2.7, A3.1) | Pledge refuses the collection adapter outright; exactly one posted gift per settlement under duplicate calls, restart and concurrent workers; dunning, refund, dispute and cancellation states; a public surface that records a request and no income |
| Volunteers and events (A5.5, A5.6, A6.9, A8.5) | Personal signed sign-up links, self-cancel with retained history, waitlist promotion, configurable reminders through the governed outbox, arrival claims that never write the hours ledger, event checklists and assignments with unresolved work named, task recurrence and escalation |
| Accounts and locations (A8.8, A8.1) | Unique location/function account pairs where one function across many locations counts once, structurally; rollups refuse rather than publish an unreconciled total |
| Reporting (B5, B6) | Board pack with every Q&A6 drilldown, refusing whole unless each reconciles; typed Office Open XML workbook, PDF and RTF with money as numeric cent-derived values |
| Identity and tenancy (A8.3, A8.7) | Entitlements enforced at execution, single-use signed invitations bound to a workspace, opt-in separation of duties, and an OIDC boundary that is disabled by default and issues no session |
| Security and operations (C7, C8 partial) | Request-level security telemetry with redaction proven by test, durable counters, inert alert hooks, readiness that fails closed, retention classes, legal hold and non-destructive disposition |
| Persistence readiness (Phase 4) | Repository boundary with one conformance suite passing on both SQLite and PostgreSQL, forward-only migrations, tenant isolation under row-level security, transactional financial writes, verified restore, encrypted private object storage — all executed against real infrastructure |
| Intelligence (Phase 9) | Deterministic duplicate, stewardship and narrative assistance that cites its records, withdraws when they change, refuses rather than estimates, runs no model and cannot act |

## 4. Verification results

- **Complete suite on frozen source:** 1366 tests, **1366 passed, 0 failed, 0 skipped, 0 todo**, 114.6s.
- **Production build:** passes, 1.48s.
- **Postgres/object-storage verification:** 46 checks, 46 passed, against real PostgreSQL 17.10 and a real S3-compatible store in dedicated local containers, reproduced independently by the architect and removed afterwards. Run with `npm run verify:postgres`; it fails loudly rather than skipping when the servers are absent, which is why it is not in `tests/` — the main suite keeps zero skips.
- **Browser journeys (Chromium, built application):** desktop 1440x900 — sign-in, all eight new screens with no error state, and a board pack assembled over a two-year period reading `$38,035.00` total, `$37,285.00` monetary, `$750.00` in-kind with every drilldown present. Phone 390x844 — zero horizontal overflow on thirteen workspace screens and both public pages.

## 5. Defects found and fixed during verification

1. **Hosted deployment blocker.** `/api/health`, the documented health check path, returns 403 over plaintext HTTP because the control plane's HTTPS guard mounts ahead of it. Provider health probes are internal HTTP, so every deploy would have been marked unhealthy. Fixed with `/healthz` outside `/api`.
2. **Mixed date semantics.** `server/fundraising.js` imported the frontend's local-date helper while all recorded timestamps and every other server module use UTC. A user behind UTC in the evening could be told a same-day follow-up was in the future. Found only because the suite crossed UTC midnight.
3. **Plaintext provider callbacks in production.** Three webhook routes mount before the `/api` HTTPS middleware and answered without TLS. HMAC protects integrity, not the contact details in the body.
4. **Denial of recovery by anonymous request.** Unbounded growth in `public_giving_returns` and in the audit table could push a workspace past the backup row ceiling, permanently preventing a recovery archive.
5. **Donor-facing 500.** Reloading a self-service link violated a uniqueness constraint.
6. **Model egress inheriting permission.** Remote inference was gated by how the database was seeded, and by who supplied the transport. It now requires a separately recorded authorization reference in all cases.

## 6. Register movement

**51 Local / 30 Partial / 0 Missing / 3 Evidence required**, from 47/32/2/3. `acceptedByBuyer` remains `false` for all 84 criteria.

- **Missing → Partial:** A7.1, A7.4.
- **Partial → Local:** A6.9, A8.3, A8.5, A8.8.
- **Held Partial against the specialist's recommendation:** **A5.6** (the criterion asks for automatic *email* reminders and the transport is unexecuted, so Local would be inconsistent with every other provider-dependent criterion) and **B6** (its written acceptance requires opening the files in Excel and a saved PDF; structural proof is not that).
- Fifteen further criteria received corrected behaviour text without moving.

## 7. Material risks introduced

- Ten to twelve new tables per module now exist in every workspace database and enter every backup; growth is bounded but the archive ceiling should be monitored.
- `pg` is now a production dependency although nothing imports it at runtime yet.
- New refusal paths exist that staff will meet: a changed account link refuses a board-pack export, an unreconcilable allocation refuses the whole pack, and retained history blocks some deletions.
- Request telemetry writes counters on a short timer in every workspace; two integrity tests now exclude those tables from whole-database snapshots.
- Separation of duties, when explicitly enabled, changes financial workflow for that workspace. It ships disabled and refuses to enable without a second approving account.

## 8. Next decision for Codex

The only decisions that need a person are outside the code: the qualification gates in `CLAUDE-REMAINING-EXTERNAL-GATES.md` §1, which are pass/fail before technical review and which no amount of engineering closes; whether one designation must report under several accounts at once (§3), which would require an apportionment rule and would give up the structural no-double-posting property; the retention window for idempotency evidence as distinct from evidentiary history; and whether to enable the local narrative provider in the buyer-facing evaluator, which stays off because it is a positioning decision rather than an engineering default.
