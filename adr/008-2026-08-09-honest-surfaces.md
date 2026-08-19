# ADR 008 — Honest surfaces: a tool reports what it does not know

- **Status:** Accepted and shipped (Stage 3.5, 2026-08-09; extended by Stage 7.2, 2026-08-06)
- **Decided:** 2026-08-09
- **Recorded:** 2026-08-19, backfilled from `IMPLEMENTATION_PLAN.md`
- **Evidence:** [`PLAN-EXCERPT.md`](proposals/honest-surfaces/PLAN-EXCERPT.md) · Stage 7.2 lives in [`vector-store-deletion/PLAN-EXCERPT.md`](proposals/vector-store-deletion/PLAN-EXCERPT.md)

## Context

The stage exists because two of its four defects were the same shape: **the tool lies about what
it did.** Against an agent consumer, that shape is more expensive than a crash — an agent has no
way to notice, and no way to retry.

| | | |
|---|---|---|
| F8 | `mast_project_skeleton` cost **~28 s/call**, 99% of it in `estimateFullFileBound` — an LRU capped at 200 thrashing against 1,334 files | ranked the **#2 betterment** of the R3 review |
| F9 | `mast init --extensions` / `--exclude` were **parsed and ignored**; `serve` then *overwrote* the persisted config | |
| M6 | `mast serve` silently bootstrapped an empty state dir and answered every query `{"results":[]}` | indistinguishable from "symbol doesn't exist" |
| C1 | confidence signals existed but only some of them (`resolution`, `reason`) | |

F8 is worth naming precisely: the orientation tool that the agent prompt tells the model to call
**first** was spending 99% of its latency computing a telemetry counterfactual.

## Decision

**Cap the work, not the cache. Honour a flag or delete it. Never return an empty result that
could mean two different things. Every uncertainty the system already knows about is surfaced
uniformly.**

### M6, and why the obvious fix was wrong

The naive repair — refuse to serve whenever the state dir is empty — **breaks the startup ladder
by design.** Step 3 opens the MCP transport and accepts queries *before* Step 4's background
reindex has filled the index, specifically so time-to-first-query stays in single-digit seconds
on a cold container. An empty state dir in that window is not a bug; it is the designed
container flow, and it converges within seconds. A blanket refusal would have broken every cold
start.

So the defect was split: **fail fast only where nothing can ever fill the index**
(`assertServableIndex`, a pure directly-testable function), and **flag honestly** where the
emptiness is a legitimate transient window. One defect, two causes, two different correct
answers — collapsing them would have traded a silent-wrong for a loud-wrong.

### C1 — the confidence signals, unified

`resolution` and `reason` already existed. `stale` / `file_busy` (ADR 005) and `truncated`
(ADR 007) were added so that every read tool carries the same vocabulary. Uniformity is the
point: a consumer that must remember which tools flag staleness and which do not will get it
wrong.

### Stage 7.2 — the surface after the vector store left

`mode` and `similarity_score` removed from responses and `_stats`; orphan-state cleanup on
startup; config keys removed; `hybridSearch` → `fusedSearch` renamed with its callers (as git
moves, so history follows). Suite **448 / 35** green at that point.

Two judgment calls were logged and ratified rather than made silently: `freshnessCause`'s
signature was **narrowed with its dead parameter removed**, not merely retyped; and
`metrics.mode` was **retained for historical rows** with new rows NULL — deleting the column
would have rewritten history that was true when recorded.

## Consequences

- A tool that cannot answer says so, in a vocabulary shared across tools.
- A flag that exists, works.
- `README.md` was found badly stale during 7.2 (documenting LanceDB, transformers, `mode`,
  `similarity_score`, embedding config keys) and carried into 7.3 scope rather than left.

## What this does not claim

F8 capped the *work*; it did not make `estimateFullFileBound` cheap. The telemetry
counterfactual is bounded now, not free.
