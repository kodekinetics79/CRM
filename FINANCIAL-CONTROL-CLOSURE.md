# Financial controls — SME findings to implementation acceptance

September 13, 2026. This is the implementation/acceptance backlog from the dedicated SME review, not a claim that these controls have shipped or that Wimblo is a general ledger.

## Required control fixes before finance acceptance

| Priority | Business rule | Acceptance journey |
|---|---|---|
| P1 | Financial correction must preserve original and replacement facts, source versions, actor/time and a meaningful reason | Correct an unissued 100.00 gift to 120.00 with valid split allocations. Original and replacement donor/date/value/splits remain reconstructable. Missing reason, stale version or bad splits fail without partial data/history. Active issued receipt facts remain protected until its separately reasoned void. |
| P1 | A gift cannot be voided while its receipt remains actively issued, regardless of accepted route spelling | Plain, encoded and trailing-slash void routes return denial with no source, receipt or successful-void audit change. Voiding the receipt releases the gift only through normal versioned controls. Core mutation also rejects alternate source-status rewrites. |
| P1 | Receipt benefit disclosure must follow the actual transaction, including approved cash event cases | A cash auction or ticket payment with goods/services accepts explicitly reviewed benefit evidence and wording. No computed deductible amount, invented fair value or automatic donation classification. Sponsorship and noncash cases remain distinct; correction and reissue preserve original disclosures. |
| P2 | Every financial summary declares the same date/status scope or clearly explains a different recorded-value view | Today’s received totals exclude tomorrow’s recorded gift. Future records stay visible as future-dated records. Dashboard, analytics, campaign, grant/pledge and event views can explain and reconcile any differences by fees/noncash, source links, period and original date/fiscal override. |
| P2 | Grant due/completed state must be consistent across the grant workspace, milestones, Operations and intelligence | Completing a milestone clears only its exact grant/kind/due-date obligation everywhere. Reopening restores it. Another grant/date/kind remains unresolved. Private history cannot disclose completion or silently clear an obligation for an unauthorized user. |

The issued-receipt route/core guard is **implemented locally and verified by 326/326 mounted tests**, including plain/encoded/trailing-slash variants. The subsequent 341/341 suite verifies reasoned immutable financial corrections, staff-reviewed Cash benefits and event/receipt source guards, exact Dashboard cutoff/drill-through, and grant-workspace exact milestone completion/reopening. These are locally implemented repairs. Cross-view financial scope review, approval duties, organization receipt/valuation policy and buyer acceptance remain open. See [CORE-READINESS-REPORT.md](CORE-READINESS-REPORT.md) for proof and limits.

## Policies and remaining model depth

Agree finance approvals and helper permissions before adopting a two-person approval workflow. Current broad administrator/staff/viewer roles do not establish segregation of duties. Keep client policies for restrictions, conditional commitments, planned-gift eligibility, matching claims and benefit disclosures distinct from general ledger recognition rules. School/fund designation is not sufficient proof of restricted-fund accounting.

Define cancellation, withdrawal, financial adjustment and reopening for sponsorships, auction winners, finalized tribute notifications and major/planned commitments. Every release of a source lock must retain the original evidence and reason; a silent delete or overwrite is not a correction policy.

Maintain an explicit source reconciliation contract for payroll and external platform files. Preserve original external identity, source period, gross gift versus fees/settlement, duplicate handling and trial/delta/final reconciliation. The district's approved outside-CRM reconciliation path must not be replaced with an unapproved bank/account connection.

Database/object-store integration must preserve exact file version/checksum and tenant access while keeping failed/quarantined uploads out of completed financial/grant evidence. Restoring a database without its referenced file versions is not a successful full recovery.

## Signoff evidence

Link each code fix to the SME finding and meaningful regression results, then retain buyer accounting/operations policy and role acceptance separately. AI may explain or draft within approved scope; it does not approve financial corrections, tax treatment, signatures, settlements or receipt issuance. Current test counts are engineering evidence, not controller or legal signoff.
