# Wimblo — multidisciplinary business review and release gates

September 13, 2026. Review baseline: local Wimblo 0.5.0, commit 9736783d043a80f8d9fefd300fbe0298a3051e1e. This review supplements the 84-criterion inventory; it does not award points or change its classifications.

## Review coverage

Earlier engineering/control/security reviews tested financial behavior, but a dedicated nonprofit finance/controller opinion had not been completed. Three role-specific SME agents now review independently, with the project owner connecting their findings and verification requirements. These are AI-assisted SME reviews, not an engagement or signoff by a licensed outside CPA, attorney or auditor.

| Discipline | Business responsibility | Review artifact |
|---|---|---|
| Nonprofit finance / controller | Donor/source attribution, exact cents, cash and noncash, fees, soft credits, commitments versus realized receipts, fiscal periods, correction provenance, receipt benefits, reconciliation and duties | [FINANCE-SME-REVIEW.md](FINANCE-SME-REVIEW.md) |
| Fundraising / grant / volunteer / event operations | Lifecycle transitions, owners, evidence, notifications/consent, completion and reopening, participation/admission, fulfillment, cross-module user journeys and source history | [OPERATIONS-SME-REVIEW.md](OPERATIONS-SME-REVIEW.md) |
| Security / data / storage architecture | Tenant/role/current and historic access, database/file consistency, keys, recovery, retention/exit, object-storage production gates, AI boundaries and RFP security evidence | [SECURITY-DATA-SME-REVIEW.md](SECURITY-DATA-SME-REVIEW.md) |
| Project owner / solution architecture / QA | Connect each business finding to actual API/UI behavior, avoid duplicated or incompatible rules, identify regression evidence and sequence release blockers before optional addons | This register and the exact requirements matrix |

All three reviewers inspect actual source/tests and use primary authoritative sources for applicable current accounting/tax/security/product claims. A screen or passing engineering test cannot establish an organization's accounting policy, signed contractual commitment or certification.

## Financial product boundary

Wimblo currently stores operational CRM gifts, source receipts, allocations, commitments and activities. Saved gift status Posted is an application record state; it does not prove processor settlement, bank reconciliation or a general-ledger posting. Designation/account-code allocation is not a double-entry accounting ledger. Buyer Q&A permits outside-CRM reconciliation; a future accounting connector must maintain a separately approved source/mapping/correction contract.

Major asks, planned instruments, matching targets, grant awards, sponsorship prices and auction bids remain separate from actual posted receipt associations. Soft-credit/household/organization recognition can overlap and must not be added as new income. Receipt documents and file versions support evidence; they do not determine a deductible amount or convert a commitment into cash.

## Findings and disposition

All three independent reviews are complete. Finance and security findings include isolated synthetic API reproductions; the operations findings are source-derived workflow observations with proposed acceptance journeys. The review artifacts distinguish each kind of evidence.

| Finding | Disposition |
|---|---|
| Generic correction of an unissued gift overwrites previous financial facts, while update audit lacks a reason and before/after values | Repaired locally: required reason, immutable before/after financial facts, source references, actor/time and connected correction/reload/history UI. Actual synthetic correction observed; approval duties remain buyer policy. |
| Dashboard uses future-dated posted records as contributions without the cutoff applied by as-of reconciliation/analytics | Dashboard repaired locally: explicit UTC as-of cutoff, matching monthly drill-through and separate future-record review. Other summaries still require their own scope review. |
| Cash ticket/auction payment can have actual goods/services benefits, but cash receipt preparation cannot accept benefit disclosures | Repaired locally: explicit staff payment classification and goods/services assessment; linked Cash ticket/auction requires benefit evidence. Source/link changes invalidate preparation; active issued receipt blocks new event payment links. Organization wording, valuation and legal/tax policy remain unaccepted. |
| Active issued receipt gift-void protection can be bypassed with an accepted trailing slash | Fixed locally. Explicit operation and core mutation guards reject plain, encoded and trailing-slash variants without changing source, receipt or successful-void audit history. The full mounted suite passed 326/326 tests, zero failures/skips, including the new regression. Both local servers were restarted with this fix. |

The grant workspace now consumes the authorized exact grant/kind/date milestone state, displays completion and restores unresolved obligations on reopening. This has regression evidence; it does not establish external submission. The subsequent parallel operations pass repaired reasoned major-ask stage/follow-up and queue completion, ticket cancellation/restoration and administrative attendance correction, canonical seating versus legacy notes, exact-wording manual correspondence completion, unsent tribute withdrawal and current-account task ownership with retained transfer history. Financial corrections and these new retained histories have curated reporting and current-source provenance. Specific synthetic screen journeys are recorded in [CORE-READINESS-REPORT.md](CORE-READINESS-REPORT.md).

Paid/refund/fulfilled commitment corrections, externally sent notification handling, and adopted notification/escalation/coverage policies remain separate open decisions. The original operations review is retained as the historical finding baseline; its existence does not imply its proposed journeys are all complete. A unified donor timeline is an enhancement rather than an invented mandatory RFP requirement.

Security production gates remain recovery-capacity headroom, approved retention/disposition and legal holds, privileged MFA on both administrative planes, agreed helper scope and export/off-host audit evidence. Private object storage and Neon business migration are proposed architecture, not installed services.

[Financial control closure backlog](FINANCIAL-CONTROL-CLOSURE.md) assigns implementation outcomes and acceptance journeys. This review does not change the 46 locally implemented / 24 partial / 11 missing / 3 external-evidence inventory.

The preceding core closure checkpoint passed 341/341 tests. The connected-workflow checkpoint passed 372/372 tests; the subsequent integrated pass passed 386/386 mounted tests, zero failures/skips, with a successful build. Unpaid auction reopening/sponsor cancellation-reopening, a scoped source-linked constituent timeline and exact major follow-up intelligence are also repaired locally. Independent chief solution-architect source review corrected unusable timeline endpoint metadata and exposed retained fulfillment in reports, then found no remaining confirmed local blocker in its assigned scope. Paid/fulfilled/default/withdrawal/sent policies remain separate. [CORE-READINESS-REPORT.md](CORE-READINESS-REPORT.md) records actual screen evidence, remaining limitations and handover gates. These repairs do not change the criterion inventory or constitute professional signoff.

No open finding is silently promoted to complete because a document was written. A local fix must have meaningful tests; source changes do not retroactively establish the old review package's acceptance.

## Expert acceptance required to close

For each relevant module, retain the reviewer input, business policy, rule/transition implementation, allowed and denied role journeys, and correction/recovery evidence. The organization approves receipt identity/wording/benefits, noncash and payroll policies, fiscal reassignment, designation/restriction mapping, planned/matching eligibility, reconciliation and financial approval responsibilities. Security/operations owners approve current and historical access, recovery and retention/exit behavior. Procurement confirms qualifications, costs, support and contractual evidence independently of product functionality.

The provider/product three-year experience and comparable reference gate remains outside the 84 scored entries; multidisciplinary review cannot create or waive it. Real-data migration and hosted operations remain unaccepted. Optional intelligence and presentation improvements follow required business/control closure.

## Production-hardening engineering review

Parallel identity, document/storage and recovery teams completed tested local controls. Final integrated 445/445 tests and 1.14s build passed. A new independent solution-architect review reproduced and then rechecked the repaired successful-upload orphan-provenance defect; scoped final review found no new confirmed material defect in the inspected changes. Live provider operations, buyer acceptance and external professional/compliance approval remain separate. See PRODUCTION-HANDOVER.md for exact scope and outstanding gates.
