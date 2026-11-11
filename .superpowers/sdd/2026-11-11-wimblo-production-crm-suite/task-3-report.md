# Task 3 implementation report

## Status

- Implementation complete and locally verified; independent task review remains required.
- No push, PR, deployment, provider mutation or paid feature was used.

## TDD evidence

- RED command: `node --test tests/production-crm-work.test.js tests/production-crm-timeline.test.js`
- RED output: 9 tests; 0 passed and 9 failed for absent migration 15, grants, transactional enqueue, work repositories and timeline.
- First GREEN command: `node --test tests/production-crm-work.test.js tests/production-crm-timeline.test.js`
- First GREEN output: 9/9 passed.
- Expanded focused command: `node --test tests/production-crm-work.test.js tests/production-crm-timeline.test.js tests/production-crm-work-http.test.js tests/production-crm-sales.test.js tests/production-crm-parties.test.js tests/production-jobs.test.js`
- Expanded focused output: 46/46 passed.
- The first full `npm test` passed 1,590/1,591 and exposed one legacy blanket-grant expectation. That test was updated to require SELECT/INSERT for retained event tables and SELECT/INSERT/UPDATE without DELETE for current work tables.
- Compatibility rerun: `node --test tests/persistence-migrations.test.js tests/production-crm-work.test.js tests/production-crm-timeline.test.js tests/production-crm-work-http.test.js` passed 22/22.

## Final verification

- `npm run test:production-foundation`: 117/117 passed; real PostgreSQL schema 15/15; 32 forced-RLS tenant tables; append-only, completion consistency, active attachment revision, cross-tenant and atomic reminder rollback negatives passed; TDD discipline 0 focused/0 skipped.
- `npm test`: 1,591/1,591 passed, 0 failed/skipped.
- `npm run build`: passed; pre-existing 511.71 kB chunk warning remains.
- `npm audit --audit-level=high`: 0 vulnerabilities.
- `git diff --check`: passed.

## Implemented behavior

- Migration 15 adds typed party/lead/opportunity subjects, immutable activities, versioned tasks and notes, exact object-revision links, one current owner, append-only history, forced RLS and lean work/timeline indexes.
- Existing subjects are backfilled and new party/lead/opportunity creation registers subjects inside the same transaction.
- Durable job enqueue can reuse the caller transaction; task state, task event and a minimal version-fenced reminder job commit or roll back together.
- Work routes enforce tenant session, role, CSRF and recent-auth boundaries; sales subjects additionally require the sales capability.
- Timeline pages are derived with UNION ALL from canonical facts, use an as-of keyset cursor bound to tenant and subject, and omit note bodies and storage topology.
- Attachment links require an exact active object revision and return only sanitized presentation metadata.

## Boundaries

- Reminder jobs are durable intents only; no delivery handler or delivery claim was added.
- No industry-wide retention duration was invented and no object bytes or storage credentials were duplicated.
- Local verification is not CI, deployment, production observation or customer acceptance.
