# Phase-three security review

Reviewed September 13, 2026. Release: 0.3.0. Scope: Jordan Everbright's local, synthetic client testing handoff.

## Assessment

No material security or financial integrity failure was found in the reviewed phase-three implementation. The source and built application are suitable for the intended local client proof of concept from this review's security perspective. This assessment does not certify a public production deployment or turn manually entered client observations into verified test results.

Critical findings: **0**. High findings: **0**. Medium findings: **0**. No lower-severity issue is being promoted to a handoff blocker.

The final distribution archive must contain this release's launcher, source and built assets. The archive available at the time of review was the earlier phase-two package; a fresh archive inventory and installation/launch check remain part of the release owner's handoff verification. Its inspected inventory contained no SQLite files, environment files, session data or dependency directory. This is a packaging verification limit, not evidence of a security vulnerability.

## Scope and method

Reviewed `server/app.js`, `server/index.js`, `scripts/evaluate.mjs`, `src/features/TestingCenter.jsx`, `src/phaseThree.js`, `src/lib.js`, the same-origin API wrapper, build output, exports and phase-three tests. Applied the security-best-practices skill's Express, React and general browser JavaScript references. Review intentionally focuses on material failures introduced by phase three within a local synthetic evaluation; no hypothetical public deployment issue is asserted.

Ran **47 independent assertions** against a new in-memory synthetic database on an ephemeral IPv4 loopback listener. No running demo database was modified. Separately reran the **17 phase-three API, launcher and reconciliation tests: all passed**. The release owner is separately checking a freshly installed package and browser workflows.

## Verified boundaries

| Area | Evidence and result |
| --- | --- |
| Local startup | `scripts/evaluate.mjs:6–13` rejects production mode, nonloopback hosts, remote/non-HTTP origins and invalid ports before launching. It sets development mode and evaluator mode explicitly. `server/index.js:7–15` forces evaluator binding to `127.0.0.1`, serves built assets in the same process, and defaults to the separate `server/data/evaluator.sqlite`. `DB_PATH` remains an explicit operator override. Launcher tests confirmed same-origin login/feedback and IPv4 binding even when the supplied allowed host is `::1`. |
| Existing production protection | `server/app.js:42–46` refuses evaluator mode in production and retains the exact HTTPS production-origin requirement. `server/app.js:149–150` retains production API HTTPS enforcement and conditional Secure cookies; the evaluator uses its own cookie name, HttpOnly and SameSite Strict. Local HTTP cookies worked in independent probes without weakening production settings. |
| Feedback authorization | `server/app.js:159–165` applies authentication to record APIs. Only exact `POST /api/records/evaluations` bypasses the ordinary viewer write restriction, while retaining CSRF. Independent probes confirmed unauthenticated submission returns 401; missing CSRF, untrusted Origin, viewer feedback edits/deletes and viewer business-record creation return 403. Staff can update/delete feedback under the ordinary write contract. |
| Feedback input and concurrency | `server/app.js:29` uses bounded strings, allowed scenario/result/severity values and a strict object schema. Protected metadata injection was rejected. `server/app.js:96,162–165` requires integer versions for updates/deletes and rejects stale writes. Independent staff update, stale overwrite, invalid delete version and successful current-version deletion behaved as intended. |
| Grant integrity | `server/app.js:23,75–85` separates requested amount, recorded award and explicitly linked receipts. Positive awards require a valid award date and Awarded/Closed stage. Known funder mismatch, wrong revenue type, missing grant, double pledge/grant linkage, overfulfillment, award reduction below posted receipts and referenced grant deletion are rejected. Synchronous `BEGIN IMMEDIATE` transactions prevent partial batch writes and audit entries. Tests confirmed receipt edits, reversals and import rollback. |
| Historical data | `server/app.js:131` adds missing award fields as zero/null without inferring an award from requested amount or stage. `src/phaseThree.js:4–15` counts only explicit nonvoid Grant receipts within the receipt as-of date, enforces a recorded funder when present, and deduplicates financial record identifiers. Tests confirmed legacy amounts do not become income or inferred receipt links. |
| Stored text and exports | `src/features/TestingCenter.jsx:14` renders tester, observation, reproduction and notes through ordinary JSX text interpolation; it adds no raw HTML sink. A markup/SQL-shaped observation persisted as text without affecting tables. `src/features/TestingCenter.jsx:13` exports only feedback and scenario context, with an explicit manual-observation scope in JSON. `src/lib.js:34–40` quotes CSV cells, doubles embedded quotes and prefixes the tested formula markers `=`, `+`, `-`, `@`, tab and carriage return. |
| Information exposure | `server/app.js:147` health returns only status, version and mode with no-store caching. `server/app.js:177` restricts snapshots to administrators and selects public user fields; independent probes confirmed no password hashes, session hashes, session tables or CSRF values in the snapshot. Staff/viewer snapshot requests returned 403. The inspected built assets/public files contained no private-key, private-token, password-hash or session-hash material and no database/environment/source-map files. Published synthetic demo credentials are intentional for this local pilot. |

## Interpretation limits

Tester is an editable display label, and staff/admin may normally revise or delete feedback. This is the agreed manual feedback contract; the UI and JSON export explicitly describe observations rather than automated certification. These behaviors were not classified as identity attestation failures or privilege escalation.

The receipt as-of date scopes received amounts; the current recorded award is independently displayed. Grants without a recorded funder do not invent a donor restriction. These are the implementation's stated accounting rules and are covered by tests.

No source changes were made by this review. Security signoff for the scoped implementation has no material blocker; final archive freshness and browser handoff verification remain with the release owner.

## Later release-owner evidence

The independent review and its pending checks above remain a dated snapshot. The final owner-run combined suite passes 74/74 and the build succeeds. Clean client installation, evaluator isolation, connected grant receipt entry, board testing/read-only behavior, feedback persistence and desktop/mobile browser checks are recorded in VERIFICATION.md. Final distribution inventory and extraction evidence belong to that release record. No institutional certification or live integration approval follows from these local checks.
