# Wimblo 0.5.0 — nonprofit operations SME review

September 13, 2026. Independent, domain-focused software review of release baseline `9736783`; read-only inspection, with no application changes. This is an AI-assisted review, not a licensed consultant opinion, district approval, tax determination or acceptance of the complete RFP. Source anchors refer to this reviewed baseline; concurrent release fixes must carry their own evidence.

## Verdict and evidence boundary

**The local manual tracking is credible, but end-to-end operational acceptance remains open.** Major/planned/matching tracking, honor/memory records, documentary grant milestones, timed volunteer reservations, event tickets/seating/sponsors/auctions and reviewed correspondence now exist. Separate promises, posted receipts, human review and external fulfillment are generally identified honestly. The most important remaining business issues are inconsistent completion views and missing controlled correction/handoff transitions.

The release owner's [CURRENT-RELEASE-EVIDENCE.md](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/CURRENT-RELEASE-EVIDENCE.md:21) records 325/325 integrated tests, zero failures/skips, and a production build. Existing test cases were inspected below; this reviewer did not rerun that suite or independently perform these browser journeys. Source-derived reproductions are explicitly distinguished from executed tests. Current inventory is 46 Local, 24 Partial, 11 Missing and 3 Evidence required; Local is not buyer acceptance.

Basis: supplied base RFP, extracted scope pp.14–19 (A1–A8, B1–B10), and the source/interpretation register in [CURRENT-RFP-REQUIREMENTS-MATRIX.md](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/CURRENT-RFP-REQUIREMENTS-MATRIX.md:11). Owner-supplied official Q&A49/54/56/86 and Q&A38 guide manual revenue inputs, printed receipts, current reporting, retention, migration dates and ease of management. This reviewer did not freshly authenticate the public Q&A portal. Only community grants are in the stated buyer scope; government-grant compliance is not an added requirement. Public volunteer signup can phase; automatic sending, native XLSX, mandatory school-level access restrictions and a particular software framework must not be invented as unconditional requirements.

P1 means a material acceptance/release blocker for an offered required workflow; P2 means a consequential current workflow or correction gap; P3 means an optional improvement. A recommended implementation is not automatically an additional RFP mandate.

## Concrete findings

### O1 — P2: completed grant obligations remain overdue in the Grants screen

**Required:** consistent grant calendar/completion narrative and buyer journey (A4.2/A4.5). The specific shared-status implementation is a recommendation.

Source-derived reproduction: create a Report milestone matching an Awarded grant's past `reportDue`, attach eligible evidence and complete it. Operations suppresses the matching legacy obligation and removes the completed milestone, but Grants still selects that grant in “Past due dates” and displays “Past due date.” Its note says the pilot does not track submission evidence or completed reports, although the new module does.

Evidence: [GrantWorkspace.jsx](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/src/features/GrantWorkspace.jsx:17) filters and derives deadlines only from grant fields; its contradictory note is at line53. [App.jsx](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/src/App.jsx:77) supplies no milestone projection to this screen. [phaseFour.js](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/src/phaseFour.js:6) implements exact-match completion suppression. [grantOperations.js](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/server/grantOperations.js:29) supports completion and reasoned reopening.

Existing tests: [grant-operations.test.js](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/tests/grant-operations.test.js:94) verifies workspace queue completion/reopen and privacy; it does not verify the incumbent Grants calendar. Needed: complete/reopen the same obligation and compare both screens, including legacy dates without a mapped milestone. Show recorded dates separately from outstanding obligations and link to the responsible milestone. Completion is a staff-confirmed documentary fact, not evidence of external submission or funder acceptance.

### O2 — P2: major ask stage and next-action responsibility do not close the donor journey

**Required:** truthful major-gift narrative (A2.3) and buyer acceptance of the offered staff workflow. **Optional depth:** receipt-credit conversion/portfolio automation is not explicitly mandated by the base narrative.

Source-derived reproduction: save a major ask as Committed, Declined or Closed. Every one still returns `completion: 'Prospect'`; its received amount is zero and eventual gifts cannot be associated with that ask. Save an overdue `nextActionDate`: it does not appear in Operations. Staff must separately find the ask, create a Task and record the eventual ledger gift without an explicit ask-to-gift reference.

Evidence: [fundraising.js](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/server/fundraising.js:9) permits these stages; lines33–34 reject major receipt association and always project Prospect. [Fundraising.jsx](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/src/features/Fundraising.jsx:29) exposes that completion label; line35 tells users to record eventual gifts in the ledger. [phaseFour.js](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/src/phaseFour.js:5) includes tasks, grants, pledges and acknowledgments, not fundraising next actions.

Existing tests: [fundraising.test.js](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/tests/fundraising.test.js:19) proves owner validation, versioning/activity and asks not becoming income. Needed: buyer demonstrates Asked → Committed → posted gift → completed thank-you, or Declined/Closed with an accepted reason and visible follow-up disposition. Correct the unconditional Prospect label; agree whether a source reference and due-work projection are necessary. Never turn an ask into income automatically.

### O3 — P2: operational mistakes after event check-in or winner closure lack a controlled correction route

**Required:** disclose and accept the actual ticket/attendance/auction/sponsor lifecycle (A6.2–A6.6). **Recommended:** audited correction/cancellation transitions; no provider refund is implied.

Source-derived reproduction: check in a ticket against the wrong attendee. Ticket and assigned-seat cancellation then fail, with a message requiring a separate attendance correction policy, but no corresponding undo endpoint exists. Close an auction with its current winner: the item cannot reopen or record winner withdrawal/default. A sponsorship has editable amount/benefits but no cancelled/declined/fulfilled disposition; any payment-link history locks donor/amount even after a void.

Evidence: [eventOperations.js](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/server/eventOperations.js:50) and lines52–53 block checked-in cancellations; lines57–59 lock bid terms and winner closure; line55 locks sponsor/amount after payment history. Line61 rejects deletion and supports cancellation only where implemented. [EventOperations.jsx](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/src/features/EventOperations.jsx:51) acknowledges the separate attendance policy rather than supplying one.

Existing tests: [event-operations.test.js](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/tests/event-operations.test.js:104) proves confirmed highest-bid closure; line131 proves payment/void/cancellation; line166 verifies retained ticket/seat registration guards. Needed: correction of mistaken attendance, no-bid/withdrawn winner, cancelled sponsorship with delivered benefits and payment reversals, and staff-approved inventory retirement. Preserve originals/reasons; decide separately whether fulfillment confirmation is needed. Source retention is valuable, but “use a correction policy” is not an executable correction.

### O4 — P2: event seating has two independent operational representations

**Required:** an understandable and accurate seating narrative (A6.4). Consolidating presentation is a recommendation.

Source-derived reproduction: register a guest with free-text table/seat on the event record, then assign a different native inventory seat in Event operations. Both values persist; the registration table still renders its free-text value while native seating shows the inventory assignment. The free-text label can also say Unassigned after an actual native seat is assigned. Neither view identifies the other as historical commentary.

Evidence: [app.js](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/server/app.js:253) persists registration `seating`; [RecordDetail.jsx](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/src/features/RecordDetail.jsx:24) accepts and displays it. [eventOperations.js](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/server/eventOperations.js:49) persists a separate constrained assignment; [EventOperations.jsx](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/src/features/EventOperations.jsx:47) displays native seating. There is no synchronization in those writes.

Existing tests verify native capacity/collision/history, not agreement between the two displays. Needed: registration → assignment → reassignment/cancellation → printed/check-in roster with a single authoritative seat. Retain imported free text as labeled legacy notes if required; do not silently overwrite history.

### O5 — P2: produced letters, receipt issuance and completed thank-yous require a manual handoff

**Required:** accurate acknowledgment/receipt production and the accepted delivery/completion path (A2.10/A3.4–A3.5/A7.5/A7.7, Q&A49). The buyer may accept the individually printed/hand-signed route. An email draft is not CRM-email delivery.

Source-derived reproduction: prepare/finalize a correspondence acknowledgment for a pending gift. Its status becomes Finalized/Not sent and the gift remains pending in Stewardship. Print-receipt issuance is another independent history. Staff must perform the external action and separately record completion; there is no direct reviewed-snapshot-to-acknowledgment link proving which wording was used.

Evidence: [communications.js](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/server/communications.js:69) finalizes reviewed snapshots without acknowledgment writes. [Stewardship.jsx](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/src/features/Stewardship.jsx:10) derives pending from the gift acknowledgment; line12 records completed staff action separately. [Correspondence.jsx](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/src/features/Correspondence.jsx:29) explicitly says completed external actions are recorded separately.

Existing tests: [communications.test.js](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/tests/communications.test.js:45) deliberately asserts the acknowledgment ledger is unchanged; receipt tests cover staff-confirmed issuance, unique numbers and void/reissue. Needed: buyer physically prints/hand-signs the approved output, records actual completion, revisits the donor history and resolves duplicates/voids. Agree links among these separate histories and the responsible staff member; do not auto-complete on preview/finalization.

### O6 — P2: finalized tribute drafts can block financial correction without a withdrawal transition

**Required:** truthful honor/memory narrative and agreed correction/disclosure policy (A2.11); original retention/privacy remains necessary. A particular withdrawal UI is a recommendation.

Source-derived reproduction: finalize a Not sent tribute notification, discover a source gift amount/date/method/allocation error, and attempt ordinary source correction. The immutable finalization guards those fields even if tribute wording is later changed. No notification withdrawal/supersession/release endpoint is present. Voiding remains a distinct permitted source operation, subject to receipt guards; it is not necessarily the buyer's correction of a clerical error.

Evidence: [tributes.js](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/server/tributes.js:10) lists guarded financial fields; line48 finalizes; line52 locks source financial facts. [VERIFICATION.md](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/VERIFICATION.md:15) explicitly records this limitation. Current and saved disclosure approval checks correctly hide revoked viewer notifications; this finding is about workflow completion, not a new privacy leak.

Existing tests: [tributes.test.js](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/tests/tributes.test.js:64) proves retained source guards; line86 proves disclosure revocation isolation. Needed: approved correction or withdrawal with original wording/source facts retained, fresh review/consent, reason and staff authority. Never equate reviewed Not sent notification with fulfilled donor/honoree communication.

### O7 — P2: a constituent's operational history is spread across unconnected screens

**Required:** demonstrate usable relationship/history management (A1.1/A1.2/A1.6 and Q&A38). **Optional presentation:** a combined relationship timeline is not expressly mandated.

Evidence: [RecordDetail.jsx](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/src/features/RecordDetail.jsx:21) builds constituent gift history and line22 builds interactions only from the generic communications collection. Major/planned/matching activity, tribute notification review, correspondence snapshots and receipt-register history are separate modules/tables. They are not included in that interaction-history list. The richer source history can be retrieved elsewhere; it should not be described as absent.

Needed: buyer opens one donor after an ask, posted gift, tribute and reviewed letter and demonstrates how staff find each fact, preferences, responsible owner and actual completed action. Test discoverability and naming, not merely persistence. An Employee can also be a donor/volunteer, but constituent type is single-choice ([schema.js](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/src/schema.js:13)); buyer must accept type versus segment/volunteer-profile semantics without creating duplicate people.

### O8 — P2: ordinary task ownership is a text label rather than a current accountable user

**Required:** accurately describe owned event responsibilities/to-dos (A6.9/A8.5). Account-bound assignment/escalation is recommended depth, with buyer policy acceptance still open.

Evidence: [app.js](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/server/app.js:42) validates task owner as text, not an active user reference; [schema.js](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/src/schema.js:20) uses an unrestricted Assigned to field. [phaseFour.js](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/src/phaseFour.js:7) displays that text in the shared queue. Grant milestones and major asks instead validate actual active staff owners.

Source-derived reproduction: save a misspelled or departed staff name as owner. The task remains “Assigned to” that text; user suspension or transfer does not reassign it. This is a shared manual work queue, not delivery to an authenticated owner's inbox.

Needed: buyer agrees assignment/cover/transfer procedures and demonstrates unresolved event tasks and staff departure handoff. Record who is responsible for reminders; delivered reminders, recurrence and escalation are currently absent rather than implied by a date field.

## Remaining journeys and acceptance responsibilities

| Journey | Supported behavior and current test evidence | Required acceptance or optional improvement |
|---|---|---|
| Planned and matching commitments | Existing compatible posted cash receipts, unique association, rational ratio/cap, void-reopened balances, explicit reasoned unlink and restart: fundraising tests lines20–30. No ledger creation. | Accept cancellation after partial realization, zero/capped claims, original-donor correction, rounding, ownership and duplicate-claim policy. Multiple claims for one original/org are possible; this is not proof of duplicate income. Planned estate advice and automatic collection are outside the local scope. |
| Grant proposal/report/agreement | Source/owner/document-version-pinned completion, category/final-state checks, nonfuture actual completion, retained private evidence, reopening and exact-match calendar queue: grant tests lines35–94. | Buyer maps actual historical documents and dates, distinguishes submitted from funder-accepted work, assigns remaining responsibility and verifies archived/revised evidence. Completion does not alter grant stage, award or income automatically; agree the manual stage handoff. |
| Volunteer reservation to hours | Timed capacity/overlap/waitlist/cancellation tests: phase-four tests lines15–20. Clock, dated/history ledger and reasoned correction are separate actual APIs. | Reserve → attendance → hours reconciliation is manual. Reservation has no attended/no-show fulfillment state or shift-linked time entry; event guest admission must not invent hours. Coordinator accepts roster/time reconciliation. A shift-linked attendance/time handoff is P3 optional depth; self-service login/cancel/reminders remain separately disclosed Partial workflows and may phase. |
| Event payments and benefits | Exact existing donor/revenue-case linkage, unique payment references and void-reopened balance; sponsor benefit checklist. | Staff enters actual source receipts and external reversals; no collection/refund occurs. Buyer accepts group ticket payer/split-payment limitations, benefits evidence and winner default. See finance review for Cash auction benefit/receipt incompatibility; classifying every auction payment as a donation would be improper product behavior. |
| Consent and correspondence | Explicit primary recipient, preferred channel/opt-out gates, stale review rejection, current/saved tribute visibility/disclosure controls. | Approver confirms donor-name disclosure and recipient identity/channel for each output; staff logs actual external fulfillment. A blanket Do not contact field does not express separate marketing consent versus necessary receipt communication. Accept the conservative policy; do not silently override it. Mailchimp sync, delivery/bounce/unsubscribe and selective provider sending remain absent. |
| Board/reporting | Current-data standard/custom reports and internal scheduled immutable snapshots; reporting/privacy and schedule role/current-account tests. | Buyer approves the actual board pack, field definitions, fee/noncash treatment, period cutoff and source inventory. Q&A54 does not require school-level restrictions for JEF personnel. Optional helpers require ordinary role/module approval; a broad viewer must not be assumed to be an approved board policy. |
| Conversion/go-live | Normalized constituent/designation/posted-gift preview/atomic/replay-safe import; fictional browser migration. [migration.js](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/server/migration.js:109) explicitly excludes contracts, interactions, source voids and complete history. | Required: actual NonProfitEasy ten-year inventory, contracts/files/consent/correction mapping, trial/delta/final reconciliation and signed acceptance before source downloads end Nov30; begin migration/use target Nov1 subject to signed contract/PO. SchoolWindows/Successfund/payroll Excel-to-CSV and current SignUpGenius/event spreadsheets must be inventoried. No actual conversion is proven. |

The report builder is curated business data/metadata, not unrestricted SQL or secret/binary export. [reportEngine.js](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/src/reportEngine.js:2) bounds source rows at10,000 and results at250; buyer-volume history and full approved field coverage need acceptance. No actual buyer row count was inspected, so exceeding these limits is not asserted. Native Excel/PDF versus CSV/browser print needs buyer agreement, not an invented mandatory format.

## Cross-review and signoff plan

Finance independently reported source correction overwriting a posted unissued gift without a reason/before-value, Dashboard future-cutoff mismatch, and Cash auction receipt benefit-field rejection. Treat these as donor/operations handoff risks and use the finance report's reproductions; this review does not supply additional execution proof. Security reported a trailing-slash receipt-void guard bypass and is implementing a guard/regression separately. Do not treat that pending fix as resolved by this read-only report.

Before operational acceptance, the buyer's fundraising lead, grant owner, volunteer/event coordinator and finance/communications owner should each perform the corresponding real-data journey above, including one rejection, correction, void/reopen or cancelled obligation. Implementation staff must identify who does manual fulfillment, who approves wording/data access, where the evidence is retained and who resolves an incomplete handoff. The PM owns conversion, training, exceptions and signed acceptance; a passing local suite cannot supply those responsibilities.

Provider delivery, peer-to-peer ownership/public fundraising, online collection, actual Mailchimp conversion, historical contracts conversion and staffed delivery/support remain material disclosed gaps. SMS and AI are optional. No qualified reference, hosted service, external submission, real tax receipt, physical print/hand-sign, payment settlement or district approval is established by this review.
