# DISCARDED — E1-VERIFY runs collected against a stale `dist/`

**Nothing in this directory enters any score.** It is retained as evidence, not as data.

## What happened

The FTS delete guard (`src/graph/populate.ts`, commit `43eb928`) was written, tested, linted
and committed. **`dist/` was never rebuilt.** The first two E1-VERIFY cells therefore measured a
binary from two days earlier, without the guard.

| | |
|---|---|
| `src/graph/populate.ts` | 2026-08-16 21:07:11 |
| `dist/graph/populate.js` | 2026-08-14 01:17:08 |

The only signal was `fts_del 956 ms` on a cold T2 build — a span the guard should have made
exactly zero. Had the guard's effect been subtler, or had the timing not been printed per run,
all 27 cells would have run against the wrong binary and been scored.

## Why no gate caught it

**Gate 0 verifies binary CONSISTENCY, not binary CURRENCY**, and it is worth being precise about
why it looks like it should have:

- Its `schema_version` check does compare the built binary against the source tree — but the
  version had not changed (`1.3.0` either way).
- Its content hash pins the binary across a **resume**. It detects `dist/` changing mid-schedule.
  It says nothing about whether `dist/` ever corresponded to `src/`.

A stale build is perfectly self-consistent. Every experiment in this program — E1, E1-PHASE,
E1-AB, E1-FTS — ran under the same blind spot.

## The fix

`distStalenessVerdict` (`eval/e1-common.mjs`) compares the newest `.ts` under `src/` against the
newest artifact under `dist/`, and `assertGate0` now throws when source is newer, naming the
offending file. Zero tolerance: `tsc` rewrites only outputs whose input changed, so a genuinely
current build always has some artifact at or after the newest source file. Pinned by
`eval/__tests__/e1-dist-staleness.test.mjs`.

## What is here

| file | what it is |
|---|---|
| `e1-verify-runs.jsonl` | the 2 completed runs (T2 rep 1, T1 rep 3), both against the pre-guard binary |
| `e1-verify-schedule.json` | the retired pin, carrying the stale `dist_hash` |
| `e1-verify-calibration.json` | `c = 18.5 ms`, measured on the same stale binary and therefore void |

The calibration is discarded along with the runs for the reason the driver already states: a
constant measured on a different binary biases the exponent, and it biases it DOWNWARD — toward
the answer the run wants.
