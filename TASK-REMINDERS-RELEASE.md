# Wimblo — private task reminders

September 13, 2026. Kode Kinetics LLC. Verified local source; no production launch or buyer acceptance.

## Verification

Final integrated suite: **584/584 passed**, zero failures/skips, **26.61 seconds**. Production UI build passed in **2.34 seconds**, main bundle **491.02 kB**. Focused overlapping evidence: 9 backend reminder tests, 12 independent integrity tests, 4 reporting/recovery tests, 3 UI tests and 2 timezone tests. Earlier 554-test saved-audience checkpoint remains historical.

The synthetic built application saved an owned task reminder at the displayed UTC instant `2026-09-13T18:29:00.000Z`, produced exactly one private inbox entry at `18:29:15Z`, and exposed its dated Delivered outcome. A second owned task reminder was saved for `19:30Z`; duplicate creation became disabled with guidance, and reasoned cancellation retained its Cancelled outcome. Opening the first source task and marking it Completed removed its inbox item and selectable task; retained Delivered evidence remained with a source reference instead of the stale title. At 390×844, labeled history rows retained task, time, status, outcome and action without horizontal scrolling: page 390/390 px, history container 320/320 px. Viewport restored.

An earlier automation attempt against the native date field did not update the controlled preview and the browser engine interrupted its stepper interaction. That attempt is not counted as a successful date-picker journey. Visible time shortcuts subsequently updated the actual UTC preview and completed the saved journey. Calendar and daylight-saving gap validation are independently tested; no claim covers every browser's native date-picker interaction.

## Implemented behavior

Active administrator/staff task owners schedule and inspect their own reminders. Administrator status does not grant another owner's inbox. Helpers and viewers cannot use private reminder endpoints. Captured task/account revisions and security bindings, current session/MFA authority and active tenant are checked. Noncompleted tasks require explicit current staff ownership.

Times are canonical UTC with local timezone and exact UTC preview. One active reminder per task, at most 100 active per workspace. Accepted timestamps range from 60 seconds before server time (minute-input tolerance) through 366 days ahead. One-shot worker checks every 30 seconds while the workspace process runs, reconciles all active source bindings before due work and attempts at most 50 due reminders per cycle. It catches up retained pending work after restart. No recurrence or escalation engine is claimed.

Delivery is a unique durable internal inbox row, atomically committed with native schedule/outcome/audit records. Changed account access, task revision, assignment or completion suppresses pending work and hides stale delivered source titles from the owner's current inbox. Cancellation requires current revision and a nonblank reason; dated immutable evidence remains. A changed time requires cancellation and a new schedule. Source task deletion is blocked by retained reminder history.

Persistence failures roll back delivery; committed retry evidence uses a 60-second delay and caps persisted attempts at five before terminal suppression. A complete persistence outage does not fabricate a Delivered status or increment successful-delivery counters. Actual concurrent workers, restart, source changes, deferred commit failures and outage handling are covered by independent tests.

Tenant suspension commits in the platform registry before workspace suppression/revocation. If workspace effects fail, access remains Suspended and the API reports the committed suspension and need to retry. Restoring access requires existing workspace storage and successful suppression/revocation while still suspended; older pending reminders never reactivate. This is tested failure ordering across two databases, not a distributed atomic transaction.

Administrator-only curated reports expose schedule revisions, dated outcomes and inbox production metadata. Staff/viewer catalogs omit those administrative sources and direct access is denied; security bindings and task titles/bodies are never report fields. An actual encrypted native backup/new-path restore preserved Delivered, Cancelled and Suppressed rows across all three tables, cleared restored authentication and left exact financial values and communications unchanged.

## Open requirements and handover

A8.5 remains **Partial** pending agreed reminder policies, offered delivery/recurrence/escalation behavior and buyer acceptance. Internal reminders do not close the communications automation criterion A7.3 or volunteer automatic-email requirements. No email, push or other external message is sent. Operating monitoring, hosted recovery/retention policy, live source data and production handover remain unproved. The 84-row inventory remains 46 local basic / 24 partial / 11 missing / 3 external evidence, with zero buyer-accepted criteria.

Render deployment is deferred by the user. This release does not replace prior handover ZIP evidence or claim a production database/framework migration.
