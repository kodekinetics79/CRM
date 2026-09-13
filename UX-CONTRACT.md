# Wimblo interface behavior

Visual roles live in [DESIGN.md](DESIGN.md); runtime colors are owned by `src/wimblo.css`. This document records observable behavior and canonical owners. Domain rules remain in `API-CONTRACT.md`, `PHASE-TWO-CONTRACT.md`, and the server.

## Business sources

| Concern | Source | UI consequence |
|---|---|---|
| Permissions | API-CONTRACT.md; server/app.js | Administrator controls are restricted; board business records are read-only. |
| Money and commitments | API-CONTRACT.md; PHASE-TWO-CONTRACT.md | Received contributions, commitments, and noncash values stay distinguishable. |
| Retention and deletion | API-CONTRACT.md | Financial gifts are voided with a reason; referenced records and reservation history remain protected. |
| Conflicts and persistence | API-CONTRACT.md | A stale version returns 409; refresh and reopen before retrying. |
| Evaluator scope | PRODUCT.md; API-CONTRACT.md | Synthetic records, local persistence, no live sending or payment collection; no institutional endorsement. |

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Select/Listbox | Native select elements in shared Fields and established workflows | Existing native-control implementation; DESIGN.md | Browser-owned popup; styled closed control | Browser keyboard and open-popup inspection |
| Date | Native date/time inputs in shared Fields and scheduling | API-CONTRACT.md and native input implementation | Browser-owned picker and locale; server calendar validation | Existing date/time tests and browser form inspection |
| Form | Shared Fields, RecordForm, GiftForm; established workflow submit handlers | Schema and server validation | Create/edit; browser constraint validation plus server domain errors | Existing API tests and browser form validation |
| Scrollbar | src/wimblo.css global baseline | DESIGN.md runtime-role mapping | Dark navigation track; light document and record tracks; forced colors | Computed styles and responsive browser inspection |
| Toast | Workspace notify and shared status toast in App.jsx | Existing workspace behavior | Saved changes and action feedback | Browser interaction/status inspection |
| CRUD | Workspace navigation/save/action; Records and RecordDetail | API-CONTRACT.md; PHASE-TWO-CONTRACT.md | Saved record detail; versioned edit; dedicated financial and scheduling actions | Existing API/integrity tests and browser navigation |

Table bulk selection is not offered. Native select/date popup geometry and locale remain platform-owned. This change does not replace domain validation or introduce a new interaction model.

## Navigation and recovery

- Main navigation opens the owning list/workspace and writes `?view=`. Record selection adds `record=`; back/forward uses those locations. About is `?view=about` and returns through the same navigation function.
- Create/edit uses the existing inline editor. Save prevents duplicate submission, shows pending text, and opens the saved record. Cancel returns without saving; dirty navigation uses the existing browser confirmation. Native confirmations remain a known limitation of the current evaluator, not a claimed custom-dialog implementation.
- Search is a local scan of loaded records, not an asynchronous provider search. It opens a matching record and supports Escape. List filters, sort, and density follow existing list state; only view/record are persisted in the URL.
- Failures remain visible and preserve editor values. Session expiry returns to sign-in with an explicit unsaved-change notice. A committed mutation followed by failed refresh is described as saved, with a request to reload.
- Screen guidance works through hover, keyboard focus, and click/touch disclosure. Native buttons and labels retain their semantics.
- Mobile navigation uses an inert workspace while open; Escape closes it and returns focus. Existing drawer behavior is preserved and is not represented as a complete modal focus trap.

## Current verification limits

WCAG 2.2 AA is a design target, not a certification. The new About page has no mutation, external submission, or new permissions. Its provider link opens a new tab with an explicit accessible label. Future providers and production approvals are described as separate acceptance work.

## Account access editor — 0.4.2 security pass

Settings owns the native inline Manage access form. Explicit role and Active/Suspended labels explain sign-in effects, preservation of records, all-device session termination and final-administrator guard before saving. Opening focuses role control; cancel returns focus to the originating account button. Backend enforces permissions/CSRF/version/lifecycle independently of UI; errors use the shared alert surface. Standard production hides acceptance navigation/actions, blocks direct testing routes and starts login without demo prefills unless server configuration explicitly permits synthetic demo access.
