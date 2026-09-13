# Evaluator release verification

**Final current-source checkpoint:** mounted Wimblo 0.5.0 passed **325/325 tests**, zero failures/skips, in **10.8 seconds**, followed by a production build in **1.13 seconds** after grant queue/AI connectivity and independent privacy fixes. Earlier counts below are historical. See [CURRENT-RELEASE-EVIDENCE.md](CURRENT-RELEASE-EVIDENCE.md). No cloud deployment or full buyer acceptance is claimed.

## Wimblo 0.5.0 — grant and tribute module evidence

September 13, 2026. Independent focused actual-application verification; **the current full suite, release build/package and browser acceptance remain pending the release owner's report**. Earlier counts/assets below are dated evidence, not current integrated totals.

`node --test tests/documents.test.js tests/grant-operations.test.js tests/tributes.test.js` passed for isolated temporary SQLite/application fixtures. Grant tests verify auth/CSRF/role/current source-owner versions, exact financial invariance, same-grant Final/Submitted revision/category/date/version constraints, saved revision SHA-256, immutable completion/reopen history, archived/revised source behavior, persistent restart, concurrent completion and administrator-only historical evidence across current visibility changes. Corrupted evidence fails atomically instead of retaining false proof. These establish saved staff/documentary records, not external submission, awards, reminders or independent approval.

A newly reproduced document privacy regression is fixed and tested: an Administrators original beneath a later Workspace revision no longer leaks private metadata through list/detail responses or bytes through revision content. Staff/viewer denial returns404 with no successful download audit; administrators retain original bytes, including after restart.

Tribute tests verify Honor/Memory version history, retained donor/honoree/recipient/source snapshots, no new income or soft-credit writes, explicit disclosure approval and recipient-channel preferences, donor/recipient opt-outs, merged-identity/future/fee/void rejection, stale source/tribute review, immutable Draft/Finalized originals, encoded-path financial/deletion/merge protection, ordinary gift notes/fiscal override, private current/historic viewer isolation across visibility changes, restart and audit-failure rollback. Notifications remain **Not sent**, with no gift amount/secondary-contact/soft-credit audience disclosure. A reproduced current-disclosure revocation leak is fixed: viewer Draft/Finalized notification reads/lists require current and saved approval, and revoked Team tribute records expose no donor source revisions; staff/admin originals remain available. Reapproval exposes only approved historical versions, with restart coverage. Tribute JSX compiles; editor New/open/history switches are disabled while dirty and explicit Cancel restores the saved editor. Browser interaction acceptance remains owner work.

Finalized tribute notifications currently have no withdrawal/financial-correction release endpoint. Gift source void remains available subject to applicable receipt/core guards, but changing tribute wording does not remove its finalized financial-source guard. Client approval of wording/disclosure/correction policy remains open. Curated grant/tribute reporting was source-inspected for privacy boundaries: tribute metadata sources are admin-only; grant evidence uses saved/current document privacy. No new full reporting acceptance or all-stored-field coverage is claimed in this entry.

Assistance may explain receipt register preparation and staff-confirmed issuance controls. It cannot physically print, hand-sign, issue or verify a staff action. Receipts, correspondence and tribute review are separate histories; no email-provider delivery or tax certification is proved. Injected tribute audit faults produce expected generic error logs while rollback assertions pass.

## Current module evidence — September 13, 2026

Independent scoped verification of completed workspace MFA, correspondence, numbered receipts and offline encrypted recovery. This entry does not supply a new full-suite count, production build result, package acceptance, hosted drill or district/tax certification; the release owner must report the current integrated suite/build/browser results separately. Earlier counts and asset names below describe their dated snapshots.

The focused command passed with no failed/skipped cases:

```sh
node --test tests/mfa.test.js tests/mfa-api.test.js tests/receipts.test.js tests/communications.test.js tests/backup.test.js
```

- **Workspace MFA:** RFC TOTP vectors, own-account/password/CSRF enrollment, encrypted secrets and hashed one-use recovery/challenges, replay/failure windows, suspension/role-version invalidation, restart and missing/wrong-key fail-closed behavior. Actual createApp and platform selector fixtures prove challenge routing to its workspace and pending denial on tenant suspension. Workspace viewer MFA does not grant write access. Separate platform master-administrator MFA is not implemented; enrollment policy/SSO remain separate acceptance work.
- **Correspondence:** reusable versioned plain-text templates, allowlisted literal merge fields, explicit-recipient isolation/primary email and opt-out gates, exact annual payroll totals, immutable preparation/review provenance, stale source/template/annual-membership rejection, persistent searched history and atomic audit-failure rollback. Finalization remains **Not sent** and does not complete existing gift acknowledgments. JSX source compilation passed for Correspondence.jsx; new browser acceptance is owner work.
- **Receipt register:** administrator-approved profile with no default tax identity, exact cents, noncash description without assigned value, sponsorship benefits without deduction calculation, actual-calendar-year Payroll Employee giving, staff-confirmed Print/hand-sign issue dates, unique number allocation, repeated/overlapping issue denial, void/reissue originals, source/profile/member staleness, role/CSRF and audit rollback. Actual createApp fixtures verify active issued financial-edit/void guards and both source/target identity-merge protection, including issue after an earlier merge preview. Prepared-only merge invalidates old issuance; retained originals survive restart. No email/provider delivery or client tax approval is implied.
- **Offline full-workspace backup/restore:** real createApp SQLite snapshot includes every installed table, document/revision bytes and SHA-256, numbered receipt/correspondence histories, exact money and audit. AES-256-GCM tenant/version binding, wrong key/tamper/forged tenant, schema/count/row-digest/source-hash checks, 0600/no-overwrite/symlink/concurrent publication and bounded size/key inputs passed. A live write after VACUUM snapshot remains outside the consistent archive/restored inventory. Offline CLI backup from a read-only source and new-path restore passed. Temporary plaintext staging was removed after success/failure. Original sessions fail on restored copy; enabled MFA/recovery history remains usable only with the separately retained same MFA master key; challenges/pending enrollment are cleared. Injected fixture audit faults produce expected generic internal-error log lines in receipt/correspondence rollback cases, not unexpected service errors.

Current operational limits: manual recovery only, 128 MiB archive/200 tables/500,000 rows/1 MiB manifest; no automatic backup schedule, cloud durability or RPO/RTO SLA. `MFA_ENCRYPTION_KEY` and `BACKUP_ENCRYPTION_KEY` are distinct server/operator-only keys with no supplied default/value; neither belongs in source, frontend bundles, public packages or archive headers. Live database/disk encryption and platform-registry/key recovery remain separate. Receipt issue is a staff action log; correspondence finalization is human review; neither proves external delivery. No institutional ten-year source conversion, retention/disposal approval, hosted security/support service or LearnPlatform/DPA acceptance is established by these focused tests.


## Wimblo 0.4.2 — security and compliance remediation

Owner verification on September 13, 2026; no new independent security verdict or production acceptance.

- `npm test`: **93 passed**, zero failures/skips. Six new account-security cases cover administrator/CSRF/version/strict-field boundaries, all-session suspension and reactivation, downgrade/relogin/write denial, final-administrator rollback and concurrent demotion protection, fail-closed unknown roles, and legacy migration/restart without credential loss. Existing production fixture now verifies acceptance config is disabled, unsafe acceptance configuration rejects startup, valid admin/CSRF cannot write feedback, and standard workspace hides feedback.
- `npm run build`: passed; final browser bundle `index-D0_J0NNX.js`, stylesheet `index-CfcaqE63.css`. Later documentation/edge-config changes do not alter this compiled bundle.
- `npm audit --json`: zero registry-reported vulnerabilities across the audited lockfile. A production high/critical audit check was added to CI; remote CI has not run on unpublished source.
- Actual local evaluator restarted preserving its existing database. Settings listed three active accounts with status/role/access controls. Casey's editor displayed role/status choices, all-device sign-out effect, record-preservation explanation and final-administrator guard. Cancel returned without an access mutation. Lifecycle save outcomes are verified through isolated API fixtures; no live cloud-account permission was changed through the browser.
- Desktop 1280×800: editor opening focused the role field; Cancel returned focus to Manage access for Casey Rivera; page width equaled viewport. Mobile 390×844: editor was 320px wide inside a 390px document, with no page overflow; role/status/actions readable in screenshot. Normal viewport restored. Browser warning/error log was empty at final check.
- Standard-production testing navigation/direct-route/login conditions were source-checked and the server boundaries tested; no authenticated production-browser journey or new Vercel deployment is claimed. Current context help remains available locally.
- Render API readback verified corrected Node runtime, npm build/start, /api/health and https://wimblo.vercel.app origin. Free plan/no disk unchanged; no new deployment launched. Neon table inventory was rechecked: nine auth tables, no CRM tables; no schema/data mutation.
- `vercel.json` prepares CSP/framing/nosniff/referrer/HSTS/device-permission/API-cache headers. Script policy has no unsafe-inline/eval; inline styles remain allowed for existing React chart/layout attributes. Deployed header/CSP/API-proxy verification remains open.

RFP-SECURITY-COMPLIANCE.md, security_best_practices_report.md and SECURITY-OPERATIONS.md distinguish implemented controls, source-only deployment config, draft procedures and outstanding identity/scope/storage/recovery/legal/institutional evidence. Historical phase review verdicts below retain their original scope.


## Wimblo 0.4.2 — navigation material refinement

Owner verification on September 13, 2026 for the requested beveled sidebar and transitions.

- Production build and `git diff --check` passed. Updated bundle: `index-HJ03mb8d.js`, `index-CfcaqE63.css`.
- Desktop 1280×800: actual computed styles confirmed rail edge lighting, logo bezel and selected-row inset edges/shadow. Operations navigation worked; keyboard focus had a visible 2px apricot outline. No horizontal document overflow; the profile footer remained within the viewport.
- Mobile 390×844: the 256px drawer rendered the same material treatment with its footer visible and no horizontal document overflow. Selecting About changed the screen and closed the drawer. Escape closed a reopened drawer and restored focus to Open navigation. Final browser warning/error log was empty; the normal viewport was restored.
- Source retains reduced-motion disabling of all transitions/animation and forced-colors removal of navigation gradients/shadows. These preference modes were source-checked, not browser-emulated in this pass.
- This refinement changes navigation styling only. The earlier 87-check functional suite below was not rerun for this CSS-only change.

## Wimblo 0.4.2 — identity and shared UI update

Owner verification on September 13, 2026. This is a branding and interface change, not a new independent certification or production approval.

- `npm test`: 87 passed, zero failures/skips. Existing permission, persistence, financial integrity, capacity, and reconciliation checks remain passing.
- `npm run build`: passed. Final assets include `index-C6VffyB6.js` and `index-SL1oahqz.css`. `git diff --check` passed.
- `designmd lint DESIGN.md`: zero errors, 21 warnings. Warnings concern the existing semantic naming and runtime-consumed tokens that the documentation component graph does not reference. Runtime palette ownership is explicitly documented in `src/wimblo.css`; duplicate inherited root declarations were removed.
- Actual browser at `http://127.0.0.1:4321`: all 16 main destinations, About, and the guide rendered with Wimblo identity. Desktop 1280×800 had no horizontal document overflow on the checked destinations and no framework error overlay.
- Mobile 390×844: About, Operations, Dashboard, Constituents, Reports, and Settings had no horizontal document overflow. Main navigation remains a drawer; the closed drawer is outside the viewport and absent from the native accessibility tree.
- Giving chart flat/depth toggle and July inspector worked. Selected July showed $12,125.00, seven monetary gifts, and seven donors; values derive from the existing synthetic records.
- Empty task submission focused its required title with the native constraint message. Cancel returned to the list without a saved test record. Work-queue no-match search showed the explicit recovery action; clearing the search restored work.
- About links reached Operations, Client testing, and the evaluator guide through shared navigation. The provider link includes new-tab disclosure and `noopener noreferrer`.
- Administrator and board-viewer sign-in/out worked. About was accessible to the viewer; Settings and gift creation stayed unavailable. Control+K focused global search. Logo images loaded successfully. Final warning/error log was empty; normal viewport was restored.
- Contrast calculation: supporting ink on warm white 6.14:1; annotation ink 5.44:1; warm annotation on selected apricot context 7.01:1; primary action contrast 9.48:1; navigation supporting ink 8.91:1. Field borders were strengthened after checking their nontext contrast.

The premium skill's static auditor was attempted, but its installed source-tag parser did not finish. A bounded retry produced a traceback in `iter_html_tags` / `is_regex_literal_start`; no clean premium static-audit result is claimed. The evaluator also retains existing native confirmations/constraint-validation presentation and the existing drawer focus behavior described in `UX-CONTRACT.md`; a complete accessibility certification and cross-browser audit remain separate work.

The user-approved Gather identity replaces Kinflect intentionally. Shared colors, font hierarchy, corners, charts, focus/selection/caret, scrollbars, login, navigation and About were updated together. Historical phase acceptance evidence below remains under its original product name.

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


## Wimblo-only branding correction — September 13, 2026

User explicitly requested removal of Jordan Foundation customer branding. Marketing and Creative Director SME reviews were performed independently; WIMBLO-BRAND-GOVERNANCE.md records current brand rules and evidence boundaries. The sole product identity is Wimblo, with the approved Gather mark and indigo/apricot palette.

Removed the hardcoded customer subtitle, customer-specific login/dashboard/stewardship/help copy and customer browser metadata. Default organizationName is Wimblo. Exact legacy defaults (Jordan Education Foundation, Jordan Foundation and Foundation CRM · Evaluator pilot) migrate once, preserving fiscal configuration and business records and recording the previous name in audit history. Genuine custom names remain preserved. Compatibility cookie/storage keys and source RFP documentation remain unchanged.

Validation: all 93 tests pass, frontend build passes, and git diff --check passes. Extended the existing persistence migration test to cover both Jordan defaults, fiscal-month and gift preservation, migration audit details and idempotent reopening. Existing custom-settings persistence coverage also passes.

Browser verification at 127.0.0.1:5174 confirmed Wimblo-only login and menu, generic dashboard description, saved organizationName Wimblo, Reports caption “Wimblo · Contributions by donor”, and Wimblo titles/metadata on Reports, Stewardship, About and Guide. The refreshed built evaluator at 127.0.0.1:4321 also confirms Wimblo organizationName and no customer branding. Local servers were restarted with existing databases retained; no remote deployment or commit was performed for this correction.


## Logo relief refinement — September 13, 2026

Removed the white tile and enclosing border from the shared logo mark and larger login image. The approved transparent source asset remains unchanged. Directional CSS edge lighting and silhouette-following relief place the sculpture directly on the dark rail; hover/focus adds restrained lighting without movement. Shared mark geometry is reserved at 44px. Reduced-motion and forced-color fallbacks remain supported.

Build and git diff --check pass. Browser screenshots checked the normal navigation, 390px mobile drawer and login. Computed shared/login backgrounds are transparent with zero-width borders; the image loads, mobile width remains 390px and login has no horizontal overflow. Mobile navigation opened/closed; viewport override was reset. Built evaluator reload also renders the transparent mark. CSS-only refinement does not change API behavior; no additional backend tests or remote deployment were needed/performed.

## Current requirements-first integration verification — September13,2026

129/129 current-source regression tests passed, no failures/skips; production build and git diff whitespace checks passed. New scope: isolated tenant registry/sessions/lifecycle and synthetic-only bounded Ollama assistance with in-flight authorization/policy/opt-out rechecks and generation limits. Browser exercised Intelligence and isolated synthetic platform login/create/suspend/plan/audit/logout. Actual static-help Ollama call returned200/1414ms; this is connectivity proof only, not answer correctness. Unsupported sending/control wording from that initial result led to help facts/output regression guards included in the final129 tests. No public deployment or procurement submission performed.

The earlier 129-test snapshot recorded the 84-row baseline at 25 Local/39 Partial/17 Missing/3 Evidence required. It preceded the module evidence above; the current matrix/progress documents govern later status recommendations. Qualification, actual historical conversion, buyer data/scale/output acceptance and adopted durable hosted operations remain separate open gates. See CURRENT-RFP-REQUIREMENTS-MATRIX.md, REQUIREMENTS-FIRST-CLOSURE.md and SALES-WIN-PLAN.md.
