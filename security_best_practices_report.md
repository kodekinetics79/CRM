# Wimblo security review and remediation record

September 13, 2026 · owner review of current React/Vite, Express and SQLite source and selected deployment metadata. Not an independent penetration test, certification or full legal opinion. Source requirements: supplied RFP C6–C8, Attachment E and Addendum 2; detailed mapping is in RFP-SECURITY-COMPLIANCE.md.

**Production readiness is not established.** Two application gaps were remediated and tested locally; Render's incorrect runtime/build/origin settings were corrected through its API. Public backend connectivity, finer data authorization, MFA and production recovery remain open.

## SEC-001 — High — broad authenticated read access remains open

- Rule: REACT-AUTHZ-001 / server-side least privilege.
- Location: `server/app.js:198`, `/api/workspace`; `src/features/Settings.jsx`, access-role descriptions.
- Evidence: `Object.fromEntries(collections.map(c=>[c,c==='evaluations'&&!acceptanceEnabled?[]:list(c)]))` returns every business collection to every authenticated role. Only audit is administrator-filtered. Roles block writes, not constituent field visibility.
- Impact: a legitimate viewer/staff account can read identifiable constituent contacts, notes, financial/participation history regardless of school, program or duty. UI hiding cannot prevent this.
- Fix: approve a responsibility/permission matrix, implement resource/field-scoped reads and export policies, and test direct endpoint/report access. Board-summary access must be a separately enforced profile.
- Mitigation: synthetic data only until authorized read scope is implemented; tightly restrict account issuance.
- False-positive boundary: if district approves all current users for all current fields, that narrow single-customer use has less exposure. No such approval was supplied. This is an authorization design gap, not an anonymous data endpoint.

## SEC-002 — High — production data durability/recovery remains open

- Rule: operational availability and RFP C7e.
- Location: `server/index.js:13`, SQLite `DB_PATH`; live Render Wimblo_CRM service configuration.
- Evidence: app calls `createApp` with SQLite path and never consumes `DATABASE_URL`. Render is free with no disk, while DB_PATH points to `/var/data/wimblo.sqlite`. Neon inventory has nine auth tables and no business tables.
- Impact: an ephemeral SQLite install can lose accounts, financial records and audit on replacement/redeploy; attached Neon credentials do not make it durable. JSON snapshot has no restore implementation.
- Fix: integrate and test the durable PostgreSQL backend or an explicitly approved disk-backed single-instance alternative; prove restart/redeploy and consistent encrypted backup/restore. Proposed ASP.NET Core/Postgres migration is not implemented.
- Mitigation: no deployment launched by this review against the diskless SQLite configuration; preserve existing local data.
- False-positive boundary: provider filesystem permissions/startup outcome were not exhaustively inspected; a writable ephemeral directory still does not satisfy durability.

## SEC-003 — High — MFA/identity recovery not implemented

- Rule: identity assurance; RFP C7b/A8.7.
- Location: `server/app.js:193`, password-only login; `src/features/Settings.jsx`, explicit MFA/reset limitation.
- Evidence: login accepts only `{email,password}`; users/sessions are application-owned SQLite records. Existing Neon Auth tables are not wired into this API.
- Impact: stolen passwords permit sign-in without another factor; there is no supported recovery/invitation flow. Suspension/role-change revocation reduces continuing access but is not MFA.
- Fix: approved institutional identity or configured MFA with enrollment/challenge/recovery/revocation, privileged-user policy and meaningful acceptance tests.
- Mitigation: restricted synthetic testing; no institutional data admitted. Do not advertise MFA/SSO as complete.
- False-positive boundary: a separately enforced upstream access gateway could compensate for some sign-in risk; none verified, and product/host MFA does not automatically protect CRM users.

## SEC-004 — High — encryption and privacy lifecycle evidence remains open

- Rule: data protection; RFP C6/C7c/g/i; DPA 2.2/4.6/5.1.
- Location: `server/app.js:58–65`, SQLite records; `server/app.js:250`, admin snapshot; infrastructure inventory.
- Evidence: business records stored as JSON text; passwords use scrypt and session tokens use SHA-256. No application encryption/key provider, directed purge, backup-retention orchestration or verified stored-copy inventory exists.
- Impact: password hashing does not protect extracted business data; ordinary deletion/reference protections cannot execute contractual privacy disposition across retained copies. Blanket export is not a scoped student rights workflow.
- Fix: prove managed encryption/key custody, all stored-data locations and processor terms; implement district-authorized scoped rights/export/disposition with retention/holds and deletion evidence.
- Mitigation: synthetic data only. Draft procedure in SECURITY-OPERATIONS.md must not be represented as automated functionality.
- False-positive boundary: host/database at-rest encryption may exist; current source review and region metadata do not verify its scope, configuration or backup coverage.

## SEC-005 — Medium — monitoring/audit assurance and throttle resilience remain open

- Rule: EXPRESS-AUTH-001, EXPRESS-PROXY-001, operational detection; RFP C7d/C8.
- Location: `server/app.js:64–65,181–193`, audit triggers, one-hop trust and in-memory login limiter.
- Evidence: append-only SQLite triggers, actor/time mutation audit, process-local `Map` counters; no centralized alerting/off-host security-event delivery. Trust is explicit one hop, but Vercel-to-Render proxy chain has not been tested.
- Impact: database/host operators can bypass application triggers; limiter resets with a process and is not shared across instances; unverified proxy headers can affect HTTPS/IP decisions and throttling.
- Fix: verify proxy header overwrite/trust against actual route, add durable/shared abuse controls for production identity, security/access/export events, restricted off-host audit and monitored alerts.
- Mitigation: current single-process limiter, production HTTPS guard and explicit trust setting remain enabled. Do not widen CORS or disable CSRF to fix deployment.
- False-positive boundary: provider controls may supplement this; no corresponding deployment evidence inspected.

## SEC-006 — High — account lifecycle gap fixed locally

- Rule: REACT-AUTHZ-001, session authorization lifecycle.
- Location: `server/app.js:66–69,188–190,228–248`; `src/features/Settings.jsx`, Manage access form.
- Previous evidence: accounts could be created but not suspended or role-changed through the application; no administrator session revocation management.
- Fix delivered: additive active/version migration preserving credentials; strict administrator/CSRF-protected versioned PATCH; active-account login/request checks; role allowlist fails closed; change atomically revokes all account sessions and appends before/after audit; last active administrator guard; unchanged access is a no-op; reactivation does not revive old sessions.
- Verification: tests cover staff/viewer denial, missing CSRF, unknown/injected fields, stale versions, multi-session suspension/login denial, reactivation, downgrade/relogin/write denial, final-administrator rollback/concurrent demotion and legacy upgrade/restart.
- Impact addressed: administrators can promptly terminate access; stale edits cannot silently override access decisions.
- Limit: not a password reset, MFA, invitation, standalone “sign out every device” action or detailed permission-scope implementation. Changes are local/unpublished source until release deployment.

## SEC-007 — Medium — acceptance-only API/UI boundary fixed locally

- Rule: REACT-CONFIG-001 / AUTHZ-001; production feature separation.
- Location: `server/app.js:47–50,187,197–198`; `src/App.jsx:25–38` and navigation/route guards; About and Operations.
- Previous evidence: testing feedback API permitted a viewer write exception and test screens/demo-prefilled login were always present in standard production.
- Fix delivered: server-owned configuration/capabilities; production acceptance disabled unless ENABLE_ACCEPTANCE=true with ALLOW_DEMO=true; feedback collection API returns 404 outside acceptance, workspace hides feedback, standard UI hides test navigation/actions and guards direct test routes; login credentials/options empty/hidden unless server explicitly enables demo access. Contextual screen help remains.
- Verification: production fixture denies feedback even with valid administrator cookie/CSRF, reports demoAccess/acceptanceEnabled false, returns empty feedback; unsafe acceptance config rejected. Existing local acceptance feedback tests remain passing.
- Limit: synthetic constants remain in the shared compiled source as documented public test credentials; they are not private secrets. Historical admin snapshots may still include retained acceptance observations. Other customer-specific copy/branding configuration remains unfinished.

## SEC-008 — Medium — frontend edge protection prepared; deployment verification open

- Rule: REACT-HEADERS-001 / CSP-001.
- Location: `vercel.json`; `server/app.js:182` Helmet.
- Evidence: Express has Helmet, but it does not govern an HTML shell served by Vercel. New versioned Vercel config supplies script/CSP, framing, nosniff, referrer, HSTS, restricted device permissions and API no-store headers.
- Fix prepared: same-origin scripts/connections/fonts/images, no objects/framing and no inline/eval scripts. **style-src 'unsafe-inline' is deliberately confined to styles**, because existing React chart/layout components use inline style attributes. It is not added to script-src.
- Impact addressed after deployment: baseline browser protections follow the frontend host independently of API hosting.
- Remaining evidence: deployed HTML headers and CSP compatibility including charts/exports, same-origin API rewrite/session behavior. Source config/build is not proof of live headers.
- False-positive boundary: existing provider/project headers could already protect some responses; this review does not claim they were absent everywhere.

## Performed review and verification

- Security Best Practices skill and matching Express, React and general browser references applied. No new agent/independent penetration-test verdict is claimed.
- Reviewed auth/session/CSRF/origin handling, production/demo guards, SQL parameterization, schema boundaries, privileged routes, exports and high-signal browser sinks/storage/network patterns. No raw HTML injection, eval, untrusted outbound URL fetch or session-token Web Storage pattern was found in reviewed source. Density preference uses localStorage; it is not an auth credential.
- `npm audit --json`: **zero reported vulnerabilities** across the audited lockfile on September 13, 2026. This is registry-advisory evidence, not proof of absence of vulnerabilities. CI now includes a production high/critical advisory gate after locked installation; remote CI has not run on these unpublished changes.
- `npm test`: **93 passed**, zero failures/skips. `npm run build`: passed. Browser account editor and responsive/focus verification recorded in VERIFICATION.md.
- Render API readback verifies runtime node, build npm ci && npm run build, start npm start, health /api/health and APP_ORIGIN https://wimblo.vercel.app. Plan remains free/no disk. No deployment or paid resource change performed; credential not written to source/config or echoed.

No FERPA/PCI/SOC 2/ISO/NIST certification or full RFP compliance claim is made. Close SEC-001–005 and deployed SEC-008 evidence before production admission, alongside remaining product/procurement gates.
