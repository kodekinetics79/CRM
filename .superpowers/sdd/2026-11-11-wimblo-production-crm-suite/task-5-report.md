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
