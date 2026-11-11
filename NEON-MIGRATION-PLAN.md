# Neon / PostgreSQL migration plan

September 16, 2026. Kode Kinetics LLC / Wimblo. Working engineering plan, not a status claim. The application today runs on embedded SQLite and continues to do so until every stage below passes.

## Why this shape

Measured surface at the current checkpoint:

| Surface | Count |
|---|---|
| Synchronous `db.prepare(...)` call sites | 2,159 across 40 modules |
| `CREATE TABLE` | 166 |
| `CREATE TRIGGER` using `RAISE(ABORT, …)` | 199 |
| Indexes (`CREATE [UNIQUE] INDEX`) | 55 |
| `json_extract(...)` | 59 |
| `PRAGMA` / `sqlite_master`+`sqlite_schema` / `VACUUM INTO` / `BEGIN IMMEDIATE` | 23 / 18 / 1 / 6 |

A conventional port means converting 2,159 synchronous call sites to `async`, which changes every transaction boundary and every guard that runs inside `BEGIN IMMEDIATE` — precisely the code that enforces "exactly one posted gift per settlement" and "no revenue duplication". That is the highest-risk possible rewrite of this codebase.

**Proven alternative.** PostgreSQL can be driven *synchronously* from the main thread: a worker thread owns the `pg` client and the main thread blocks on `Atomics.wait`. Verified against the real Neon instance on 2026-09-16:

```
worker online + connected in 149 ms   (async, once at startup)
SYNCHRONOUS query returned: neondb_owner | PostgreSQL 18.6
30 synchronous round trips: 321 ms | 10.7 ms each
5000-row synchronous read: 43 ms
```

One hard constraint discovered while proving it: **the worker must be online before the main thread blocks.** Node's worker bootstrap requires the parent event loop, so blocking immediately after `new Worker()` hangs forever. The handle is therefore created by an `async` bootstrap before `createApp` and injected.

This keeps all 2,159 call sites, all transaction semantics and all 1,366 tests intact. The work becomes a driver plus a dialect layer.

## Non-negotiables

1. The SQLite path stays the default and stays byte-for-byte behaviourally unchanged. `npm test` must remain 1366/1366 with zero skips at every stage.
2. The PostgreSQL path must pass the **same** suite, unmodified. A test may not be relaxed to accommodate a dialect difference; the dialect layer adapts instead.
3. Trigger refusal messages must match exactly. Tests and user-facing errors assert strings such as `Audit is append-only`; a PL/pgSQL `RAISE EXCEPTION` must produce the identical message.
4. Money stays exact integer cents. No float type may appear anywhere in the generated schema.
5. The application must not connect as the database owner. Neon's `neondb_owner` has `rolbypassrls = true`, which silently disables row-level security; a dedicated `NOSUPERUSER NOBYPASSRLS` role is required.
6. Nothing targets the hosted Neon instance during development. All work uses the local container `wimblo-migration-pg` on `127.0.0.1:57900`.

## Stages

**Stage 1 — synchronous driver.** `server/persistence/syncPostgres.js`, presenting the `node:sqlite` `DatabaseSync` surface the codebase actually uses: `exec(sql)`, `prepare(sql)` → `{get, all, run, iterate}`, `close()`, and the `isTransaction` property. `run()` returns `{changes, lastInsertRowid}`. Errors propagate with their message unchanged. A result larger than the shared buffer must fail loudly, never truncate.

**Stage 2 — dialect translation.** `server/persistence/sqliteDialect.js`: `?` → `$n`; `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`; `INTEGER PRIMARY KEY AUTOINCREMENT` → identity column; `json_extract` → `jsonb` operators; `sqlite_master`/`sqlite_schema` → catalog views; `PRAGMA` → no-op or equivalent; `BEGIN IMMEDIATE` → `BEGIN`; and the 199 `RAISE(ABORT, 'message')` triggers → PL/pgSQL functions raising the identical message.

**Stage 3 — run the real suite against PostgreSQL.** This is where the risk concentrates: SQLite is loosely typed and PostgreSQL is strict, so comparisons between integer and text, `0`/`1` booleans and implicit casts will surface. Fix in the dialect layer, never in the tests.

**Stage 4 — wire and cut over.** `createApp` accepts an injected handle; `server/index.js` bootstraps the PostgreSQL handle when `DATABASE_URL` is set and otherwise uses SQLite unchanged. Then: a dedicated non-owner Neon role, migrations applied explicitly, the existing `legacySqliteMigration` copy for any existing data, and deployment without a persistent disk.

## Stage 3 status — first full run of the unmodified suite on PostgreSQL

**1317 of 1457 tests pass (90.4%)** through the adapter and harness, with no test edited, on local PostgreSQL 17 (glibc, `--shm-size=1g`). A seeded `createApp` takes ~640 ms versus ~145 ms on SQLite, dominated by ~0.29 ms per round trip.

**Recovery from a poisoned connection works.** A backend terminated mid-transaction is detected with one probe, rebuilt off the blocked call path with exactly one rebuild, re-verified against its schema, and serving again in 34–58 ms. Calls during the rebuild fail fast with `503 WIMBLO_DATABASE_UNAVAILABLE`. An interrupted `COMMIT` is treated as not committed and every statement is refused until the caller rolls back, so no interrupted transaction can be mistaken for a completed one.

**The 140 failures, by cause:**

| Cause | Approx. tests | Status |
|---|---|---|
| **Silent:** mixed-case aliases lowercased (`AS sourceId` → `sourceid`, JavaScript reads `undefined`) | 2 failing, 16 sites | Routed to translator owner, priority 1 |
| **Silent:** ambiguous `ON CONFLICT … DO UPDATE SET col=col+…`; the telemetry path swallows the error, so production counters would stop recording unseen | 2 failing | Routed, priority 2 |
| Scalar `MAX(a,b)` (retention dates; `GREATEST` is not equivalent because it ignores NULLs) | ~9 | Routed |
| `json_set` untranslated | ~10 | Routed |
| Trigger bodies other than `SELECT RAISE` (test fault injection) | ~27 | Routed |
| `sqlite_schema` view scans every workspace's catalog (93 ms per lookup; one scale test exceeded 38 min) | ~2 | Routed; also a tenant-isolation improvement |
| `VACUUM INTO`, file copy/rename recovery, `EXPLAIN QUERY PLAN`, SQLite schema-text inspection | ~50 | No PostgreSQL analogue; Stage 4 backup/recovery redesign |
| CommonJS `eval` workers bypass the harness preload and open SQLite | ~8 | Harness limitation; cannot be fixed without editing tests |
| Deliberately committed dangling foreign key | 1 | Engine-specific exclusion (see below) |

**Application change made: workspace existence.** `server/platform.js` decided whether a workspace existed by checking for its SQLite **file** in five places. On PostgreSQL no file exists, so every workspace appeared missing — the filesystem answering a question the database owns. `server/persistence/openDatabase.js` now also exposes `databaseExists(path)`: the filesystem for SQLite, the schema catalog for PostgreSQL. Installing a non-file factory without an existence check is refused, so this cannot silently regress. `platform.js` no longer consults the filesystem for a workspace at all.

**Engine-specific fault injection, replaced rather than merely excluded.** Three platform tests simulate lost storage by deleting the SQLite file, which cannot represent loss on PostgreSQL. Excluding them would lose a real guarantee, so `tests/postgres/platform-lost-storage-postgres.test.js` proves the same property the PostgreSQL way — by dropping the workspace schema — and asserts the workspace refuses service, refuses sign-in, is **never silently recreated empty**, and stays visible in the control plane. Mutation-tested: forcing the existence check to always answer "exists" makes it fail with "a workspace with lost storage must refuse service".

## Cutover blocker: synchronous round trips freeze the whole instance

**Proven, not hypothesised.** Intermittent `ECONNRESET` failures on PostgreSQL were reproduced on demand and eliminated by two independent controls. The mechanism: the synchronous driver blocks Node's event loop; during a block longer than `server.keepAliveTimeout` (Node default 5 s) every idle keep-alive socket's timer expires; when the loop frees up the server closes those sockets just as the client reuses them. A two-process reproduction with a proxy-style client holding idle connections confirmed it: a 6 s block reset the idle connection, a 4 s block did not, and `keepAliveTimeout` 65 s survived blocks of 6 s and 20 s. **Behind Render's proxy this surfaces to users as intermittent `502`s.**

**Fixed:** `server/httpTimeouts.js` sets `keepAliveTimeout` 65 s and `headersTimeout` 66 s (refusing an inverted configuration), applied in `server/index.js`. Verified live: responses now carry `keep-alive: timeout=65`. **The proxy's actual upstream idle timeout must be confirmed on Render**; the value must exceed it.

**Not fixed, and a cutover blocker.** Keep-alive only stops the resets. While a request blocks the loop, every other user of that instance stalls. Measured locally at ~0.26 ms per round trip:

| Request | Round trips | Local block | At ~1 ms (co-located) | At 10.7 ms (measured to Neon) |
|---|---|---|---|---|
| `POST /api/migration/commit` (500-row part) | 19,583 | 7.1 s | ~20 s | ~210 s |
| `GET /api/migration/source-reconciliation` | 24,470 | 6.7 s | ~24 s | ~260 s |
| `POST /api/gifts/import` | 6,514 | 1.9 s | ~6.5 s | ~70 s |
| `POST /api/migration/preview` | 3,052 | 1.0 s | ~3 s | ~33 s |

On SQLite these are fast because each "round trip" is an in-process call. On PostgreSQL the same code shape freezes the application for minutes during the buyer's November migration. About 35% of round trips inside transactions are the adapter's per-statement savepoint, which exists to reproduce SQLite's statement-level failure semantics.

**Required before cutover:** convert the migration commit, reconciliation and import paths to set-based or batched statements, or move them off the request thread; and reduce or pipeline the per-statement savepoint. `pg` cannot pipeline today.

## Round 3 fixes

- **Catalog lookup scanned every workspace.** The adapter's `columnsOf` query cast `relname::text`, which prevents PostgreSQL using the `pg_class` name index, so each lookup read ~250,000 catalog rows because every workspace is a schema in one database — 32 ms per lookup, growing with the number of workspaces. Now 0.04–0.2 ms. A test runs `EXPLAIN` on the exact SQL the adapter sends and fails if the cast returns.
- **A fixture emitting a shape production never emits.** `tests/mailchimp-contact-sync.test.js` wrote an ISO date string into `mfa_settings.updated_at`, declared `INTEGER NOT NULL`; production writes a numeric clock value. SQLite's type affinity accepted it, PostgreSQL rejected it, and the "factor" branch then passed on PostgreSQL **for the wrong reason** — the rejection was caught and converted into the expected refusal, so the factor check never ran. The fixture now writes `Date.now()`. On PostgreSQL the file went from 13 to 14 of 15, and the rejection occurs zero times. The remaining failure is `VACUUM INTO`.
- **Latent flake on SQLite.** Three integrity tests snapshotted every table including timer-flushed telemetry, passing only when the flush landed outside the test window. They now exclude telemetry as `audience-access-integrity` already did. (This did not resolve the PostgreSQL resets; that cause was the catalog lookup above.)
- **`sqlite_schema` is now tenant-scoped** to the current schema, so a workspace cannot see another workspace's object names, and name lookups use the catalog index (69.9 ms → 1.6 ms).

## Correction recorded 2026-09-16: collation

The type audit reported that Neon uses linguistic glibc collation, so plain `ORDER BY` would silently reorder every list in production. That was relayed as confirmed. **Measured against the actual Neon database, it is wrong for ordering:**

| Engine | Locale | Plain `ORDER BY` of `Zebra, apple, Banana, éclair, Eagle` |
|---|---|---|
| Neon (production) | `C.UTF-8`, builtin provider | `Banana, Eagle, Zebra, apple, éclair` |
| SQLite (today) | code point | `Banana, Eagle, Zebra, apple, éclair` |
| Dev container | `en_US.utf8`, libc | `apple, Banana, Eagle, éclair, Zebra` |

The measurement found a different, real divergence instead — **case folding**:

| Expression | Result |
|---|---|
| Neon `lower('ÉCLAIR Zoë')` | `éclair zoë` (Unicode lowercasing) |
| Neon `lower('ÉCLAIR Zoë' COLLATE "C")` | `Éclair zoë` |
| SQLite `lower('ÉCLAIR Zoë')` | `Éclair zoë` (ASCII only) |

**Decision.** `COLLATE "C"` on text columns stays, justified by case folding: without it every `lower(name)` comparison, including duplicate detection and the `lower(name)` index, would treat accented names differently on Neon than on SQLite. It also makes ordering independent of whichever locale a future database is created with. The dev container intentionally remains on `en_US.utf8` as an adversarial locale: because the fix is locale-independent, proving it against the most divergent locale is the stronger test.

**Lesson recorded.** A claim about the production database was accepted from an audit and repeated without being measured. It should have been checked against Neon, read-only, before being reported.

## Decisions on the remaining dialect divergences

- **`tests/communication-workflow-reporting.test.js` fault injection.** The test deliberately disables foreign keys, drops a trigger and commits a dangling reference to prove the application answers `503` for corrupt data. PostgreSQL's transaction-scoped `SET CONSTRAINTS` cannot commit a dangling reference, and the only mechanisms that can (`session_replication_role`, or dropping and re-adding a constraint `NOT VALID`) require superuser or table ownership, which non-negotiable 5 forbids. This test injects a corruption that PostgreSQL makes structurally impossible, so it is recorded as an engine-specific exclusion for the PostgreSQL run, with this reason, rather than weakening the no-owner rule.
- **`COLLATE NOCASE` columns (`households.name`, `event_seating.name`).** ASCII case-insensitive equality and uniqueness match, so the duplicate-household guard holds. Two asserted divergences remain: ordering among punctuation, digits and non-ASCII names differs, and ICU treats `É` and `é` as duplicates where SQLite's ASCII-only NOCASE does not. The ICU behaviour is arguably more correct for a household-name guard; it is recorded as a divergence, not silently accepted as parity.
- **Text computed by an expression** still sorts by the database locale, because `COLLATE "C"` attaches to columns. No current `ORDER BY json_extract(...)` or `||` site exists. On Neon's `C.UTF-8` this already matches SQLite.

## Known risks, recorded before starting

- **Latency.** 10.7 ms per round trip from this machine to `us-east-1`. A request issuing 200 queries costs ~2 s. Co-locating the service with the database reduces this to low single-digit milliseconds, and batching hot paths may be required. This must be measured, not assumed.
- **Blocking model.** Each query blocks the event loop, exactly as SQLite does today, so a single instance serves one request at a time. Acceptable at the buyer's stated four-to-six users; it is a ceiling, and it should be stated rather than discovered.
- **Trigger fidelity.** 199 triggers carry the integrity guarantees. Every one needs a test that proves it still refuses, with the same message.
- **Type strictness.** The most likely source of silent behaviour change. Expect the bulk of Stage 3 effort here.
