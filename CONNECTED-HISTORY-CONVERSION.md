# Wimblo connected historical conversion

September 13, 2026 · implementation checkpoint after 64623da

This pass adds three bounded conversion capabilities and corrects campaign progress. It advances historical conversion; it does not certify a complete NonProfitEasy migration or production handover.

## Implemented

- Campaign source IDs, original start/end dates, type, status, description and exact decimal-dollar goals, including an explicit zero. Gift campaignSourceId resolves a campaign in the same batch or through an existing mapping in the same source namespace. Goals do not become gifts or received revenue.
- Historical interactions with an explicit constituent source ID, original calendar date, channel, subject, body and notes. Only Logged status, nonfuture dates and explicit accessScope=Workspace are accepted. These records are visible to existing workspace readers. Restricted source history needs a separate private path. Import does not send messages, change consent, complete acknowledgments or create delivery evidence.
- Optional constituent contacts mapping: JSON array of at most 50 strict name/email/role objects, preserving accepted strings and order. Use explicit [] for an empty mapped list. The JSON cell is limited to 8,000 characters; names with surrounding spaces reject instead of silently changing. Business contact titles do not grant account access or marketing permission.
- Campaign progress now uses lifetime posted monetary gifts through the displayed date. Future-dated gifts are identified separately; fees, noncash, voids and unposted records are excluded. Campaign dates describe the plan; original gift dates and fiscal assignment remain unchanged.
- The screen reviews all five supported record types, offers synthetic examples, and shows their saved reconciliation and source lineage. When one competing allocation column is wholly blank, suggestions use the populated column. Mixed allocation columns still require explicit review.

## Verified

The combined suite passed **504/504**, zero failures, cancellations or skips, in **17.91 seconds**. The production bundle built successfully in **2.13 seconds**; main bundle 484.08 kB. These are local correctness and build results, not production capacity benchmarks.

Fifteen new mounted conversion tests cover campaign links, dates/goals, explicit shared-history classification, strict contacts, permissions, source conflicts, current lineage, replay/restart, dependency changes and injected transaction failures. Existing golden constituent/gift fingerprints and original three-key reconciliation shapes remain compatible when new optional mappings/files are absent. Four campaign calculation tests and the UI mapping regression verify the financial exclusion and suggested-mapping changes. Separate architecture and business reviews found no blocking defect in the stated scope.

Browser verification used only isolated synthetic data. Five files staged in mixed order created one Business constituent, one designation, one historical campaign, two gifts and one historical phone interaction. Saved value and allocations were **$173.45**. Campaign and constituent totals correctly showed **$123.45** through September 13, 2026 and kept the **$50.00 future-dated gift** separate. The contact title and Do not contact preference reopened intact; the 2016 interaction retained its date and was labeled recorded history without inferred delivery. Re-upload and confirmation returned the saved batch with no duplicate records. Saved lineage showed six unchanged records. Both reconciliation tables fit a 320-pixel content area at a 390 × 844 viewport. No captured browser warnings or errors occurred.

## Still open

The 84-entry inventory remains **46 local basic, 24 partial, 11 missing and 3 external evidence required**; no criterion is marked accepted by the buyer. C1 historical conversion remains partial. No actual ten-year customer export has been converted.

Source originals, checksums/private custody, additional identity/household/consent history, grants/pledges/commitments, financial void/refund/correction and fiscal-reassignment histories, receipt/acknowledgment/delivery evidence, volunteer/event ledgers, documents/revisions, governed delta/cutover and buyer-volume reconciliation still require dedicated mapping and acceptance. Original interaction actors/timestamps beyond the supported calendar date are not reconstructed. Limits remain 500 total rows, ten server files, 500 KB per CSV, 30 columns and a 2 MiB serialized request.

Production hosting, adopted identity/helper policy, actual provider delivery, recovery/key/retention operations, staffed services and qualification evidence remain separate open work. Render deployment is deferred as requested. No production rollout or live payment/message processing was performed.

The next engineering check is exact supported-field and dependency equality after persistence, so financial reconciliation cannot hide a changed contact, interaction or relationship. Optional helper access also needs a narrowly authorized workspace; assigning helpers full staff financial access is not an acceptable substitute for a reviewed policy.
