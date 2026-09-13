# Wimblo 0.5.0 — nonprofit finance/controller review

September 13, 2026. Independent finance perspective on local source commit **9736783**. This is an analytical SME review, not a licensed CPA opinion, tax determination, audited financial statement or production approval.

Wimblo has useful controls for exact gift allocations, separate commitments and actual receipts, retained receipt corrections, and repeatable source-file reconciliation. It should currently be treated as a **fundraising CRM and operational gift register**. Three confirmed finance findings require correction or an explicit accepted operating restriction before finance relies on its outputs. Neither a manually posted gift nor a staff-confirmed receipt proves bank settlement, donor deductibility or accounting recognition.

The release owner reports **325/325 tests passed**, zero failures/skips, and a subsequent production build passed; see [CURRENT-RELEASE-EVIDENCE.md](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/CURRENT-RELEASE-EVIDENCE.md). Those checks precede this finance review and do not establish accountant or buyer acceptance. This review read the relevant source and existing tests, and used isolated temporary-data API checks for the three findings below. It made no application changes, issued no real receipt, contacted no external party and processed no payment.

## Confirmed business findings

Severity indicates financial handoff priority: P1 requires a repair or approved workflow restriction; P2 requires correction or an explicit presentation policy. These are finance conclusions rather than predicted RFP scores.

### F1 — P1: ordinary financial edits lose the previous financial facts

**Confirmed defect in correction provenance.** An ordinary gift that is not locked by an issued receipt or another specialized association can have its amount, transaction date and allocation changed through the versioned generic update. The record is overwritten and its update audit has empty details. There is no required financial correction reason or retained before/after financial revision for this path. Optimistic versioning prevents a stale overwrite; it does not preserve the original values.

Evidence: [core record persistence, line 89](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/server/app.js:89), [audit default, line 91](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/server/app.js:91), [updateSpecial, line 150](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/server/app.js:150), and the generic PATCH route at line 239.

**Reproduction:** create a $100.01 posted gift; PATCH version 1 to $100.02 with its matching allocation. Response is 200. The retained update audit details are `{}`; the original $100.01 source value is absent from this audit path. The same vulnerability in provenance applies to an otherwise permitted date or fund reclassification. This is an authorized-edit control gap, not a role bypass.

**Business impact:** finance cannot reconstruct why a previously reconciled total changed or distinguish a correction from the original recorded transaction using this history alone. A prior external export may be the only evidence.

**Required outcome:** reasoned financial correction with immutable, transactional before/after values, actor, time, record version and relevant source links. Preserve harmless note edits separately. Until then, require a retained correction register and finance review of changes to reconciled gifts; do not describe the current generic audit as a complete financial audit trail.

### F2 — P1: allowed Cash event payments cannot carry benefit details into receipts

**Confirmed receipt connectivity/control gap.** Ticket and auction payments may be linked to an existing Cash gift. However, receipt preparation accepts benefits description/value only for a Sponsorship gift. Cash receipts reject those fields and store `benefits: null`. Auction minimum price and winning bid are not a fair-market-value assessment.

Evidence: [event payment cases, line 60](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/server/eventOperations.js:60), [receipt type restrictions, lines 54–56](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/server/receipts.js:54), and [receipt snapshot, line 64](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/server/receipts.js:64). The receipt UI also submits benefits only for Sponsorship sources.

**Reproduction:** close a fictional auction with a $100.01 winning bid and link the winner's existing $100.01 Cash gift; link creation returns 201. Using a fictional explicitly approved QA receipt profile, preparing that Cash source with “Auction item supplied” and benefit value 10001 cents returns 400. Preparing the same source without benefits returns 201 with `benefits: null`. No actual receipt was issued or signed.

**Business impact:** staff can prepare a monetary receipt for an allowed goods-linked payment without recording the goods supplied through the structured receipt workflow. This is not a determination that any particular payment is deductible or that a legal violation occurred. An auction transaction might be wholly exchange revenue or have a charitable component; finance must classify the facts.

For a substantiating acknowledgment of a contribution of $250 or more, IRS guidance calls for cash amount or a noncash description without assigned value, and the appropriate goods/services statement or description and good-faith estimate. For a quid pro quo payment exceeding $75, separate disclosure requirements apply, subject to the IRS exceptions; the payment threshold is not merely its charitable portion. [IRS acknowledgment guidance](https://www.irs.gov/charities-non-profits/charitable-organizations/charitable-contributions-written-acknowledgments), [IRS quid pro quo guidance](https://www.irs.gov/charities-non-profits/charitable-organizations/charitable-contributions-quid-pro-quo-contributions).

**Required outcome:** capture an approved goods/benefits assessment for every eligible receipt type, including an explicit no-goods branch when true, or block charitable receipt preparation for goods-linked Cash sources pending classification. The same policy review should cover noncash contributions with benefits. Do not infer benefit value from bid price or calculate donor deductions automatically. A free-text footer is not a substitute for a controlled assessment.

### F3 — P2: future-dated gifts count in Dashboard contributions before current realization

**Confirmed inconsistent presentation; buyer policy must settle the intended basis.** Dashboard contributions and active donors include all nonvoid monetary gifts assigned to the selected school year, without an as-of cutoff. Current pledge, grant, planned/matching, event balances and fundraising analytics exclude future-dated receipts.

Evidence: [Dashboard, lines 9–17](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/src/features/Dashboard.jsx:9), [gift filters, lines 26–27](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/src/lib.js:26), [pledge cutoff, line 16](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/src/phaseTwo.js:16), [event cutoff, line 34](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/server/eventOperations.js:34), and [analytics cutoff, line 14](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/src/fundraisingAnalytics.js:14).

**Reproduction:** a posted Cash gift dated tomorrow for $123.45 contributes $123.45 to the Dashboard-used gift filter and sum, while its pledge received balance is zero as of today. No money is duplicated in storage, but screens disagree about current realization.

**Required outcome:** use a consistent visible as-of date for current contributions, or clearly label the Dashboard as recorded school-year gifts including future dates and show that amount separately. A future record can legitimately reserve commitment capacity without being presented as received today. Do not equate the final metric with cleared bank cash.

### Related P1 security finding — repair tracked separately

The security reviewer reproduced an active-issued-receipt gift-void bypass through a trailing-slash route, leaving the receipt Issued while the gift became Voided. The release owner/security reviewer are repairing explicit operation and core persistence guards. **This finance review did not independently reproduce or verify that later repair.** Baseline receipt tests pass ordinary-path locks; that evidence must not be generalized to every route spelling. Require the added regression and an independent direct check before closing this finding. This is separate from F1 and F2.

## Money semantics and controls that are useful today

| Workflow | Current operational treatment and supported control | Finance acceptance boundary |
|---|---|---|
| Gifts and splits | Positive integer cents; unique designation allocations must equal the gift total; valid references and versions; whole gift void retains the record/reason. | Posted means manually recorded. No bank-cleared status or settlement evidence. Agree gross/net and source-date policy. |
| Pledges | Installment remainders conserve cents, month-end anchors are stable, actual dated monetary receipts reduce balances, donor mismatch/overreceipt blocked. | Schedule is a collection view. It does not determine binding promise recognition, collectibility or discounts. Pledge designation is not enforced against each receipt allocation. |
| Grants | Requested amount, recorded award and actual grant receipts are distinct; award/funder/type/cap guards; milestone evidence retains immutable revisions. | Award or milestone completion does not determine accounting recognition, allowable spending or release of restrictions. |
| Major/planned/matching | Ask and commitment records do not create gifts. Existing compatible Cash gifts realize planned/matching records; future/void gifts excluded; matching ratio floors fractional cents before cap and exposes remainder. | Major “Closed” is still a prospect state without a native actual-gift realization link. Employer/program eligibility and acceptance terms require review. |
| Fees and noncash | Fee payments and In-kind excluded from contribution analytics; noncash receipt is description-only and does not assign deductible value. | CRM noncash gift amount is a recorded operational valuation, not an approved book or tax valuation. Fees are actual revenue of a different class, not processor expense records. |
| Soft credits and households | Recognition attribution is separate from the original gift; recognition groups deduplicate source gifts within their own group. | Direct and soft recognition groups are nonadditive. Never sum them to produce total revenue or issue a second donor receipt from recognition alone. |
| Event payments | Prices, sponsor commitments and winning bids remain distinct from money received; exact donor/amount/type and unique gift links prevent duplicate fulfillment; no gifts created automatically. | Benefits checklist is an operational promise, not tax or revenue classification. Cash auction/ticket receipt gap F2 remains. Refunds, withdrawal/reopen and partial adjustments need policy and additional workflow. |
| School-year overrides | Dedicated reasoned/versioned/audited assignment/reset preserves original gift date and cents; effective year used for fiscal reports; calendar dates retain cutoff/chart meaning. | School-year reassignment is a reporting classification, not a bank-date change or journal posting. Annual payroll receipts remain calendar-year based. |
| Receipt register | Explicit admin-approved profile; prepared snapshots; current-source digest checks; unique issued source/number; reasoned void and linked replacement; retained original facts. | Approval is a user attestation, not tax validation. Printing/hand-signing is staff-confirmed, not independently observed. Validate final physical wording, number and delivery against issued record. |
| Migration | Stable source mappings, preview/current-version checks, atomic commit/reconciliation, rollback and same-batch replay protection. | Normalized constituent/designation/posted-gift conversion is not full incumbent history conversion. Different source IDs without a common external reference can still describe the same payment. |

Evidence includes [receipt tests](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/tests/receipts.test.js), [event tests](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/tests/event-operations.test.js), [migration tests](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/tests/migration.test.js), [school-year tests](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/tests/school-year.test.js), and the source helpers cited above. These are local synthetic controls, not a signed reconciliation of buyer data.

## Buyer accounting policies and remaining product boundaries

**Recognition basis and donor restrictions.** Do not call all asks, awards or planned commitments accounting income, and do not say all income is recognized only on cash receipt. FASB's published explanation distinguishes contribution from exchange transactions, conditions from restrictions, and a barrier plus return/release right when assessing conditional contributions. That requires agreement-specific judgment. Wimblo does not model this recognition decision or post an accrual ledger. [FASB ASU 2018-08 explanation, summary pages 1–3](https://storage.fasb.org/ASU_2018-08.pdf).

Designations have name, school, hierarchy, account code and description ([schema, line 22](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/src/schema.js:22)); they are not a restricted-net-assets subledger. Finance must own the mapping to the authoritative accounts, donor-purpose documentation, approved reclassification and release decisions. If the buyer needs pledge-to-designation enforcement or grant-condition tracking inside the CRM, that is additional product scope; it should not be implied by a designation label or completed grant report.

**Segregation of duties.** Admin and staff both have the general financial write capability ([roles, lines 208–209](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/server/app.js:208)). Admin controls receipt profile approval, but the same staff actor may enter a gift and prepare, issue or void its receipt. There is no independent maker/checker release or accounting period lock. Viewer read-only permissions do not establish finance segregation. For a small team, agree a compensating treasurer/controller review with retained exceptions and signoff; introduce narrower financial entry/approval permissions if that operating model requires them. No additional employee role is inferred from constituent type.

**Reconciliation and refunds.** The supplied RFP Q&A49 explicitly allows manual CSV/Excel workflows and outside-CRM reconciliation of SchoolWindows/Successfund/payroll receipts; Q&A86 says the district processor cannot simply connect to a district Stripe account. These facts support a manual boundary, not a claim of automated bank reconciliation. See [current RFP matrix and buyer clarifications](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/CURRENT-RFP-REQUIREMENTS-MATRIX.md). Wimblo has no operational settlement/processor-fee/chargeback/partial-refund accounting path. Whole gift void is not a bank refund. A partial refund must preserve gross transaction, refund evidence and net reconciliation externally until a controlled native adjustment exists.

Custom reports are explicitly bounded ([report engine, line 2](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/src/reportEngine.js:2)); limited previews or truncated exports must not be accepted as complete reconciliation totals. Migration conserves newly created gift cents ([reconciliation, line 244](/Users/zackkhan/Documents/Codex/2026-09-13/enag/outputs/foundation-crm/server/migration.js:244)), but that does not prove source completeness, opening balances or cross-source deduplication. Require persistent transaction/source keys and an exception report for possible duplicate payments.

**Receipt wording and recipient policy.** Approve an actual organization profile and goods/services wording before live use; synthetic approval is not approval of a tax identity. Decide whether a donor's “Do not contact” preference should block a requested transactional receipt, which current preparation does, separately from marketing permission. Confirm physical issue/void/reissue numbering and recipient delivery in a supervised live acceptance exercise; no current browser QA demonstrates a real hand-signed delivery.

## Finance handoff gates

The following are proposed owners, not assertions that those people have been appointed.

| Gate | Proposed owner | Concrete acceptance evidence |
|---|---|---|
| Correction history and issued-source protection | Engineering + finance lead | Repair F1; retain original and corrected cents/date/splits with reason; direct regression checks for plain, encoded and trailing-slash routes; unchanged issued source until reasoned receipt void. |
| Event/noncash receipt classification | Finance lead + authorized tax adviser | Approved benefit/no-benefit cases, exchange-versus-contribution classification, representative receipt wording and F2 repair or explicit blocked workflow. |
| One set of current-realization totals | Finance lead + product owner | Resolve F3; test today/future/void gifts and exact school-year overrides using visible dates and explain every difference. |
| First import and period reconciliation | Finance lead + migration lead | Count and exact cents by source, revenue class and designation; duplicate/void exceptions; processor gross/net/fees and bank evidence; old-source opening balance and excluded-history signoff. |
| Operational control | Treasurer/controller + administrator | Named entry/review responsibilities, approved correction/refund/receipt policy, retained period export and signoff, access review and tested recovery. |

A useful acceptance pack should include a $123.45 split gift, pledge partial fulfillment, grant award without receipt, planned commitment without receipt, matching ratio remainder, Cash auction with benefits, Fee event payment, description-only noncash gift, soft-credit recognition, future-date cutoff, void/reissue and duplicate source replay. The expected result is **one actual source gift counted once**, exact conserved cents, clearly separate recognition/commitments, and a traceable explanation for every change. Accounting classification and bank settlement remain the buyer's authoritative finance process.
