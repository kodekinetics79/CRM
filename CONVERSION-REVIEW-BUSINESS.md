# Migration next closure: financial and business meaning

Read-only independent review, 13 September 2026. Sources inspected: current `server/migration.js`, `server/app.js`, `server/financialCorrections.js`, `src/schema.js`, migration test scenarios, existing finance review and the current RFP matrix/Q&A. No application edits, tests, build, cloud calls or commits. Old finance review findings are historical observations; current financial correction controls supersede its former missing-before/after finding. This artifact is conversion guidance, not tax/accounting policy or an acceptance claim.

## Exact current conversion scope

The migration supports normalized constituents, designations and gifts only, with at most 500 combined rows per request. Source namespace, file key, source row IDs, mapping, content fingerprint, preview digest, retained batch result and row-to-record mapping give meaningful lineage. Repeating an identical committed batch returns its original result without posting another gift. Changed source IDs or previously changed mapped records require reconciliation; this is not an upsert/synchronization tool.

Financial controls distinguish all/new/reused rows and exact totals by revenue class, method and designation/account code, then compare actual persisted postings with the plan transactionally. This catches equal-grand-total misclassification. The batch's original reconciliation remains historical after authorized changes; batch-detail current lineage separately reports Unchanged/Changed/Missing. Indexed keyset list pagination now supports bounded access to older batches. None of these controls proves that the external source is complete or correctly classified.

Current source constituent types include Individual, Business, Foundation, Alumni, Employee, Staff and Community partner. Any earlier six-type inventory omitting Staff is stale. A constituent has one principal type; volunteer participation is a linked volunteer relationship, and administrator/staff/viewer login permissions are separate accounts. A person who is Employee and Staff and a donor and volunteer still needs an agreed principal classification/additional segment or relationship policy. Do not create duplicate identities to encode every business role or infer application authority from constituent type.

Constituent import sets contacts to an empty array. Multiple organizational contacts and managed household membership are not converted by the existing household text field. Preference defaults to Email when unmapped. That default is a contact-channel selection, not independently established marketing consent. Migration preparation must preserve authoritative opt-outs; no Mailchimp sending or subscription enrollment should be inferred from absent preference data.

Current gift payload sets campaignId, pledgeId and grantId to null and pledge text empty. GiftKind can record Recurring/Pledge fulfillment/Matching gift/Planned gift classification but does not establish its parent commitment, actual subscription or matching claim. Tribute text is not a structured honoree/notification record. There is no mapped source status, source void/refund/correction history, acknowledgment, school-year override or issued receipt. Accepted positive gift rows become posted records under the ordinary creation contract.

**Required preparation restriction:** do not include legacy voided, reversed, refunded, negative or historical-version rows in the posted-gift file. There is currently no source-state field to preserve their meaning. A positive legacy void row normalized as Cash would become current revenue. This is an unsupported conversion boundary, not evidence that source files currently contain such a row. Retain them in a separate reconciled exception/history inventory until a supported historical-state converter is designed.

## Semantic boundaries that conversion must preserve

| Business fact | Correct conversion meaning | Unacceptable shortcut |
|---|---|---|
| Posted source gift | One recorded financial source with original transaction date, exact cents, classification and allocations; bank settlement remains external evidence. | Treat CRM Posted as bank-cleared or import processor and NonProfitEasy copies as two gifts. |
| Grant request / award | Request, known evidenced award and received eligible gifts are separate facts. | Import requested amount as award or award as a second Cash gift. |
| Pledge / major ask / planned commitment / matching claim | A promise or ask, with historical status/activity and actual existing receipt associations kept separately. | Import commitment totals as received money or create new gift rows for linked historical receipts already present. |
| Source void | Original source plus retained exclusion/reason/time/actor/reference if available, distinct from current receipt-document void. | Replay a legacy void as today's staff action or call the current void endpoint with invented reason/date. |
| Financial correction | Exact original and changed cents/date/allocations, source versions and factual historical provenance if available. | Fabricate prior versions or mark today's migration actor as the original finance actor. |
| Refund/chargeback | Actual gross transaction and externally authoritative refund/adjustment evidence, approved net reconciliation policy. | Whole gift void as proof of bank refund, negative gift normalization, or reducing original amount without retained evidence. |
| Employee giving | Revenue type and Payroll method when actually supported by source, independent of Employee/Staff identity category. | Identify every Staff donor as payroll or move payroll into a school-year annual employee receipt. |
| Volunteer hours | Historical undated balance or original dated intervals, correction lineage and shift/attendance independently mapped. | Create present-day clocks, duplicate the historical total plus intervals, or infer volunteered time from event admission. |
| Interaction / acknowledgment | Original dated staff interaction and acknowledged state, with exact source reference if supplied. | Use the normal current acknowledgment action to invent a migration-time completed interaction. |
| Correspondence fulfillment | Exact retained reviewed preparation/digest/template/source plus factual manual completion linkage. | Claim legacy email was sent by Wimblo, human-reviewed today, or delivered because source says Finalized. |
| Issued tax/print receipt | Historical identifier, recipient, wording/profile, coverage, issuance/void/reissue chain and actual original facts. | Allocate fresh Wimblo numbers to historical tax documents, claim approved tax status, or count repeated receipt coverage as new gifts. |
| Source timestamps/actors | Source facts are explicitly distinguished from importedAt/importedBy and current local revision. Unknown stays unknown. | Backdate today's audit or create account credentials for historical actors. |

Current ordinary gift corrections now require a reason, preserve immutable before/after financial facts and referenced source versions, and retain source deletion protections inside the transaction. These controls cover post-import local corrections; they do not recreate a source's missing historical versions. The current full gift void is a recorded source exclusion, not an executed payment refund. Receipt issue/void/reissue, tribute withdrawal, sponsor/auction reopen and acknowledgment are separate controlled states; conversion must not collapse them into one generic status.

## Defensible ordered next entity slices

Do not start every table independently. Each slice needs an explicit source schema, supported states, reference dependencies, immutable source lineage, transaction boundaries, rollback/replay rules, current-versus-retained semantics and source-independent financial controls. The order below prioritizes required November core continuity and shared dependencies; actual source inventory may change the order.

### 0. Source inventory and posted-only acceptance gate

Before adding entities, obtain authorized export samples and independent source reports, including void/refund/version counts, transaction IDs shared between systems, opening balances, last export dates, file/document inventory and Mailchimp consent/history. Define which rows constitute posted original transactions, exclude duplicates and unsupported states, preserve raw exports privately and reconcile every exception. Establish source namespace strategy so the same payment exported by two products cannot evade deduplication merely by having two namespaces.

### 1. Campaign reference conversion, then exact gift linkage

Campaigns are a small referenced entity with name/type/goal/date/status. Add stable source-ID mapping and preserve archived/completed campaigns. Gift-to-campaign association can then remain factual rather than forcing every legacy gift into campaignId null. A campaign goal is not financial income. Accept totals by source campaign as well as donor/type/account code. Do not implement provider subscriptions or public peer-to-peer as part of simple campaign migration.

### 2. Historical financial state and period classification

Close original posted-versus-voided/reversed transaction inventory and explicit school-year assignments before claiming full fiscal revenue/history conversion. Preserve original transaction and known source state, reason, original actor/time and source record identifier; retain today's import audit separately. Import unknown source details as explicitly unknown, not fabricated. Source corrections require separately designed immutable factual history, not replay of ordinary PATCH operations.

Refund/chargeback conversion remains blocked on actual export facts and accepted reconciliation policy. A bounded historical-state adapter must not silently introduce a new partial-refund ledger or processor collection. This slice is likely essential for accurate historical reports, but the actual source inventory must demonstrate which states exist.

### 3. Community grants and pledges, then receipt associations

Convert funder-linked grants with requested amount, known evidenced award/date, stage/deadlines and source documents; convert donor-linked pledges with agreed installment schedules/current historical status and designation/campaign. Only then associate existing imported gift IDs using actual source foreign keys and approved receipt compatibility. Reconcile requested/awarded/committed/received/outstanding separately. A campaign/gift/pledge donor mismatch or missing known award must remain an exception; do not synthesize a record solely to make totals balance.

Major/planned/matching records follow as a separate bounded extension: original gift and organization references, ratio/cap policy, owner/history, statuses and receipt associations require source-specific evidence. They cannot be reconstructed from giftKind alone. Original unknown installments/ratios must not be guessed from aggregate balance.

### 4. Constituent contacts, households and dated interactions/acknowledged state

Convert additional organizational contacts, real managed households and relationship identities without duplicate profiles. Preserve original interaction date/channel/body and known actor metadata. Acknowledged source gifts require a historical linkage adapter rather than a new current completion. Existing exact reviewed correspondence fulfillment should remain reserved for an actual Wimblo preparation; source acknowledgments can have distinct source provenance without invented Wimblo preparation digests.

Mailchimp audience/consent/history deserves its own parallel integration/conversion acceptance track because communications continuity is a buyer priority. Consent field mapping, opt-out authority and deletion expectations must be approved before any future sends. Storing tags or Logged interactions does not substitute for Mailchimp response/history conversion.

### 5. Historical protected files and grant contracts/evidence

Map each attachment to source entity, category, original file revision if actually supplied, visibility, original dates and retention/legal hold. Verify exact bytes/digest/size and authoritative private object reference. Import files through a trusted historical adapter with today's import audit, not fabricated Final/Submitted or staff-confirmed completion metadata. Original signed contract/report may be evidence; a file alone does not establish a submission/approval date. Reconcile file counts, missing files and revision chains, then prove new-root database-plus-object recovery.

### 6. Volunteer/events and retained operational history

Convert volunteer profiles/skills, historical undated or dated hours and accepted event roster/attendance/shift source states. Import current totals and source intervals only after determining whether totals already include them. Then migrate ticket/seat/sponsor/auction history and manual gift links if actually available. Retain original bids/benefit fulfillment and original promise values, with active commitment separated from cancelled promise. Do not turn incomplete source history into new immutable bids, admissions or present-day verified staff actions. Generic event metadata can precede detailed operations, but advertise only the layer actually converted.

## Buyer/source decisions required before implementation

- Exact NonProfitEasy export layouts and availability for transactions, corrections/voids, contacts/households, campaigns/pledges/grants, interactions, contracts/files and events/volunteers; what cannot be exported before the November deadline?
- Finance-approved revenue/method/account-code mapping for SchoolWindows, Successfund, payroll and NonProfitEasy. Are source amounts gross, net, fees or noncash values? Which external transaction key identifies the same payment across products?
- Source void/refund/correction semantics, original dates/actors/reasons, opening balances and retained unknowns. Does the buyer need individual historic versions or an accepted signed source archive plus current state?
- July–June school-year override mapping versus actual transaction date; calendar-year annual employee statement criteria. Employee giving and constituent Staff category are independent decisions.
- Principal constituent category and overlapping roles; household recognition and multiple contact recipient policy; shared email/address reconciliation and alias policy for protected history.
- Authoritative marketing consent, missing consent handling, Mailchimp segments/subscription/status/delete history and recipient rules for transactional printed receipts versus marketing.
- Grant requested/award facts and dates, actual source pledge schedule/status, eligible association rules and known source links. Who resolves mismatches rather than approving synthetic inferred parents?
- Historical owner identity mapping: historical actors need retained attribution, not new live accounts. Unmatched current responsibility requires explicit assignment and current account approval.
- Document visibility, retention, legal holds and signed-source preservation; actual file-size/type inventory relative to current bounded upload/recovery limits.
- Representative counts and largest annual/ten-year output. Accept the 500-row batch method and report 10,000-source/250-result/1MB limits only if complete controlled import/export is demonstrated; otherwise deliver a full-detail extraction path.

## Migrated report acceptance

Use independent source reports as the oracle, not importer-generated expectations alone. First prove completeness: every source entity/row/file is imported, explicitly excluded with reason, or retained in an approved exception/archive. Count source IDs and financial cents by fiscal period, actual date, donor, revenue class, method, designation/account code and campaign. Reconcile all/new/reused postings and cross-source duplicate candidates. Old source voids are excluded from current totals but retained; original/corrected versions and receipt reissues are not added as separate income.

Prove B10 with complete actual prior history: first-time classification depends on a donor's earliest qualifying gift, inactivity uses the agreed last gift/contact rules, and first/last dates must not become migration date. Prove grant/pledge/planned/matching receipts are the same posted gifts counted once, with award/commitment balances separate. Verify payroll calendar-year statements independently of school-year overrides; donor recognition/soft credits and household/subsidiary rollups must not multiply source gifts.

Inspect batch detail after a permitted local correction: original reconciliation remains factual history, current lineage shows Changed, and current reports use corrected eligible state with exact before/after reason/source evidence available. Exact replay must never restore an old source over an authorized local correction; new files require source conflict resolution. Test denied access, stale dependencies, malformed rows, changed mapping, missing parent, duplicate reference and mid-persistence failure without partial records/audit/mappings.

Verify report detail export is complete or explicitly segmented with conserved independent totals, not merely the first 250 rows. Scheduled outputs need snapshot time/definition/source meaning and current privacy rechecks; they do not prove emailed delivery. Finish with offline new-root database/file recovery and rerun the approved reports using the restored source inventory. Obtain named buyer finance/data/communications signoff for definitions, counts, differences and exclusions. Local functional tests and reassuring dashboard totals cannot establish migrated acceptance by themselves.
