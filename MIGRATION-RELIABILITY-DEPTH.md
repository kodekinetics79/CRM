# Wimblo migration reliability depth

September 13, 2026 · next core closure checkpoint

This pass used parallel conversion engineering, financial/business analysis and solution-architecture review to improve an actual staff workflow. It builds on committed baseline 6660e54. It does not claim full historical migration or production acceptance.

## Implemented

- Shared declarative collections, mapped fields, required fields and limits now drive the screen and server planner. Server schemas, financial validation, authority and signed preview remain server-side.
- Fresh preview plans snapshot each supported collection once and use normalized duplicate indexes rather than repeated collection scans and nested per-row comparisons. Mapped/new conflicts, error precedence and existing raw-empty/whitespace behavior remain protected.
- The screen checks staged CSV columns and the serialized commit envelope before preview; oversized requests preserve the staged source and give a batch-splitting recovery action.
- Unmapped contact preference explains the actual Email default and asks the operator to preserve source opt-outs. Gift mapping explains Posted creation and the unsupported source void/refund/reversal and campaign/grant/pledge history boundary.
- Synthetic CSV examples use named fields, so changing shared column order cannot silently scramble sample values.
- Saved reconciliation shows record type, expected and saved counts/amounts together on a phone. Existing detail-only responsive behavior now covers newly saved/replayed results too.

## Verified

**484/484 integrated tests pass**, zero failures/skips, 17.73 seconds. Final build passes in **1.16 seconds**; main bundle **482.26 kB**. The initial combined run found two isolated UI test harnesses missing the new shared dependency; the harness was corrected to load the actual shared contract, new behavior checks were added, and the complete suite was rerun successfully. The final subsequent change was the narrow mobile CSS correction, verified by build and browser inspection rather than an unnecessary repeated business suite.

Focused conversion checks passed 26/26; UI state/event checks passed 9/9. A mounted 500-row scenario covers mixed-case/trimmed duplicate rejection, corrected commit, restart, reordered-key replay, mapped-row reuse and new-versus-existing collision. Exact **2,490 cents and 500 mappings** remain unchanged. Supporting instrumentation recorded exactly three calls to the injected migration list helper for both invalid and valid fresh 500-row plans. This measures planner scans only, not core validator scans, total application throughput or buyer-scale performance; no speedup percentage is claimed.

The restarted built isolated evaluator completed a separate browser journey: stage explicit Staff identity with Do not contact, inspect missing-preference guidance then restore the source mapping, stage fund and historical gift, preview three valid linked rows, confirm and save **$12.34 dated September 13, 2016**, then reload and replay the exact batch with no duplicate records. Desktop and 390×844 phone views were inspected. The corrected phone view shows expected and saved values simultaneously. No captured browser console errors. No actual messages, payments, tax documents, buyer records or cloud rollout were used.

## Still open

The 84-criterion basic inventory remains **46 local / 24 partial / 11 missing / 3 external evidence**. This pass does not upgrade C1/C2 to complete.

Conversion still supports only normalized constituents, designations and posted gifts, at 500 total input rows per batch. It does not reconstruct campaigns/commitments, financial void/correction/year history, contacts/households, grants/pledges, historical receipts/acknowledgments/interactions, private source files/revisions, volunteer/event history, Mailchimp or governed deltas. Normalized content hashes are not original-file custody checksums. Source samples, actual inventory, consent/financial/retention policies, private custody, independent reconciliation and signed cutover acceptance are still required.

Whole-workspace dependency hashing and core external-reference write validation still scan existing data under the synchronous transaction. The source input cap does not bound the existing database. Further volume work and a reverse source-mapping index are identified architectural next steps, not measured failures or implemented fixes in this pass. Render remains deferred.

See **Wimblo-source-conversion-custody-plan.md** for the conversion/cutover protocol and **Wimblo-conversion-review-business.md / Wimblo-conversion-review-architecture.md** for the next entity/history slices, business safeguards and acceptance inputs. Specialist review does not supply qualifying provider references, certifications, legal approval or staffed services.
