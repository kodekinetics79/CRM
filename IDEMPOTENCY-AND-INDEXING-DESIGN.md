# Idempotency and indexing — design decisions

September 16, 2026. Kode Kinetics LLC / Wimblo. Written before implementation, after a structured failure-shape review. Each decision below names the specific defect it prevents.

## Why now

The move to PostgreSQL on Neon adds a network hop (~10.7 ms per round trip, measured). Lost responses and client retries stop being theoretical, and every unindexed query now costs a round trip.

Measured at this checkpoint:

- **143** authenticated mutating routes; **12** modules carry explicit idempotency or replay guards.
- `POST /api/records/:collection` creates **gifts** with no idempotency key: a retry after a lost response duplicates revenue. `POST /api/gifts/import` has the same exposure in bulk.
- **24** sites load an entire collection then filter in JavaScript. Every gift create runs `list('gifts').some(g=>g.externalRef===x)`: O(n) per insert, O(n²) per import, and on Neon it ships the full gift history across the network for every row.
- **26** `json_extract` filters in `WHERE` clauses that no index can serve.

## Part A — idempotency

### A1. One authority: the commit marker lives inside the business transaction

*Prevents: two sources of truth that disagree.* A middleware that records "completed" separately from the gift write can disagree with it. If the gift commits and the process dies before the key row is written, a retry re-executes — creating exactly the duplicate this feature exists to prevent.

**Decision.** The middleware reserves the key and places it in request context (`AsyncLocalStorage`). The existing `transaction()` helper — the single path every mutation already uses — writes a commit marker for that key **inside the same transaction** as the business write. The marker is the only authority on whether the operation happened. The stored response body is a convenience layered on top of it, never a second authority.

### A2. No permanent lock-out after a crash

*Prevents: a one-way trap.* A key reserved as in-progress by a process that then dies would block that action forever.

**Decision.** An in-progress reservation older than its lease **with no commit marker** is released: because A1 makes the marker authoritative, "no marker" proves the write never committed, so re-execution is safe. An in-progress reservation **with** a marker but no stored response returns `409` stating the operation completed and the page should be reloaded. It never re-executes.

### A3. Refuse rather than guess

- Same key, different request body → `422`. Replaying a stored response for a different request would be a silent wrong answer.
- Concurrent requests with the same key → the second gets `409 in progress`.
- A response too large to store → recorded as completed without a body; a replay returns `409` with an instruction to reload. It is never truncated.
- Only responses from executed business logic are stored. `401`, `403`, `404`, `405`, `429` and `5xx` release the reservation, so a request rejected before it ran — for example by route-level CSRF, which runs after this middleware — can be retried correctly.

### A4. The guard belongs on the operation, and its limit is stated

*Prevents: a guard on a convenience method.* A header is opt-in: a client that omits it bypasses the guard.

**Decision and honest limit.**
- The frontend sends a key for **every** mutating request. Forms generate one key per form instance and replace it only after a successful save, so a double-submit or a retry collapses while a genuinely new gift gets a new key.
- For imported revenue, the operation-level guard is the **database**: a unique index on the source reference (Part B, B2) holds regardless of whether a client sends a header.
- Manual gifts without a source reference **cannot** be deduplicated at the operation level, because two identical $25 gifts on the same day are legitimate. They are protected only for participating clients. The header is not required server-side, because that would break existing API integrations; this limit is documented rather than hidden.

### A5. Bounded growth

*Prevents: defects that scale with input.* Every keyed request inserts a row. Unbounded, that pushes a workspace toward the 500,000-row backup ceiling — the same failure already found and fixed for public giving returns.

**Decision.** Idempotency records are operational, not evidentiary. Completed records expire after 24 hours and are **deleted** in bounded batches. Pruning is opportunistic and never throws into a request; a pruning failure is logged and counted, never allowed to block the queue.

### A6. Prove the path production actually runs

*Prevents: a test green on a shape production never emits.* All existing tests post without a key; production always sends one.

**Decision.** In addition to targeted tests, the full suite runs a second time with a harness that injects a unique `Idempotency-Key` on every mutating request, proving keyed behaviour equals unkeyed behaviour across all routes.

## Part B — indexing

### B1. Evidence before indexes

**Decision.** Capture every SQL statement the application actually executes across the suite, deduplicate, and read the plan on both engines at representative scale. Add an index only where a plan shows a scan of a table that grows. An index without a plan to justify it is cost without benefit.

### B2. The database is the authority for source-reference uniqueness

*Prevents: two sources of truth, and a race.* Today uniqueness is a JavaScript scan; two concurrent imports can both pass it.

**Decision.** A unique partial expression index on the gift source reference replaces the scan as the authority, making it race-proof on both engines. The JavaScript check is removed rather than kept alongside, so the two cannot disagree. The error message is preserved.

**Critical detail — the empty string.** Manual gifts store an empty `externalRef`. The index must exclude both `NULL` and `''`. Without that exclusion, the second manual gift ever entered would fail. Seeded fixture gifts all carry references, so a test built only on fixtures would pass while production broke; a test must use the real manual-gift shape.

**One-way edge, by design.** A voided gift keeps its source reference, so re-importing a corrected gift under the same reference is refused — as it is today. The exit is the retained financial-correction path, and the refusal message must say so.

### B3. Existing duplicates are refused, not silently resolved

**Decision.** If an existing workspace already contains duplicate source references, index creation must fail naming the conflicting gifts. It must never delete, merge or re-reference financial records to make an index build.

### B4. Equivalence, then speed

**Decision.** Every replaced scan is proven to return identical results to the scan it replaces on realistic data shapes — including type edge cases such as a reference stored as a number versus a string — and only then measured for speed.

### B5. Scale that matches the buyer

The fixture has 22 gifts. The buyer's stated volumes imply roughly 35,000 gifts over ten years, alongside 6,515 constituents and 1,622 designations. Plans and timings are measured at that scale, not at fixture size.

## Cross-cutting risk raised by this review

**A poisoned database handle must not become a permanent outage.** The synchronous PostgreSQL driver permanently poisons a handle after a timeout, correctly, because the shared buffer can no longer be trusted. But one poisoned workspace handle would then fail every later request until the process restarts — a stopped service that looks like an error storm. The adapter must rebuild a poisoned handle between requests and fail fast with `503` while it does. Combined with A1, a retry after reconnection can read the commit marker and know whether the ambiguous write actually committed.
