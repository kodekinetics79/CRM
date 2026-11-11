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

## Independent review fix round 1/5

### TDD evidence

- RED command: `node --test tests/production-crm-work.test.js tests/production-crm-timeline.test.js tests/production-crm-work-http.test.js`
- RED output: 15 tests; 10 passed and 5 failed for the missing subject identity trigger, cross-type subject collision refusal, recorded-at timeline cutoff and strict cursor validation. The HTTP additions were coverage expansion for already-present route behavior.
- GREEN command: `node --test tests/production-crm-work.test.js tests/production-crm-timeline.test.js tests/production-crm-work-http.test.js`
- GREEN output: 15/15 passed, 0 failed/skipped.
- Adjacent compatibility command: `node --test tests/production-crm-parties.test.js tests/production-crm-sales.test.js`
- Adjacent compatibility output: 22/22 passed after the scripted fixtures were updated to model `INSERT ... RETURNING` from exact subject registration.

### Fixes

- Subject registration now accepts only an inserted row or an exact existing type/target identity; a UUID collision with another subject type returns a conflict and rolls back.
- Migration 15 now refuses updates to `subject_type`, `party_id`, `lead_id` and `opportunity_id` at the database layer while retaining mutable owner/version fields.
- Timeline sources now expose a canonical recorded timestamp and apply `recorded_at <= asOf` as well as the occurrence/keyset bound. The real PostgreSQL verifier inserts a backdated fact between page requests and proves it cannot enter the continuation.
- Cursor decoding now rejects noncanonical timestamps, out-of-range ranks, non-UUID keys, non-positive versions and a last timestamp after the snapshot before any SQL, using the generic invalid-cursor response.
- HTTP coverage now exercises all seven work mutations, including task PATCH and note revision POST, for viewer denial, CSRF, recent authentication and successful actor/artifact context propagation.

### Verification

- `npm run verify:postgres-foundation`: passed all 15 verifier steps; schema/ledger 15, 32 forced-RLS tenant tables, subject identity immutable, between-page timeline as-of stable, append-only refusal, active attachment revision, cross-tenant isolation and atomic reminder rollback.
- First `npm run test:production-foundation`: 119/120 passed; the sole failure was the unrelated timing-sensitive jobs assertion `heartbeats >= 2`.
- `node --test tests/production-jobs.test.js`: 12/12 passed on immediate isolation rerun.
- Final `npm run test:production-foundation`: 120/120 production tests passed, the embedded real PostgreSQL verifier passed, and TDD discipline reported 0 focused/0 skipped.
- `npm test`: 1,594/1,594 passed, 0 failed/skipped.
- `git diff --check`: passed.

No push, deployment, provider mutation or paid action was performed in this fix round.
