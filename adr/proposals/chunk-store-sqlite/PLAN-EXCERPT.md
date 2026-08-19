## Stage 2: Chunk store migration (Lance → SQLite)
**Goal**: Remove the O(n²) write path at its root.
**Status**: Complete (2026-08-07) — M1 shipped earlier; M2 resolved as **arm D (delete)**
via the M2 DECISION MEMO (2026-08-04, below) and executed as Stage 7. The A-vs-C backend
benchmark was cancelled, not deferred (memo condition 6).

| # | Task | Status |
|---|---|---|
| — | Spike: env-gated `SqliteChunkStore` + measurement | **Complete** |
| — | `chunk_id` collision fix (prerequisite) | **Complete** |
| — | Loud write failure (prerequisite) | **Complete** |
| M1 | Promote SQLite store to default; retire the env gate | **Complete** |
| M2 | Decide vectors: Lance vs SQLite BLOB + JS cosine vs `sqlite-vec` | **Blocked on Q1** (see below) |

**Success criteria**: `nest --phase1-only` ≤ 82 s (measured spike: **4.4 s** vs Lance
**269–284 s**); state 194 MB → ~17 MB; read-set content identical between arms.
**Tests**: `store/__tests__/lance.test.ts` equivalent for the SQLite store; a
version-manifest-count assertion is meaningless post-migration — replace with an
O(N) row-count/growth assertion.
**Blocked on**: nothing. Both prerequisites shipped.
**Evidence**: §14.1 (why replacement not deletion), §15.1 (measurements).

### M1 result (`eval/m1-migration.json`)

**Design decision: chunks live IN `graph.db`, not a separate `chunks.db`.** The
spike's own `chunks.db` was deliberately quarantined; M1 folds the `chunks` table
into `graph/db.ts`'s existing schema so `graph/populate.ts`'s `populateFile` writes
chunks in the SAME per-file `db.transaction()` as `symbols`/`edges`/`imports`/
`chunk_fts` — proven, not asserted: `graph/__tests__/storage.test.ts` — "a chunk-write
failure rolls back the WHOLE transaction — no orphaned symbols/files/FTS rows" injects
a failing chunk writer and asserts zero rows land anywhere. `mcp/staleness.ts`'s JIT
refresh, which pre-M1 wrote chunks to Lance ONLY (a latent bug once SQLite became the
default — JIT edits would have been invisible to every reader), now goes through
`populateFile` alone and is correct by construction. `busy_timeout = 5000` was added
to `graph/db.ts`'s `openDatabase` (previously unset — found during E7) since SQLite is
now the sole chunk store and multi-process contention routes through it; F11 (lock
redesign) is unchanged/out of scope.

**Measured** (fresh state dirs, `mast-bench/m1-{common,nest,directus}-sqlite`):

| corpus | files | duration_ms | vs spike sqlite | state bytes | vs Lance baseline |
|---|---|---|---|---|---|
| nest/common | 189 | 435 | 388 | 2.6 MB | — |
| nest | 1,338 | 4,528 | 4,184 | 17 MB | 194–233 MB → 17 MB |
| directus | 2,085 | 10,732 | 8,791 | 33 MB | 409 MB → 33 MB |

All three land within ~20–25% of the spike's own SQLite-arm numbers (noise, not
regression) and reconfirm the O(n²) elimination: nest's manifest-free state is
**~11–13× smaller** than the Lance baseline, matching the spike's ~17 MB prediction
almost exactly. `chunk_count` matched the pre-migration Lance build exactly (5,030 =
5,030) with 0 parse/write errors on all three corpora — the chunk_id-collision defect
`store-spike.json` flagged (§ real-world case: `directus/app/src/shims.d.ts`) is
confirmed fixed.

**Read-set diff**: comparing against the 2-day-old `mast-state` Lance reference was
confounded — the live `nest` checkout had uncommitted edits to 14 files from earlier
E7 concurrency-test sessions, so BM25's corpus-wide statistics legitimately differed
between the two builds (score deltas, occasional tie-reorders — the exact mechanism
`store-spike.json` §"score_drift_explanation" documented, not a new defect). Re-ran as
a single-parse-pass, dual-write comparison instead (one `walkProject`/`extractFile`
pass over the CURRENT `nest` snapshot feeding both a Lance chunk table and the SQLite
`chunks` table from byte-identical `Chunk[]`, then diffing `hybridSearch` /
`getChunksByFilePath` / `collectPotentialMatchCandidates` with only the chunk-store
backend swapped): **0 content differences** — full chunk set identical (5,030 rows in
both arms, 0 parse errors), 20/20 `mast_search` queries identical, 5/5 `mast_exports`
files identical, 5/5 `mast_callers` symbols identical. See `eval/m1-migration.json`
for the full readout.

**New tests**: `graph/__tests__/storage.test.ts` (atomicity, 2 tests — the transaction
join above), `indexer/__tests__/chunk-store-growth.test.ts` (2 tests — chunk-row count
stays exactly equal to current live content across 10 rewrites of one file, and grows
by exactly 1 per incrementally-added file, replacing the meaningless
version-manifest-count check), `mcp/tools/__tests__/tools.test.ts` (`is_exported`
round-trips as a real `boolean`, not `0|1`, through the full `mast_search` MCP
response, not just the store's own unit test).

### M2 framing (2026-08-01) — the option set is four arms, and two have no evidence

**Three facts verified in code before any option was weighed:**

1. **Lance's chunk half is dead code post-M1.** `LanceStore.replaceChunksForFile`,
   `deleteChunksForFiles`, `getChunksByFilePath`, `chunkCount`, `getAllChunks`,
   `getChunksByIds`, and `ensureChunksTable` have **zero non-test callers** — every
   consumer routes through `SqliteChunkStore`. On disk `.mast/lance/` now holds
   `vectors.lance` alone. So `@lancedb/lancedb` (**91 MB**,
   `@lancedb+lancedb-darwin-arm64@0.27.2`) is retained for exactly one table.
2. **The differentiator has never been switched on.** `grep -rn
   'createIndex|IvfPq|ivf_pq|create_index' src/` → **0 hits**, re-confirmed
   2026-08-01 (§14.1 found the same in R3). Today's "Lance arm" is a brute-force
   scan behind a 91 MB native binary: Lance's costs, none of its ANN benefit.
3. **Live state for calibration**: `graph.db` 129 MB, `vectors.lance` 25 MB
   (~4,280 of 14,449 chunks embedded), `embed_cache` 83 MB.

**Therefore the honest option set is four arms, not three:**

| arm | | measured evidence today |
|---|---|---|
| **A** | Lance **with IVF-PQ actually enabled** | **none** — never created |
| **B** | SQLite BLOB + JS brute-force cosine | 0.955 ms/864 vec → **169 ms** @153k; **470 MB** f32 |
| **C** | `sqlite-vec` | **none** — not a dependency |
| **D** | **Delete vectors entirely** | none directly; strong circumstantial (Q1) |

**Decided on paper now: arm B is eliminated, and [R6]'s retraction holds.** 169 ms of
scan against a current `mast_search` p50 of 144 ms more than doubles query latency at
the real target, and 470 MB resident is not acceptable in a task container. The
2026-08-01 batching falsification confirmed these inputs do not move — q8 and
multi-process affect *build* time only, not query cost or memory.

**A vs C cannot be decided today and no further prose will decide it** — both arms
have zero measurements. Choosing between them from reasoning alone would be the
"invent a number" anti-pattern the global process rules forbid.

**Sequencing decision: Q1 gates M2.** Arm D dominates A/B/C — a "no" on Q1 deletes the
91 MB dependency, the 7.2 h embed, the 470 MB, the forked embedder, and the whole
cold-start `mode: "lexical"` ladder, making the backend question moot. Q1 is also
cheaper than an A-vs-C benchmark. So Q1 runs first; A vs C is benchmarked only if Q1
justifies the subsystem.

---

