# SDD ledger — plan: docs/superpowers/plans/2026-11-11-wimblo-production-crm-suite.md

## Execution state

- Base commit: `5322e739f3756df466c9059ddf486a847691d2e4`
- Branch: `feat/wimblo-crm-suite`
- Worktree: `.worktrees/wimblo-crm-suite`
- Spec reachable: `docs/superpowers/specs/2026-11-11-wimblo-modular-saas-design.md`
- Execution method: subagent-driven, requested independent SME logic/database/code review.
- Cost ruling: all implementation and verification remain local until Task 7; external promotion may use only existing no-new-cost services and must not activate a paid feature or upgrade.

## Baseline

- `npm install`: 0 vulnerabilities.
- First `npm test`: 1,539 passed / 4 failed because fresh worktree lacked `dist/`; no production files had changed.
- `npm run build`: passed; existing 511.71 kB chunk warning.
- Focused runtime tests after build: 14/14 passed.
- Full post-build baseline: 1,543/1,543 passed, 0 failed/skipped.

## Pre-flight conflict scan

| Tasks | Producer / consumer or internal check | Finding / ruling |
|---|---|---|
| 1 | Tests, migration 13, repository/service/routes agree on typed parties and tenant sessions | Clean. |
| 2 | Tests, migration 14 and sales behavior all consume Task 1 party IDs | Clean. |
| 3 | Tests, migration 15 and work behavior all consume canonical subject IDs and durable jobs | Clean. |
| 4 | Tests, migration 16 and reporting/import services consume Tasks 1-3 typed tables | Clean. |
| 5 | UI tests and production components consume Tasks 1-4 APIs | Clean. Evaluator remains separate. |
| 6 | Certification tests and script consume Tasks 1-5 | Clean. Truthful evidence boundary is explicit. |
| 7 | Provider inspection/promotion consumes Task 6 certified commit | Clean. External side effects are bounded by explicit user authorization and no-new-cost ruling. |
| 1 -> 2 | `crmRepository`, `crmService`, `crmRoutes`, migrations and grants are extended | Clean; later tasks must preserve Task 1 interfaces and tests. |
| 2 -> 3 | CRM repository/service/routes extended with work records | Clean; subject registry must not duplicate party/opportunity storage. |
| 3 -> 4 | Timeline/work facts feed reports/import/export | Clean; reports derive facts and do not create duplicate ledgers. |
| 4 -> 5 | Strict APIs feed capability-driven React UI | Clean; no UI-only authorization. |
| 5 -> 6 | Production UI/evaluation journeys become certification inputs | Clean; evaluation proof cannot be labeled production acceptance. |
| 6 -> 7 | Certification and handover become exact-SHA release evidence | Clean; local green is not deployment proof. |

## SME rulings

- Domain: build Party/Person/Organization and typed contacts before broader packs; make CRM core mandatory for active tenants. The implementation plan follows the ordering; core lifecycle protection is included in Task 1 review focus.
- Database: use typed PostgreSQL tables, composite tenant foreign keys, forced RLS, partial indexes, append-only events and optimistic versions; do not duplicate evaluator JSON ledgers. Adopted.
- Delivery: current checkpoint is a foundation, not a finished CRM. CI, deployment, backup, monitoring, UAT and acceptance remain distinct Task 6-7 gates. Adopted.

## Tasks

- Task 1: complete after fix round 1/5 and scoped re-review PASS.
- Task 2: implementation verified locally; independent review pending.
- Task 3: pending.
- Task 4: pending.
- Task 5: pending.
- Task 6: pending.
- Task 7: pending.

Task 1: implementation checkpoint (commits 98080f1..408d964, tests: npm run test:production-foundation → passed 85/85, PostgreSQL schema 13/RLS/tenant negatives passed, TDD discipline 0 focused/0 skipped; npm test → passed 1559/1559; npm run build → passed)

Task 1: independent review NEEDS_FIX — optimistic PATCH version stripped; party subtype mutable after insert; PATCH missing from CORS methods; create status silently ignored; contact body unnecessarily required path-owned partyId.

Task 1: fix round 1/5 (5 addressed, 0 open — scoped re-review PASS; the fix remains uncommitted only because pre-existing Task 2 edits overlap the same files and must not be discarded or stashed). Focused RED: 21/25 passed; GREEN: 25/25 passed.

Task 2: partial focused tests initially passed 13/13, but the production-foundation run exposed a forward-compatibility failure in the Task 1 migration test (97/98 passed). Added a future-safe migration-13 assertion, then added RED database-invariant expectations for composite pipeline-stage, tenant-bound ownership and conversion links (14/15 passed, expected RED). Database and CRM logic SMEs confirmed these are real gaps; no completion claim made.

Task 2: implementation checkpoint — extended RED 11/17 passed, final focused compatibility 33/33 passed, production foundation 105/105 plus real PostgreSQL schema/RLS/tenant negatives passed, full suite 1,579/1,579 passed, build passed, audit 0; independent review pending.

Task 2: fix round 1/5 (3 addressed, 0 open pending scoped re-review — composite opportunity/pipeline history FK; deterministic stage order; advisory-lock-sensitive concurrency test). RED 12/14; GREEN 14/14; production foundation 105/105 plus real PostgreSQL verification passed.
