# Jordan Everbright — phase two acceptance evidence

Jordan Everbright is Kode Kinetics' synthetic evaluator application tailored to Jordan Education Foundation. It is not an official district product or endorsement. Phase two extends the local pilot with pledge schedules and receipt reconciliation, recognition reports, dated volunteer time, a manual stewardship workflow, and shared saved report views.

Independent automated verification passed **25 phase-two tests: 15 API workflow tests and 10 financial/report helper tests**. This document records that evidence; desktop/mobile browser review is a separate acceptance activity. The tests exercise temporary SQLite databases and synthetic records, not real donor or student data.

## Verified capabilities

| Capability | Verified behavior and failure cases |
|---|---|
| Pledge schedules | Monthly schedules retain the original day and clamp month ends, including leap February, without drifting March onward. Quarterly and annual dates cross years correctly. Remainder cents go to the earliest installments and scheduled amounts sum exactly to the commitment |
| Received-gift reconciliation | Only linked, posted monetary contributions from the correct donor through the selected as-of date fulfill installments. Fees, in-kind records, voids, unrelated pledges, future-dated receipts and legacy text references do not become received amounts. Receipts apply to the oldest installments; paused/cancelled commitments are not marked overdue |
| Pledge financial protection | Another donor, noncash/fee receipt, missing pledge, or overfulfillment is rejected. Pledge/receipt edits cannot invalidate existing fulfillment. Moving a receipt transfers its linkage without duplicating received value. Voiding a receipt releases fulfillment. An overfulfilled batch rolls back both receipts and mutation audits |
| Recognition | Organization reports traverse descendants; household labels are trimmed; direct and soft recognition remain distinct from monetary and noncash value. A gift belonging directly and through soft credit to the same group is counted once with direct precedence. Cycles terminate safely. Shared date, revenue-type and fiscal-year filters apply |
| Dated volunteer time | Clock-out appends a real start/end interval and reconciles the volunteer total. The same person cannot clock into two volunteer records simultaneously. Active clocks cannot switch person/event, and recorded volunteer identity remains stable. Changing a future event assignment does not rewrite a past interval's event |
| Historical hours and corrections | Legacy hours remain a separately labeled Historical entry with unknown start/end dates. Date/year filters apply to dated entries; historical totals remain separately visible. Corrections require a reason, retain original hours and dates, update aggregate totals, and create an audit entry. Stale, negative and empty-reason corrections are rejected; generic ledger creation/update/deletion is blocked |
| Manual stewardship action | Recording an acknowledgment creates a linked Logged communication atomically and increments the gift version. Invalid/future completion dates, duplicate actions, fee/void gifts and do-not-contact recipients are rejected. An acknowledged gift cannot change donor/revenue type; its linked contact cannot change recipient/status/date/channel or be deleted. Notes can be expanded without losing linkage |
| Shared saved views | Staff can save, update and delete validated report views; viewers can read them. Invalid report names, calendar dates, reversed ranges, out-of-range/noninteger inactivity days and unknown filter properties are rejected. Stale edits/deletes preserve the winning version. Saving a view does not schedule delivery |
| Roles and write protection | New workflows retain authenticated access, CSRF, record version checks and role restrictions. Viewers cannot write pledges, saved views, acknowledgments or time corrections; staff can perform ordinary operations |
| Persistent upgrade | A phase-one-shaped persisted database retains business record counts and a marker gift's value/type/reference. Existing positive volunteer totals migrate once without invented dates. The exact old default organization name is upgraded; custom names/fiscal settings remain unchanged. Repeated restarts do not duplicate historical entries, saved data or the synthetic pledge seed |

“Received” in this pilot means a recorded posted monetary gift. It does not establish bank settlement or external payment reconciliation. Recognition groups can overlap across parent/subsidiary views; **do not sum all recognition rows as financial income**. Direct/soft recognition is attribution, not an additional receipt.

Volunteer ledger date filters use the recorded start timestamp's UTC calendar date. An interval crossing midnight belongs to its start date; this release does not split hours across dates. Historical hours have no known date and must not be presented as hours worked inside a selected period.

## Practical evaluator checks

1. Create a pledge with a month-end start date and several installments. Inspect its schedule, then record a correctly linked gift and verify balance/overdue amounts. Try exceeding the commitment; verify no gift is saved. Void a receipt and confirm the balance reopens.
2. Give a subsidiary and its parent a direct/soft-credit relationship. Compare Organization rollup, Household rollup and Soft-credit recognition. Verify the same gift is counted once per group and noncash value remains separate.
3. Clock a volunteer in and out. Review the dated interval beside undated historical totals. Correct hours with a reason and confirm dates/original hours remain visible and totals reconcile.
4. In the stewardship queue, record a manually completed contact for an eligible gift. Open its linked interaction and confirm it is Logged. Verify the completed gift leaves the unacknowledged queue and cannot be acknowledged again. No message is sent.
5. Configure a report, save a named shared view, switch filters, then reapply the saved view. Verify the view survives reload and a board viewer cannot edit it.

These browser checks should be reviewed alongside the automated results, including guarded failure paths and responsive layouts. A successful helper/API test does not independently establish visual or keyboard usability.

## Remaining RFP and production gaps at phase two

This section is historical phase-two scope. Phase three now adds distinct grant requests/awards/linked receipts and the independent client-testing handover. Use PHASE-THREE-ACCEPTANCE.md and current RFP-COVERAGE.md for current release scope.

- **Procurement eligibility:** this build does not create the required three years of relevant institutional experience, three qualifying references, provider/reseller authorization, personnel-location evidence, or signed procurement forms.
- **Actual migration:** generic imports and local schema upgrades do not implement NonProfitEasy source discovery, approved field mapping, historical/current contract and attachment conversion, duplicate resolution, reconciliation, rollback or cutover.
- **Live systems:** no live Mailchimp, Google Workspace, Microsoft Office, Stripe, other processor, public giving, payroll-source or financial-system integration is verified. There is no online settlement, recurring charge collection, email/SMS delivery or provider-derived delivery analytics.
- **Further nonprofit operations:** volunteer/donor self-service, shift reservations/waitlists, public ticket checkout, auctions, operational matching-gift services, specialized planned-giving administration, controlled deduplication/merges, attachment management, distinct grant request/award/receipt tracking and richer workflow automation remain future scope.
- **Reporting:** saved views are shared filter definitions, not an arbitrary report designer or scheduled report delivery. Buyer-specific board packs, actual-volume performance and institutional report acceptance remain to be verified.
- **Institutional acceptance/security:** SSO/MFA, approved production hosting/geography, encryption-at-rest evidence, managed encrypted backups and tested recovery, security assurance/certification, completed incident-response/support plans, iBoss verification, Learn Platform approval and a signed district DPA remain prerequisites outside this automated acceptance evidence.

The release makes no FERPA, PCI, SOC 2, ISO 27001 or district-approval claim. Its manual acknowledgment records a completed staff action; it neither sends a communication nor issues an approved tax receipt. Use the product roadmap for further capabilities and obtain evidence before presenting any future feature as implemented.

## Reproduce automated checks

From the project directory with Node.js 24 or newer and dependencies installed:

```sh
node --test tests/phase-two.test.js tests/phase-two-lib.test.js
```

The API suite verifies real requests, persisted state, rollbacks, access controls and a reconstructed legacy database. The helper suite verifies exact monetary/date outcomes, recognition deduplication and dated-versus-undated time reporting. Existing phase-one regressions and browser acceptance should also be included in the release's final verification.
