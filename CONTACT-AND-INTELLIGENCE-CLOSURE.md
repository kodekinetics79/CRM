# Wimblo — contact and intelligence continuation

September 13, 2026. Local synthetic engineering checkpoint. Render and eligibility discussion remain deferred. No actual provider sending, production rollout, buyer data conversion or institutional acceptance.

## New behavior

**Stopped no-write reviews can close safely.** An administrator can close Ready, Unknown or ReviewRequired contact intents only when no provider write was reserved. The administrator records a reason, confirms the original runner is stopped and reviews the exact current intent version. This supports changed source records or a different current administrator without reauthorizing the original private fields. Executing intents and every attempted/reserved write remain protected, even when the original actor or source changed.

Closure adds an immutable fourth contact-sync ledger with the final native row version/hash, actor, reason and stopped-runner confirmation. Original request/source/payload/history stay retained. Native status remains ReviewRequired; verified derived status is ClosedWithoutWrite. No schema CHECK rebuild or destructive data conversion occurs. Corrupt closure custody fails closed before new UUID preparation or provider access. SQL forbids later disposed-row updates and clearing the write-reserved flag. Recovery retains the ledger and its historical originals.

**Contact history is scoped to the constituent.** The screen now loads 100 intents per page for the selected constituent across current and earlier bindings. A cursor from another constituent is rejected. Inspecting another intent or reloading history clears the action reason, generic review, runner-specific confirmation and local request identity. A checked confirmation cannot carry between two different updates. Completed/closed intents offer Review another update without repeating the old operation. A changed member binding still needs separate retirement/review and a new current binding; closure never silently rebases it.

**Contact observation capacity and lookup have advanced.** Native binding capacity is 20,000; member observations, callbacks and campaign custody are bounded at 200,000 each. Stable cursor pages select only the requested page plus one ID. Indexed duplicate-email lookups preserve ASCII case equivalence, no-trim behavior and a narrow JavaScript-equivalent Unicode fault fallback. The injected read-only provider remains TEST_ONLY; capacity is not live sending, bulk contact synchronization, consent or production acceptance.

**AI responses verify the complete relevant source corpus.** Constituent summaries now pin every eligible posted monetary gift included in aggregate counts/amounts, including records outside the latest-five display. Thank-you drafting pins its selected gift and recipient. After provider generation and fresh access/policy checks, changed amount, allocation, status, date, membership, native version, recipient/lifecycle, permission scope or UTC cutoff withholds generated text. Unrelated or excluded source changes and reorder-only acquisition remain allowed. Pins are internal and are never sent to the provider or logged. Response shape and deterministic priorities are unchanged. Actual workspace suspension is also rechecked after generation.

## Verification

Final integrated source: **896/896 tests pass**, zero failures, cancellations or skips, **78.126435 seconds**. Final production build passes in **1.27 seconds**. The 6,515-contact native fixture passes its three scale/freshness cases; 20,000 genuine prepare-and-retire cycles retain 20,000 immutable mappings, 20,000 observations and 60,000 history records before overflow rejection. Those focused suites took 19.018 and 28.686 seconds respectively on synthetic local fixtures; they are not a production SLA. Built desktop/mobile stale-review closure passes without a provider write. Current source and evidence hashes are recorded in `CONTACT-CONTINUATION-VERIFICATION.json` (source manifest `0964080247e5ffaf869d8d9ee72d35fe69025a0ef317ba8a367c888b132d34cf`). Earlier 835-test verification remains historical.

The browser journey uses the actual built app with synthetic records and an injected provider: observe existing member → prepare reviewed update → independently change native source → inspect retained stale intent → confirm stopped runner and fresh action → close without a provider write → reload immutable history. Desktop and 390 px mobile checks pass; no signed-in console/runtime errors. The initial unauthenticated session probe is an expected 401. This is independent testing of a local app, not hosted provider acceptance.

## Remaining boundaries

Actual Mailchimp/current-contact mapping, sender configuration, reliable email delivery, new member policy, bulk lifecycle, inbound callback adoption, residency and full buyer-volume acceptance remain open. Safe resolution of an attempted update with changed original authority remains protected and needs a separately designed observed-outcome process; the no-write closure is never a workaround.

AI source-freshness correctness does not approve sending actual protected buyer data to Ollama. Production assistance remains restricted by policy; actual provider configuration, processing location, consent/data schedules and acceptance are separate. The previous reproduced aggregate stale-response defect is locally repaired, not evidence of model factual accuracy or competitive superiority.

C1/C2 actual post-award full export/conversion, B2/B6 complete accepted fields/full-detail extraction and C6/C7 operated privacy/hosting/recovery remain pending. The register stays 46 Local basic / 33 Partial / 2 Missing / 3 external evidence, zero buyer accepted, 84 criteria and 3,500 technical points.
