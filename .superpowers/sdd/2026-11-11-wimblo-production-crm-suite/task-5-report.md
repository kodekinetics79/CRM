# Task 5 implementation report

## Status

- Implementation complete and locally verified; independent task review remains required.
- No push, PR, deployment, provider mutation, paid feature or external customer data was used.

## TDD evidence

- Auth recovery RED: `node --test tests/production-auth-flow.test.js` failed because `/api/auth/me` did not return the current session CSRF token. GREEN returns a token derived from the opaque session token while keeping browser state in module memory only.
- UI/evaluation RED: `node --test tests/production-crm-ui.test.js tests/production-crm-evaluation.test.js` failed because the production entry, components and synthetic client did not exist. Focused GREEN passed 15/15.
- Exact-import-review RED: `node --test tests/production-crm-ui.test.js` passed 5/6 because no import review identity existed. GREEN passed 6/6 and pins one idempotency key to the exact in-memory CSV across preview and commit.
- Final focused command: `node --test tests/production-auth-flow.test.js tests/production-crm-ui.test.js tests/production-crm-evaluation.test.js` — 16/16 passed.

## Implemented behavior

- `VITE_WIMBLO_APP_MODE` is the only entry selector: production dynamically imports the production workspace, synthetic evaluation additionally imports the fixture client, and legacy/default imports the existing app. URL and browser storage cannot change mode, and production refuses an injected synthetic client.
- `/api/auth/me` restores a verified session and its current CSRF token after a hard reload. The production client keeps CSRF only in module memory, uses same-origin credentials, supports abort signals and typed JSON/CSV errors, clears on 401, and never auto-retries conflicts.
- `ProductionApp` owns password/MFA/session bootstrap and tenant switching. Bootstrap reads memberships and modules in parallel; tenant switching aborts prior requests, generation-fences late responses, clears old workspace state and resets the route before reloading.
- `CrmWorkspace` renders Today's operating brief, capability-derived navigation, visible viewer/read-only states, organization switching, and debounced, abortable, stale-proof people/organization search. Disabled modules are absent; suspended/retiring modules explain read/export-only access.
- Pipeline movement uses an ordered labelled stage selector and explicit action instead of drag-and-drop. Timeline pagination uses opaque cursors. Reports use bounded dashboard/export APIs; import holds the exact CSV only in memory and separates preview from commit.
- Loading, empty, error, permission, conflict, session-expired and unreadable-response states are explicit. User content relies on React escaping; no raw HTML, unsafe URL, local storage or session storage is used.
- The responsive visual system uses Ink, Mineral, Paper, River, Wimblo apricot and Alert, with IBM Plex Sans for controls, Newsreader only for record/workspace identity, tabular numerals, a functional connection spine, visible focus, 44 px targets, reduced-motion and forced-colors handling.
- Synthetic evaluation uses deterministic fictional `.example` data, a persistent synthetic banner, mutable evaluation behavior and reset to a frozen baseline. It is isolated from the production bundle.

## Final verification

- `npm run test:production-foundation`: 148/148 passed; real PostgreSQL schema 16, 35 forced-RLS tables and all verifier checks passed; discipline reported 0 focused and 0 skipped.
- `npm test`: clean final rerun passed 1,623/1,623 after the import-key regression correction.
- `VITE_WIMBLO_APP_MODE=production npm run build`: passed; production emitted lazy pipeline, timeline and reports chunks and no synthetic fixture chunk.
- `VITE_WIMBLO_APP_MODE=synthetic-evaluation npm run build`: passed and emitted the separate 4.05 kB synthetic fixture chunk.
- `npm audit --audit-level=high`: 0 vulnerabilities.
- `git diff --check`: passed.
- Browser smoke could not run in this environment: Playwright reported no installed Chromium executable and the computer-use browser host was unavailable. No browser was installed or paid service activated. Static rendered-behavior tests and both mode builds passed; browser acceptance remains an explicit later gate.

## Design-hook disposition

- The unsafe image literal used by the escaping test was split so it cannot be mistaken for a real broken image reference.
- The Newsreader finding has a narrow persisted ignore because the approved Task 5 design plan explicitly reserves the already installed face for workspace and record identity headings. No other design finding remains open.

## Boundaries

- Synthetic evaluation is not production acceptance and cannot be selected by a customer URL.
- Local test/build success is not CI, deployment, customer UAT or production acceptance.

## Fix round 1/5

### Findings closed

- The production API now publishes a central session-expired event on every 401 after clearing module-memory CSRF. `ProductionApp` aborts bootstrap work, generation-fences late results, clears session/membership/module state, unmounts the workspace and renders an explicit expired-session sign-in. Rendered coverage proves cached customer identity is absent after the transition.
- Core journeys moved into modular `RelationshipCreate` and `RelationshipWorkspace` components. Staff can create people/organizations, optimistically update parties, add contacts, record activities, create/progress/complete tasks, create/revise notes, link attachment metadata and change ownership. Viewer mutation UI is absent. Conflicts preserve input and require explicit reload; write loading, safe errors and escaped content are visible.
- Synthetic opportunity stage POST now matches before the generic opportunity read route and mutates the fixture version. Reset clears the URL, resets the frozen fixture, increments the workspace key and remounts all visible route/selection/import state. Rendered pipeline coverage proves mutation and remounted reset.
- Reports choose parties for core-only tenants and opportunities only when sales is readable. Import is gated by core write; saved reports additionally require the selected dataset's write capability; complete export uses explicit core/dataset export capabilities and remains available for staff during read/export-only suspension.
- The responsive rail now remains accessible on desktop while the closed mobile drawer is `aria-hidden` and inert. Opening moves focus into the nav and makes the background inert; Escape/scrim close it and return focus to the menu after the background is active. Labels and expanded state follow the drawer state.

### TDD and verification evidence

- Focused RED: `node --test tests/production-crm-ui.test.js tests/production-crm-evaluation.test.js tests/production-crm-workflows-ui.test.js` — 3/10 passed. Failures proved the central subscription, rendered session expiry, synthetic stage mutation, workflow modules, report capability policy and mobile drawer behavior were absent.
- Focused GREEN: `node --test tests/production-crm-ui.test.js tests/production-crm-evaluation.test.js tests/production-crm-workflows-ui.test.js tests/production-auth-flow.test.js` — 31/31 passed.
- `npm run test:production-foundation`: 164/164 passed; real PostgreSQL schema 16, 35 forced-RLS tables and every verifier passed; discipline reported 0 focused and 0 skipped.
- Clean final `npm test`: 1,638/1,638 passed.
- Production-mode and synthetic-evaluation-mode builds passed. The production build emitted no synthetic fixture chunk; the synthetic build emitted a separate 7.75 kB fixture chunk.
- `npm audit --audit-level=high`: 0 vulnerabilities; `git diff --check`: passed.
- Browser host availability is unchanged from the implementation checkpoint, so no browser was installed and no paid/external service was used.

## Fix round 2/5

### Remaining finding closed

- A tenant-authorized subject-detail read now returns the canonical subject type, current owner and optimistic version. Relationship detail loads it with party, contacts and members, sends that exact version on owner changes, advances to each returned version, and performs an explicit authoritative reload after conflict before a retry.
- A control-plane assignment catalog joins only active tenant memberships to active identities and returns exactly `identityId`, `displayName` and `role`. The identity layer independently verifies the requesting actor's active tenant membership; the CRM layer additionally requires the current tenant session, authorized CRM role and core read capability. No email, membership identifier, password/auth hash or security metadata is exposed.
- Task and relationship owner UUID fields are now labelled member selects. The signed-in member is ordered first and selected when no saved owner overrides it; empty catalogs explicitly disable assignment. Viewer mutation UI remains absent.
- Source-string assertions were replaced with rendered state/action tests proving selected member IDs, task creation and two lifecycle versions, two sequential ownership versions, and conflict reload followed by a successful retry.

### TDD and verification evidence

- Backend RED: `node --test tests/production-identity-service.test.js tests/production-crm-work.test.js tests/production-crm-work-http.test.js` — 17/21 passed. The four failures proved subject detail, assignment catalog service policy and both HTTP reads were absent.
- Rendered UI RED: `node --test tests/production-crm-workflows-ui.test.js` — 9/12 passed. The three failures proved ownership still started at hard-coded version 1, conflict reload did not refresh it, and no assignment-safe empty/member-select state existed.
- Focused GREEN: identity, work repository/service/HTTP, workflow UI, production UI/evaluation and auth suites passed 55/55.
- `npm run test:production-foundation`: 171/171 passed; real PostgreSQL schema 16, 35 forced-RLS tables and all verifier checks passed; discipline reported 0 focused and 0 skipped.
- Clean final `npm test`: 1,645/1,645 passed.
- Production and synthetic-evaluation builds passed; production emitted no synthetic fixture chunk and the evaluator fixture remained separate.
- `npm audit --audit-level=high`: 0 vulnerabilities; `git diff --check`: passed.
- No push, deployment, provider mutation, browser installation or paid service was used.
