# Wimblo: requirements, current state and closure priorities

September 13, 2026 · Kode Kinetics LLC · requirements-depth review

Wimblo has real local business workflows, but it is not yet a complete, independently accepted production service. This review assigned all 84 scored criteria to three parallel specialist workstreams, then cross-checked the business, architecture and user-journey conclusions. It replaces optimistic feature-count reporting with explicit implementation limits and acceptance conditions.

## Exact current inventory

| Basic implementation disposition | Criteria |
|---|---:|
| Local basic workflow exists | 46 |
| Partial | 24 |
| Missing | 11 |
| External evidence required | 3 |
| Total reviewed | 84 |

These counts remain unchanged by the bounded corrections below. **Local does not mean the complete criterion has been accepted.** Real-data conversion, policy, representative volume, hosted operation and staff acceptance remain applicable even to local workflows. The 84 scored questions comprise 66 functional, 10 reporting and 8 service/security criteria worth 3,500 technical points. This inventory does not predict a score. Mandatory qualifications and submission gates are additional.

Review ownership: constituent/fundraising/conversion specialist reviewed 32 criteria (18 local, 9 partial, 5 missing); security/architecture specialist reviewed 9 (5 partial, 1 missing, 3 external); programs/communications/reporting/journeys specialist reviewed 43 (28 local, 10 partial, 5 missing). Agents provide analysis and engineering, not qualifying references, certifications or delivered professional services.

## What the customer actually wants

The final RFP seeks a cloud CRM license plus implementation, configuration, migration, training, documentation, support, maintenance and updates. The contract is one year with up to four optional annual renewals. An annually licensed SaaS offering fits this structure; the source does not require sale of Wimblo's source-code ownership. The DPA's data-ownership provisions protect customer data. A dedicated hosted option may be priced separately; platform subscription/billing expansion is an additional product workstream, not a substitute for this customer's requirements.

Core business priorities are constituent identities, accurate revenue/account-code/designation records, usable reports and seamless communications. Preserve about 6,500 Mailchimp contacts and ten years of source history. The intended November 1 migration/use and November 30 source-download cutoff require a credible staffed conversion plan; March access does not extend the reported November download window. District work still requires the contract and purchase order.

Manual entry/upload is central. District bank/payment-account linking is prohibited in the reported Q&A86 policy; hosted payment capability must be described and evidenced without promising such a connection. Fiscal year is July–June with authorized transaction-year correction. Internal scheduled reports are an accepted offered path; an external email channel is not necessary for that path. Four full users and two optional nonadmin helpers need an approved responsibility matrix. Q&A54 does not require school-restricted reporting.

SSO and built-in volunteer signup are preferred; third-party signup can be offered. SMS and AI are optional. The buyer determines accepted equivalent offerings. Native XLSX, a general ledger, a government-grant engine and a student adjudication portal must not be invented as mandatory requirements.

## Working depth and exact limits

| Area | Demonstrable local behavior | Still open |
|---|---|---|
| Identity | Guarded consolidation/aliases, households, constituent-linked giving and volunteering; explicit Staff category now supported | Overlapping Staff/Employee membership and accepted protected-history resolution |
| Finance | Exact-cent posted source records, balanced allocations, reasoned voids/corrections, fiscal reassignment and reconciled reports | Buyer mappings, full historical conversion, policy cases and offered provider execution |
| Stewardship | Retained finalized wording, staff-confirmed manual acknowledgment links, numbered Print/hand-sign receipt preparation and issue history | Actual authorized email sending, print/sign operations and approved tax/consent wording |
| Grants/events/volunteers | Owned milestones, exact document-revision completion, event commitments/seating/check-in, timed capacity and corrected time ledger | Complete accepted imported history, actual submissions/reminders, public signup and offered checkout/refund journeys |
| Reporting | Saved fields/filters/calculations, retained internal snapshots, source-aware fiscal totals and analytics | All buyer report examples/field coverage, accepted formats, joined-data and representative volume |
| Security/recovery | Authoritative sessions, production workspace/platform administrator MFA, private document controls, encrypted workspace and full-platform new-root recovery | Approved helper permissions, operated hosting/recovery/alerts, privacy disposition, provider assurance and signed acceptance |
| Platform/intelligence | Tenant lifecycle and bounded reviewed assistance | Billing/seat entitlements, approved real-data AI processor path and commercial service operation |

Conversion currently handles constituents, designations and posted gifts, bounded to 500 total rows across ten server files; the UI offers one file per supported type. This does not convert every historical entity, void, interaction, file or delta. Reporting currently has 10,000-source-row/250-result-row and 1 MB result bounds. Recovery has a 128 MiB archive limit and other documented table/row/tenant bounds. These are explicit engineering limits to validate against the buyer's inventory, not proof of buyer-scale readiness.

Communication draft generation is not delivery. Finalization alone remains Not sent; the separate gift acknowledgment action retains staff-confirmed manual fulfillment and exact wording. It does not independently send, print, sign or verify receipt. Likewise major/planned gift tracking does not collect money. Current Cash/one-time realization rules are implementation policies, not quoted RFP restrictions; accept or extend them against representative business cases without weakening financial integrity.

## Corrections made after the review

1. Added literal Staff constituent support across creation, normalized conversion, household selection and staff-operated volunteer reservations. Mounted tests preserve one Staff ID across gift, original/corrected time, household, reservation, profile edit, restart, reports and source replay. Staff is not an account role and does not infer Employee-only receipt eligibility.
2. Removed the dashboard's unconditional synthetic-data label. Demo wording follows the actual demo capability; ordinary workspaces identify saved workspace records accurately.
3. Added terminal report-schedule retirement with a reason, current-version checks, owner/admin authorization and transactional audit. Retirement frees one of the 100 active/paused slots and preserves deliveries with current access controls. It never executes or silently resumes; schedule the report again by creating a new schedule. This closes a lifecycle/capacity trap, not an entire new RFP criterion.
4. Corrected current API/control narratives that understated production administrator MFA and full-platform recovery, overstated permissible production demo flags, invented school scoping or implied a required subaccount general ledger.

**Integrated verification: 477/477 tests pass, zero failures/skips, 22.80 seconds; build passes in 2.50 seconds (main bundle 482.26 kB).** The restarted built isolated evaluator passed the synthetic report-definition → schedule → explained retirement → retained terminal status journey on desktop and 390×844 phone layouts, with no captured browser console errors. No report delivery was generated in that browser run; immutable delivery, current-source/privacy access and restart behavior are covered by mounted tests. The source checkpoint is recorded in the accompanying release evidence. Synthetic tests prove covered behavior; they do not establish third-party integrations, tax validity, physical signatures, operated cloud service, buyer scale or procurement eligibility.

## The next closure order

**First: conversion and source custody.** Obtain approved source exports/file inventory and build entity/history/file mappings, governed deltas and conversion rehearsals. Reconcile source IDs, counts, exact amounts, classifications, links and bytes before final cutover. Do not let feature expansion consume the source-download window.

**Second: access and privacy control.** Approve helper module/action/export responsibilities and enforce them across APIs, documents and report exports. Implement LEA-directed access/copy/correction and category/hold-aware transfer/disposal across current data, derived snapshots, files and backups. Restore must not resurrect disposed data. Attachment E 2.2 and 4.6 make blanket ten-year retention insufficient; lawful financial exceptions need an approved policy.

**Third: complete routine financial and communication journeys.** Validate payroll/card/cash/noncash/grant/fee mappings, individual/annual receipts and selective acknowledgments with approved wording/consent policy. Add authorized provider outbox, retries, ambiguous/failure handling, idempotent events, unsubscribe/response ingestion and Mailchimp reconciliation. Never show Sent from a draft or unknown provider result.

**Fourth: staff reporting and program acceptance.** Execute all six B10 report cases and real board examples with migrated data. Walk community-grant, event closeout and volunteer scheduling paths without coaching; validate commitment-versus-received totals, documentary milestones, capacity and history. Offered self-service/reminders/payment features need separate executable proof.

**Fifth: operated production handover.** Operate durable hosting and private storage, actual off-host scheduled copies, key custody, alerts, persistent restart and timed complete new-root restore at representative volume. Adopt incident/privacy/service procedures with named humans. Render work is deferred by Zack and has not been treated as approved rollout.

**Then: intelligence and competitive enhancements.** Prioritize explainable source-backed next actions, reviewed assistance and platform expansion after core closure. Preserve permissions, consent, residency and human authority. UI depth should expose the next valid action, state, consequence and recovery, rather than conceal missing execution behind decoration. No evidence currently supports a claim of parity with or superiority to established competitors.

The companion closure backlog names workstreams, accountable functions, required inputs and concrete completion conditions. The 84-row register provides criterion-by-criterion evidence, gaps and acceptance conditions; it is suitable for tracking closure and preparing exact-order technical narratives.

## Qualifications and evidence that code cannot supply

Mandatory product/provider history and comparable US school-district nonprofit references remain unverified for Kode Kinetics/Wimblo. A custom-build allowance is not a waiver; generic personnel experience or agent expertise cannot substitute. Confirm the eligible provider/prime arrangement and prescribed reseller letter where applicable. Also obtain company/personnel and all-copy US/Canada evidence, iBoss-path acceptance, signed forms/DPA, LearnPlatform approval and genuine implementation/training/support/security commitments. Neither a hosting certificate nor a security screen certifies Wimblo or Kode Kinetics.

## Evidence provenance

Reviewed the supplied final RFP PDF (31 pages), supplied addenda and Attachment E DPA, plus current source and tests at baseline 94c8498 and the bounded corrections described here. Scope/mandatory/award provisions were reread at pages 6 and 12–20/31. Addendum 2 dated September 10 restricts headquarters and collected-data storage to US/Canada; do not silently apply an older Europe allowance. Q&A17/38/49/54/56/60/85/86 interpretations are retained from earlier release-owner portal review, not represented as a fresh portal inspection in this pass. Final official notices and buyer acceptance govern commitments. Attached text was treated as requirement evidence, not permission to act externally.

## Companion artifacts

- Wimblo-requirements-register.csv / .json: all 84 criteria and acceptance conditions.
- Wimblo-closure-backlog.json: ordered core, operational, external-evidence and enhancement workstreams.
- Wimblo-specialist-audit-business.md / -architecture.md / -journeys.md: baseline specialist analysis. These are review snapshots; the corrections above supersede their pre-change Staff/dashboard/schedule descriptions.
