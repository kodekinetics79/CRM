# Task 2 implementation report

## Status

- Implementation complete and locally verified; independent task review remains required.
- Existing Task 1 fix-round changes were preserved and included.
- No push, PR, deployment, provider mutation or paid feature was used.

## TDD evidence

- Preserved partial implementation baseline: focused sales tests passed 13/13 before the independent SME gaps were encoded.
- RED: `node --test tests/production-crm-sales.test.js tests/production-crm-sales-http.test.js`
  - 17 tests; 11 passed and 6 failed for missing database invariants, append-only grants, terminal-stage rules, event pipeline identity and pipeline-stage reads.
- GREEN: `node --test tests/production-crm-sales.test.js tests/production-crm-sales-http.test.js tests/production-crm-migrations.test.js`
  - 22/22 passed.
- Added concurrent default-pipeline coverage; `node --test tests/production-crm-sales.test.js` passed 14/14.
- First real PostgreSQL verification reached schema 14 and correctly rejected the cross-pipeline stage, but the verifier expected the wrong application error classification (`CONFLICT` instead of `INVALID`). The verifier expectation was corrected; `npm run verify:postgres-foundation` then passed all gates.
- First full `npm test` exposed one legacy blanket-grant test after append-only privileges were tightened: 1,578/1,579 passed. The test was updated to require SELECT/INSERT for append-only event tables.
- Compatibility GREEN: `node --test tests/persistence-migrations.test.js tests/production-crm-migrations.test.js tests/production-crm-sales.test.js tests/production-crm-sales-http.test.js` passed 33/33.

## Final verification

- `npm run test:production-foundation`: 105/105 passed; real PostgreSQL schema 14/14; 24 forced-RLS tenant tables; cross-pipeline stage refused; tenant-B opportunity hidden from tenant A; unscoped and control-role reads refused; TDD discipline 0 focused/0 skipped.
- `npm test`: 1,579/1,579 passed, 0 failed/skipped.
- `npm run build`: passed; existing 511.71 kB chunk warning remains.
- `npm audit --audit-level=high`: 0 vulnerabilities.
- `git diff --check`: passed.

## Implemented behavior

- Migration 14 adds tenant-owned pipelines, ordered stages, leads, opportunities and append-only stage history.
- Database invariants bind stages to their tenant and pipeline, owners to tenant memberships, opportunities to leads, converted leads to opportunities, and history stages to the opportunity pipeline.
- Monetary facts remain exact non-negative integer cents bounded by `Number.MAX_SAFE_INTEGER`.
- Default pipeline creation is serialized and idempotent; open stages precede terminal stages; won is 100% and lost is 0%.
- New leads must start in an open stage; conversion and stage history share their enclosing transaction; stale versions roll back.
- Pipeline reads return ordered stages for board reconstruction.
- Application access to append-only party and opportunity event tables is SELECT/INSERT only; the control plane remains denied tenant business data.
- HTTP routes carry tenant, role and actor identity, enforce session/role/CSRF/recent-auth boundaries and return safe errors.

## Boundaries

- This is local implementation and verification, not CI, merge, deployment, production observation or customer acceptance.

## Fix round 1

- RED command: `node --test tests/production-crm-sales.test.js`
- RED output: 14 tests; 12 passed and 2 failed. The failures proved stage history lacked a composite opportunity/pipeline key and shuffled stage input was returned out of order. The revised concurrent test passed only because the modeled advisory lock serialized the critical section; unlike the prior test, `withTransaction` itself is concurrent, so removing the repository lock makes both transactions observe no default and attempt two inserts.
- Fixes: added `UNIQUE (tenant_id, pipeline_id, opportunity_id)` and a matching composite history foreign key; sorted normalized stages by position before inserts and response construction; replaced the transaction-serialized concurrency double with an advisory-lock-serialized double; added a real PostgreSQL negative for cross-pipeline opportunity history.
- GREEN command: `node --test tests/production-crm-sales.test.js && npm run verify:postgres-foundation`
- GREEN output: 14/14 focused tests passed; disposable PostgreSQL applied schema 14 and passed cross-pipeline stage, cross-pipeline history, cross-tenant, unscoped and control-role negatives.
- Final command: `npm run test:production-foundation`
- Final output: 105/105 production tests passed; real PostgreSQL verification passed; TDD discipline reported 0 focused and 0 skipped tests.
