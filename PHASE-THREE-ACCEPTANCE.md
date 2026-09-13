# Jordan Everbright — phase three acceptance evidence

Phase three adds distinct grant request/award/receipt tracking, manually recorded client test results, and a built local evaluator that serves the application and API from one process. Jordan Everbright remains Kode Kinetics' synthetic application tailored to Jordan Education Foundation, not an official district product or endorsement.

Independent phase-three automated verification passed **17 tests: 11 API/launcher tests and 6 financial helper tests**. Tests use isolated temporary databases; launcher verification uses a separate temporary database and available loopback port, not the running development or client evaluator. Clean archive installation and desktop/mobile browser acceptance are separate release checks performed by the build owner.

## Verified behavior

| Area | Acceptance evidence |
|---|---|
| Grant amounts and dates | Requested and recorded awarded amounts remain separate integer-cent values. Positive awards require an Awarded/Closed stage and valid award date. Negative/fractional awards, invalid calendar dates, missing dates and unsupported stage combinations are rejected |
| Receipt identity and eligibility | Linked receipts require Grant revenue type, a valid recorded award and matching donor when the grant has a known funder. Fees, noncash, wrong funders, missing grants, unknown award amounts and simultaneous pledge/grant linkage are rejected. A null funder does not invent a donor restriction for an explicitly linked receipt |
| Financial protection | Posted linked receipts cannot exceed the recorded award. Gift and grant edits cannot invalidate receipt identity or award coverage. Changing the request amount does not change received value. Voids retain records and release receipt capacity; batch overfulfillment rolls back all batch receipts and mutation audits. Referenced grants cannot be deleted |
| Reconciliation | The helper reports requested, awarded, recorded receipts and remaining award distinctly. Only explicit posted Grant receipts through the inclusive as-of date count; voids, future receipts, other grants, unlinked descriptions and wrong known-funder donors do not. Duplicate receipt IDs count once. The as-of cutoff scopes receipts, not the stored award field |
| Legacy preservation | Existing single-value grants retain their original amount/stage without invented award values or dates. Unlinked old gift records remain unlinked. Repeated restart preserves counts. Legacy Awarded/Closed records with zero verified award are explicitly marked unknown in reconciliation rather than treating the request amount as an award |
| Client feedback | Authenticated viewers may create evaluation observations and read them, while remaining unable to write business records or edit/delete observations. Feedback requires CSRF; anonymous submission is denied. Scenario/result/severity enums, field types and tester identity are validated; staff review edits use optimistic versions and survive restart |
| Saved report scope | Grant reconciliation is accepted as a saved report view. Board viewers may read it but cannot change grants, views or receipts |
| Public health | The anonymous health response contains only status, release version and mode. It exposes no business records, credentials, sessions or database path; business workspace access still requires authentication |
| Local launcher | The built application and authenticated API run from the same loopback process without a Vite/development-server dependency. A board viewer can sign in and submit feedback to the isolated workspace. Evaluator cookies are distinct from development cookies; foreign origins are rejected. Production mode, exposed hosts, remote/HTTPS origins and invalid ports are rejected rather than weakening production controls |

“Recorded receipts” are persisted synthetic/manual monetary gift records. They are not evidence of bank settlement, a live processor or a reconciled accounting system. Request and award values never become received funds merely because a grant exists. A zero numeric legacy award/balance represents **unknown verified award**, not evidence that an award was actually zero or fully received.

## Client handoff

[CLIENT-TESTING-GUIDE.md](./CLIENT-TESTING-GUIDE.md) provides Node.js 24 setup, the `npm ci` / `npm run evaluate` flow, three local demo roles, nine scenarios, result/severity guidance, JSON/CSV feedback export and a fresh-round option that preserves previous databases.

The launcher defaults to `http://127.0.0.1:4321` and a separate `server/data/evaluator.sqlite`. It forces a loopback listener; a new `DB_PATH` can create an independent evaluation round. No original database should be deleted for testing. Separate client installations retain independent observations; exported feedback is shared through an agreed external review channel, not automatically synchronized or sent.

Client testing results are manual observations. A user-entered Passed result is not automated proof, certification or district acceptance. Expected rejection of an invalid operation can constitute a successful guard test; an unexpected failure or blocked workflow requires a clear recorded reason and reproduction reference.

## Remaining RFP and operational gaps

- Required relevant experience, three qualifying references, provider/reseller authorization, personnel location, signed procurement forms and other bidder eligibility need independent evidence.
- Actual NonProfitEasy mapping, historical/current contract and attachment migration, duplicate resolution, reconciliation, rollback and cutover remain separate work; local schema upgrades do not satisfy that migration requirement.
- Live Mailchimp/Google/Microsoft/Stripe/other processors, online payments and settlement, recurring collection, external payroll/financial-system connections, email/SMS delivery and provider analytics remain outside this release.
- Volunteer/donor self-service, shift reservations/waitlists, public ticket checkout, auctions, planned-giving services, operational matching-gift integration, controlled merges, attachments, richer workflow automation, arbitrary report design and scheduled report delivery remain future scope.
- SSO/MFA, approved production hosting/geography and encryption, managed backups and tested recovery, security assurance, support/incident ownership, institutional acceptance, iBoss verification, Learn Platform approval and a signed district DPA remain prerequisites for real use.

This is neither production-ready software nor a complete RFP response. No FERPA, PCI, SOC 2, ISO 27001 or district-approval claim is made. Manual stewardship records actions without sending messages or issuing approved tax receipts.

## Reproduce verification

From the project directory with Node.js 24+, installed dependencies and the built frontend present:

```sh
node --test tests/phase-three.test.js tests/phase-three-lib.test.js
```

The launcher tests need `dist/index.html`; run `npm run build` if it is absent. Existing phase-one/phase-two regressions, clean archive installation, and desktop/mobile keyboard/workflow checks belong in the final release verification alongside these tests.

## Final integrated release check

Release owner: September 13, 2026. The final combined suite passes 74/74, including the 55 baseline checks and 19 phase-three checks (12 API/launcher and 7 financial helper checks). The original independent 17-check result above remains its historical review snapshot. The final build succeeds. Clean installation, one-process evaluator launch, browser grant reconciliation, board feedback/read-only behavior, saved-result persistence, shortcuts and desktop/mobile checks are recorded in VERIFICATION.md. Completed embedded-browser downloads remain unverified; the guide includes client CSV/JSON comparison.
