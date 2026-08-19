# ADR 011 — Indexing scale: the target, the ladder, and where the exponent lives

- **Status:** Accepted. Indexing scales; the mechanism is identified and fixed (see also ADR 012).
- **Decided:** 2026-08-17 (scale target measured; the exponent chain closed 08-12 → 08-17)
- **Recorded:** 2026-08-19, backfilled from `IMPLEMENTATION_PLAN.md`
- **Evidence:** [`PLAN-EXCERPT.md`](proposals/indexing-scale/PLAN-EXCERPT.md) · [`EVAL.md`](proposals/indexing-scale/EVAL.md) · [`HANDOFF.md`](proposals/indexing-scale/HANDOFF.md) · `FINDINGS.md` §2.1–2.2 · `eval/results/e1*-verdict.json`

## Context

MAST is "**Monorepo** AST search". The scale target had never been made explicit, and several
decisions had already been taken as if it did not matter.

The measurement axis is a **nine-rung nested chunk ladder inside n8n** — T1 (3,679 chunks) →
T9 (73,359 chunks), 3 reps each. Nested, so the rungs are comparable; the five-repo panel that
originally looked like the axis was demoted to a **no-verdict replication panel**. The
super-linear bar was **b ≥ 1.35**, fixed before any measurement and never moved.

## Decision

**Name the target, measure against it, and localise the exponent to a phase before attempting
any fix.**

### The chain, end to end

| experiment | date | verdict | key number |
|---|---|---|---|
| **E1** | 08-12 | `SUPER_LINEAR` | b = **1.7529**, HC3 [1.6599, 1.8458]; lack-of-fit fires |
| **E1-PHASE** | 08-12 | H1 fires | the exponent is in **write**: b = **1.9685** |
| **E1-AB** | 08-13 | `CACHE_IMPLICATED` / PARTIAL | cache reduces but does not remove it |
| **E1-FTS** | 08-16 | `MECHANISM_IDENTIFIED` | `fts_del` is **91.7%** of T9's write phase |
| **E1-VERIFY** | 08-17 | `HOLDS` | the guard drops the ladder to b = **1.0825** |

Total build time grew at b = 1.75. E1-PHASE localised that to **write** (1.9685) while parse
stayed linear (1.0144) and walk was sub-linear (0.6019). E1-AB showed a 1024 MiB page cache cut
T9 write time by ~49% **and left the curvature** — so the cache was *implicated, not causal*,
and "the page cache is the exponent" is a dead hypothesis. E1-FTS then decomposed write into six
directly-timed spans and found one: `fts_del`, exponent **2.3454**, **91.7%** of T9's write phase.

**The mechanism.** `DELETE FROM chunk_fts WHERE file_path = ?` is a **full scan of the FTS5
table** — `xBestIndex` cannot consume an equality constraint on an ordinary column, so every
per-file delete scans the entire index. Cost per file grows with corpus size; the total grows
quadratically. The fix (`1dba79b`) skips the delete entirely when the file was never indexed.

**After the fix**, on E1's own ladder, 27 runs: b = **1.0825**, HC3 [1.0651, 1.0998], bootstrap
[1.0424, 1.1222] — all four intervals below the 1.35 bar. Lack of fit quiet (F = 1.9141,
p = 0.1264). `fts_del` **0 ms in all 27 runs**. T9: **538.6 s → 62.1 s**.

`chunk_fts_count === chunk_count` in **138 of 138** — the check that separates a correct guard
from a merely fast one. It is now `eval/e1-fts-invariant.mjs` and exits non-zero if it ever
breaks. A guard that skips *rows* rather than *work* would show the same timing win.

**Quote the adjusted fit** (`durationMs − c`) for E1 and E1-VERIFY — that is each one's
registered primary. Their `b_file` values are *supporting* outputs for a chunk-vs-file
comparison, and mixing the two families across a before/after pair is not like-for-like.

### The 150k target, measured

A single cold build of **vscode** at pin `5ebbe53` — a *different corpus*, so it extends the
panel and cannot join E1's nested fit. **No exponent is computed from it.**

8,653 files · **152,969 chunks** · 118,299 symbols · 174,844 edges · 793.8 MiB ·
**124,878 ms (2.08 min)**. `parse_errors` 0, `write_errors` 0, `fts_del` 0 ms.

Against a per-phase projection from T9: total **−9.0%**, walk −42.5%, parse −0.7%, write −28.7%,
**edges +21.7%** — everything beats projection except edges, which is ADR 012.

**The whale tail is recovered**: 152,969 − 138,440 = **14,529 chunks exactly**, the tail
Q1/SCALE had recorded as absent behind two write errors. The Stage 4.5 batching fix
(`SQLITE_MAX_VARIABLES = 32,766`, applied across 8 sites) is proven at real scale.

## Consequences

- **Indexing scales.** The headline claim is supported by a measured before/after on the same
  ladder, not by a projection.
- Stage 4.5's forward-looking analysis was written before E1 and before the vector deletion, and
  is **substantially superseded** — the STAGE 4.5 CORRECTION block governs it.
- Two claims in that analysis are now in `FINDINGS.md` §3 as refuted: "post-M1 chunk storage is
  O(N)" (false, then made true by repair) and "the vector subsystem is the only component that
  degrades".

## What this does not claim

E1-VERIFY's `fts_del = 0` is **not** evidence that incremental re-indexing is fixed. It is
evidence that a cold build has no existing files. The ladder is cold-build-only by construction
and structurally cannot see the incremental path — that gap is ADR 012's Stage 4.6.

The vscode build is one run of one corpus. It extends the panel; it does not fit a curve.
