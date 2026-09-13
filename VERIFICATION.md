# Evaluator release verification

This record describes checks run against the local synthetic Jordan Everbright pilot. It is not a production, institutional or accessibility certification.

## Automated checks

Release 0.4.0 built successfully with `npm run build`. The final combined `npm test` run passed all 87 checks, with no failures or skipped tests. All 74 prior checks remain covered alongside 13 phase-four checks for volunteer reservations, work-queue semantics and local integrity detection.

Coverage includes authenticated access, CSRF/origin protections, role boundaries, integer-cent allocations, dates and references, stale-write protection, atomic imports, capacity and check-in membership, volunteer clocks, traceable financial voids, contact preferences, snapshot credential exclusion, fiscal-year recalculation, in-kind consistency, linked tasks, production HTTPS controls, report filters and CSV safeguards.

## Browser checks

Verified through the actual application at http://127.0.0.1:5174:

- Administrator sign-in, sign-out and board-viewer sign-in. Board viewers cannot see record creation or Settings; API tests separately enforce their permissions.
- Saved a fictional business with an additional named contact and correct example-domain email addresses.
- Recorded a $100 gift split $60/$40 across STEM and arts designations. A $60/$30 allocation disabled saving. Reloading retained the saved gift and updated the derived contribution total.
- Validated and previewed one $25 CSV gift, confirmed its import, and verified that reusing its external reference produces a row-specific duplicate error.
- Registered a synthetic event guest with a seating label and checked the guest in. The registration table reflected both changes.
- Clocked a volunteer in and out. The button and persisted record version reflected the transitions.
- Selected Donor follow-up and confirmed irrelevant gift filters are disabled.
- Inspected desktop 1280×720 and mobile 390×844 layouts. Closed mobile navigation is inert, and the checked mobile screen has no horizontal page overflow. Tables retain horizontal scrolling.
- Browser warning/error log was empty at the reporting inspection.

## Phase-two browser checks

- Giving chart six/twelve-month controls, 3D/flat toggle, month inspection and July drill-through: seven gifts totaling $12,125 matched the chart.
- Saved a household recognition report view and applied it after changing the report.
- Opened the seeded pledge, reloaded its record link, and retained the six-installment schedule and recorded $500 receipt.
- Created a synthetic $1,200, twelve-month pledge for Sam Chen; recorded a linked $100 gift. The first installment became received, outstanding balance became $1,100, and overdue balance became zero. No funds were collected.
- Recorded a synthetic completed Phone acknowledgment for Sam’s earlier $125 gift. Completed stewardship and gift details retained the channel, notes and linked recorded interaction. No message was sent.
- Clocked Taylor in/out, preserving a dated interval separately from eight migrated undated hours. Corrected the test interval to 1.25 hours with a reason; dated total became 1.25 and reconciled total became 9.25.
- Inspected phase-two desktop 1440×1000 and mobile 390×844 dashboard, chart and volunteer views. Browser warning/error log was empty.

## Independent reviews

Procurement, technical and privacy/integrity agents reviewed requirement coverage, endpoint integration, financial semantics and error recovery. Their findings led to corrections for local dates, fiscal years, follow-up logic, in-kind imports, conflict refresh, session recovery and uncertain import copy.

A fresh Impeccable finish reviewer inspected desktop/mobile dashboard, gift and reporting screenshots and the design contract. Required checkbox alignment and navigation findability fixes were verified; the final verdict was SHIP for this local synthetic pilot. The full review is in `.impeccable/review/FINISH-REVIEW.md`. Mobile chart labels were subsequently enlarged and compacted while retaining exact values in the accessible chart description.

Phase-two independent review inspected the required desktop/mobile captures. Its two findings—small mobile chart labels and stale design documentation—were corrected and scored resolved. The closing verdict was SHIP at the scoped fix-review boundary. DESIGN.md and its machine-readable sidecar now describe the built typography, colors, glass, gradients, geometry and reduced-motion behavior. This is a design review, not an accessibility certification.

The six-month mobile chart now uses responsive geometry with 11px plot labels. Full-year comparison keeps a 620px plot inside local horizontal scrolling; all twelve month selectors are visible in two rows. The checked mobile page width equals its 390px viewport.

## Limits

The API tests cover behavior beyond the particular browser paths above. They do not prove live third-party integrations, migration, concurrency at institutional scale, recovery readiness, full keyboard/accessibility conformance or security certification. Additional production acceptance work is mapped in RFP-COVERAGE.md and FUTURE-CAPABILITIES.md.

## Phase-three release-owner acceptance

The clean client source copy installed successfully with `npm ci` using Node 24.15.0 and ran the prebuilt application with `npm run evaluate` on loopback port4321. One process served the API and assets, using an evaluator-specific database and session cookie independently from development.

Through the actual client browser, the release owner recorded a synthetic $25,000 request, $15,000 award and $5,000 linked receipt. The pipeline showed a $10,000 known award balance. Receipt entry prefilled the funder, Grant revenue type and grant link. Keyboard C opened grant creation, Command Enter saved, and Command K focused search. Stewardship loaded after the navigation regression fix. Screen help opened through its button and Escape dismissed it.

Observed test feedback saved through the application and remained after reload. Board sign-in hid gift creation/import and Settings, while allowing a saved board evaluation observation. Desktop 1280×800 and mobile 390×844 captures checked first-glance testing guidance, accessible navigation and prioritized donor/value/date mobile records without horizontal page overflow. Browser warning/error logs were empty at the final feedback/export inspection.

CSV/JSON export controls were exercised without logged browser errors. The embedded browser did not provide a completed-download event; downloaded file completion is not asserted. Client acceptance should compare exported files in a standard browser as described in the guide. Automated CSV escaping/report helper checks passed.

Independent chief architecture, controls and security reviews are recorded in CHIEF-SOLUTION-ARCHITECT-REVIEW.md, CONTROLS-AND-CONNECTIVITY.md and PHASE-THREE-SECURITY-REVIEW.md. Their review snapshots correctly distinguish their independent findings from this later release-owner evidence.

The bounded source design scan returned zero mechanical findings. Its 158 advisories concern literal palette/type/radius values in the older cascading style layers and the design contract being refreshed; current rendered styles and user-pinned flat defaults take precedence. The remaining changed feature targets returned zero findings. Historical phase-two design reviews above describe that earlier release.

A final browser correction also confirmed sign-out resets both the visible route and browser URL to the dashboard, preserving consistent navigation after signing in again.

The fresh independent phase-three design reviewer, who did not build app code, returned SHIP for the local synthetic evaluator within the bounded source/desktop/mobile evidence. Its login, chart-filter, motion and currency-focus findings were corrected and independently checked. PHASE-THREE-FINISH-REVIEW.md records the scoped verdict and download limitation; DESIGN.md and its sidecar describe the final flat operational system.

The final Jordan-Everbright-Client-Testing.zip archive passed integrity and inventory checks: release0.3.0, source, lockfile, prebuilt assets, launcher, guides and font licenses; no installed dependencies, databases, session files or environment files. Extracted into a fresh folder, `npm ci` installed136packages successfully. `PORT=4322 npm run evaluate` started the independent extracted app, and an actual browser signed in and opened all nine client test scenarios with release0.3.0 visible and no warning/error logs. This fresh verification process was stopped; the client preview at4321 remains available.

## Phase-four and local phase-five owner acceptance

Release0.4.0 was exercised through the actual prebuilt evaluator at loopback4321. A synthetic one-place Pantry welcome team shift was created with a venue and same-day local interval. Taylor Bennett reserved the place. A second Reserved person was rejected for capacity; Sam Chen was instead saved Waitlisted. Cancelling Taylor retained Cancelled history and released capacity without automatic promotion. Explicitly reserving Sam filled the place. Reload and evaluator restart retained the roster and capacity. Editing the booked shift focused its name and disabled date/start/end/event changes; API checks independently enforce these constraints.

A synthetic task, Verify welcome team readiness (9ab64816-adb3-4ea7-9c14-c4a19bcd305f), appeared in Operations search. Opening its source task and marking it Completed removed that work item. The empty filter state exposed Clear filters and restored other work. Administrator Workspace checks inspected80 then-current records and reported passed record/reference, time-ledger and active-clock checks. Clean local checks do not establish external-provider readiness or production compliance.

The existing synthetic grant still showed a $25,000 request, $15,000 recorded award, $5,000 linked receipt and $10,000 award balance. Two additional observed Client testing results saved successfully, with browser observations distinguished from automated overlap/concurrency evidence. Board sign-in displayed the roster and Cancelled history while hiding Settings and all plan/edit/reserve/cancel actions. Administrator access was restored afterward. Final warning/error logs were empty.

Desktop1280×800 and mobile390×844 Operations/shift screenshots were inspected. Checked pages had no horizontal overflow. The bounded fix hid overview metrics while viewing/editing a shift, bringing roster actions forward on mobile. Frosted navigation uses the specified blur while forms/data remain opaque; temporary viewport overrides were reset. The source design scan flagged two retired font-family declarations, corrected to IBM Plex Sans; palette/type/radius literal advisories were reviewed against the current design contract. No claim of a comprehensive accessibility audit is made.

New phase-four verification is release-owner-run. Additional SME agent creation was unavailable because the agent thread limit had been reached. Completed chief architecture, controls, security and phase-three independent design reviews still govern the implemented boundaries; their earlier verdicts are not presented as new phase-four independent approval. CTO-PROJECT-PLAN.md separates implemented phases4/local5 foundations from provider-dependent phases6–8.

The release0.4.0 client archive passed ZIP integrity/inventory checks with84files and no installed dependencies, databases, sessions or environment files. Extracted to a new folder, `npm ci` installed136packages successfully and `PORT=4322 npm run evaluate` launched the prebuilt independent app. An actual browser signed in, opened Operations and all eleven release0.4.0 test scenarios, then ran administrator Workspace checks:73 freshly seeded records and all three checks Passed. Warning/error logs were empty. The fresh check process was stopped; the canonical local preview remains at4321. After adding this evidence to the documentation, the final archive was rebuilt with the tested runtime/source/lockfile/assets unchanged.

## Kinflect branding patch — release0.4.1

The user selected Kinflect on September13,2026. Current login/navigation/page titles, evaluator guide, result/roster filenames, snapshot filename, design contract, package metadata and current documentation now use Kinflect. Earlier phase review snapshots retain their historical Everbright name. Database paths, session identifiers, saved density key and business record IDs are unchanged. No new product capability or trademark clearance is asserted by the rebrand.

The owner re-ran the full suite:87passed,0failed/skipped; build succeeded. The actual loopback4321 browser showed Welcome to Kinflect, then signed in and displayed Operations · Kinflect with the Jordan Education Foundation identity and release0.4.1's eleven scenarios. Existing saved observations remained visible. Final warning/error logs were empty.
