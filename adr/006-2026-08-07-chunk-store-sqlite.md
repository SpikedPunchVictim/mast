# ADR 006 — Move chunk storage from Lance to SQLite

- **Status:** Accepted and shipped (M1). M2 resolved separately as **ADR 003**.
- **Decided:** 2026-08-07
- **Recorded:** 2026-08-19, backfilled from `IMPLEMENTATION_PLAN.md`
- **Evidence:** [`PLAN-EXCERPT.md`](proposals/chunk-store-sqlite/PLAN-EXCERPT.md) · `eval/m1-migration.json`

## Context

The chunk write path was O(n²) at its root, and the fix was not tuning — it was moving the data.
Measured on the spike: `nest --phase1-only` at **4.4 s** against Lance's **269–284 s**, with
state falling from **194 MB to ~17 MB** and the read set content-identical between arms.

## Decision

**Chunks live in `graph.db`, not in a separate `chunks.db`.**

The spike's own `chunks.db` was deliberately quarantined. M1 folds the `chunks` table into
`graph/db.ts`'s existing schema, so `populateFile` writes chunks in the **same per-file
`db.transaction()`** as `symbols`, `edges`, `imports`, and `chunk_fts`.

That is the whole point of the design, and it is **proven rather than asserted**:
`graph/__tests__/storage.test.ts` injects a failing chunk writer and asserts that a chunk-write
failure rolls back the *entire* transaction — no orphaned symbols, files, or FTS rows. Two
stores means two transactions means a crash window where the graph says a file has symbols and
the chunk store says it has no text.

A version-manifest-count assertion is meaningless post-migration; it was replaced with an O(N)
row-count/growth assertion.

## The M2 option set — framed here, decided in ADR 003

Three facts were verified in code before any option was weighed, and they reframed the question:

1. **Lance's chunk half was dead code post-M1** — seven methods with zero non-test callers. On
   disk, `.mast/lance/` held `vectors.lance` alone. `@lancedb/lancedb` (**91 MB** native) was
   being retained for exactly one table.
2. **The differentiator had never been switched on.** `grep -rn 'createIndex|IvfPq|ivf_pq|create_index' src/`
   → **0 hits**. The "Lance arm" was a brute-force scan behind a 91 MB native binary: Lance's
   costs, none of its ANN benefit.
3. Live calibration state: `graph.db` 129 MB, `vectors.lance` 25 MB, `embed_cache` 83 MB.

So the honest option set was **four arms, not three** — and two of them had no evidence at all:

| arm | | evidence at framing time |
|---|---|---|
| A | Lance **with IVF-PQ actually enabled** | **none** — never created |
| B | SQLite BLOB + JS brute-force cosine | 0.955 ms/864 vec → **169 ms** @153k; **470 MB** f32 |
| C | `sqlite-vec` | **none** — not a dependency |
| D | delete vectors entirely | none directly; strong circumstantial (ADR 002) |

**Arm B was eliminated on paper here**: 169 ms of scan against a `mast_search` p50 of 144 ms
more than doubles query latency at the real target, and 470 MB resident is not acceptable in a
task container. The 2026-08-01 batching falsification confirmed those inputs do not move — q8
and multi-process affect *build* time only, not query cost or memory.

M2 was then blocked on Q1 (ADR 002) and resolved as arm D (ADR 003). **The A-vs-C benchmark was
cancelled, not deferred.**

## What this does not claim

Arms A and C were never measured. Eliminating B is a measured result; choosing D over A and C
is a decision made *without* measuring them, and ADR 003 owns that — re-entry routes through an
A-vs-C benchmark at that time, on the then-current corpus.
