# MAST findings index

**Every settled empirical claim about MAST's scaling and retrieval behaviour, in one place, with a
pointer to the evidence that settles it.**

`IMPLEMENTATION_PLAN.md` is ~10,000 lines and is a *plan*: it records registrations, amendments and
RESULT blocks in the order they were written. It is the authoritative record and this file does not
replace it. But it is chronological, not topical — answering "what do we already know about the
edges phase?" means reading fourteen experiment blocks and reconstructing the answer. This file is
that reconstruction, maintained.

**Scope.** Coverage begins at the Q1 retrieval program and the E1 scaling program. The pre-deletion
embedding-model bake-off (`eval/results/*__fp32.json`, `truncation.json`, `task9-score-*.json`,
2026-07-10; documented in `eval/README.md`) is deliberately **not** indexed — Stage 7 deleted the
subsystem it was selecting for. Note that `eval/README.md` is itself stale for the same reason.

---

## The rule

**Before writing a pre-registration, read this file.** Specifically §1 (unread data) and §3 (dead
hypotheses). A registration is not complete until its author has stated, in the registration itself,
that they checked both — and what they found.

This rule exists because of a concrete, expensive failure. **E1-EDGES** was registered on
2026-08-17 to test whether the edges phase's super-linearity was a page-cache effect. It was
retired the same day, before a single measurement, because the adversarial design review found that
**E1-AB had already run that exact lever, on the same corpus, at the rungs E1-EDGES' own conditions
read (T5 and T9), with a 2× stronger arm** —
and its answer (ALGORITHMIC, not cache) had been sitting in `eval/results/e1-ab-runs.jsonl` since
2026-08-13. E1-AB recorded `phase_ms.edges` on all 30 of its runs and scored only `write_ms` and
`duration_ms`. The data was committed, complete, and unread.

Twenty minutes of analysis on already-committed data retired a 30-run experiment. That ratio is why
§1 is the first section in this file and not an appendix.

---

## 1. The register of unread data

Measurements that are **recorded in committed journals and read by no scorer**. Each row is a
question that may already be answerable without running anything.

| Series | Where it is recorded | Scoreable rows | Read by | Status |
|---|---|---|---|---|
| `potential_call_count` | all five journals | **144** | `e1-unread-fit.mjs` (e1-verify's 27 only) | see 1.1 |
| `phase_ms.*` (all 5 phases) | `e1-ab` 30, `e1-fts` 30, `e1-verify` 27 | **87** | **`e1-unread-fit.mjs` — all 87** | **CLOSED 08-17**, see 1.2 |
| `write_spans.*` (6 spans) | `e1-verify` | **27** | **`e1-unread-fit.mjs`** | **CLOSED 08-17**, see 1.4 |
| `chunk_fts_count`, `identifier_fts_count` | `e1-verify` 27, `e1-ladder` 27, **`e1-hoist` 60** | **114** | nothing (the 27/27 identity check in §2.1 is hand analysis) | **still open and now 4.2x its original size**, see 1.4 |
| `external_ms` | all five journals | 144 | `e1-schedule.mjs` only, for scheduling — never scored | low value |
| guard-era per-phase exponents | `eval/vscode-build.mjs` constants | — | **`e1-unread-fit.mjs` reproduces all five** | **CLOSED 08-17**, see 1.3 |
| `symbol_count` | all five journals | 144 | runners only; descriptive | unscored by design |
| `edge_count` | all five journals | 144 | `e1-unread-fit.mjs` (ms/edge, edges/chunk) | partly read |
| `measurement.wal_boundary`, `measurement.stderr_lines` | all five journals | 144 | nothing | diagnostics-grade; not a measurement series |

`eval/e1-unread-fit.mjs` → `eval/results/e1-unread-fit.json` (2026-08-17) fits every series above that
arithmetic alone could close. It is **descriptive, not registered** — no hypothesis, no threshold, no
verdict — and it adjudicates nothing. Its value is that six numbers this program had been quoting
from prose are now reproduced by a script that fails loudly if they stop reproducing.

**`file_count` is NOT in this register** — it is scored. `e1-score.mjs:220` fits
`xFile = log(file_count)`, which *is* the `b_file` / `file_fit` in `e1-verdict.json` and
`e1-verify-verdict.json`; `:173` validates it and `:254` aggregates it for trigger t4.
`db_bytes` (trigger t3) and `parse_errors` (t4) are likewise read. An earlier revision of this
table listed `file_count` as descriptive and unscored; that was wrong, and it was wrong in the
one section this file's own rule tells you to trust.

Verified 2026-08-17 by enumerating every key in each `eval/results/*-runs.jsonl` and grepping the
five scorers for it; corrected 2026-08-17 after adversarial review. To re-verify after adding a
journal, repeat that diff — and grep the *scorers*, not just the runners, before calling anything
unread.

**Re-run 2026-08-17 for the sixth journal, `e1-ladder-runs.jsonl` (27 runs).** It records the same
`measurement.*` shape as the others, so it adds no new *kind* of unread series — but it does enlarge
one: `chunk_fts_count` / `identifier_fts_count` doubles to **54 rows** (task #7). Its primary
series (`phase_ms.edges`, `chunk_count`, `file_count`) is read by `e1-ladder-score.mjs`. Two caveats
on the method, stated so the next person does not over-trust it: the grep matches key **names across
all scorers**, so a name read for one journal counts as read everywhere, and `stdout_tail`,
`stderr_tail`, `env`, `resolved_config`, `wal_boundary`, `exit_status`, `state_dir`, `project_root`
and `extra_args` remain diagnostics rather than measurement series and are not tracked here.

**`e1-ladder` rows carry BOTH `tier` and `corpus`**, deliberately, so neither grouping convention can
reproduce the collapse trap described below.

**Re-run 2026-08-18 for the seventh journal, `e1-hoist-runs.jsonl` (60 runs).** Key-for-key
**identical in shape to `e1-scan-runs.jsonl`** — it introduces no new series and therefore no new
unread ones. Its primary (`phase_ms.*`, all five phases, both arms) is read by
`e1-hoist-score.mjs`, which fits every phase: `edges` as the registered outcome and the other four
as H3's placebo control. It enlarges exactly one open row, `chunk_fts_count` /
`identifier_fts_count`, from 54 to **114** (task #7) — that row has now grown with every journal
added since it was opened, which is an argument for closing it rather than re-counting it again.
`potential_call_count` is recorded on all 60 and is **deliberately unread by the scorer**: §1.1's
warning was quoted in the registration and, this time, obeyed.

**Count rows, not lines, and then subtract the dead ones.** A journal line is not a run: the files
carry `attempt_start` records, gate rows and calibration rows alongside measurements, so `wc -l`
over-counts by roughly 2×. But filtering on `r.measurement?.phase_ms != null` is still not the
scoreable *n* — it admits **voided and superseded** runs. `e1-fts-runs.jsonl` holds 31 `type:"run"`
rows plus 1 `type:"void"` (G#T3#b1, tiling below floor) *and* a superseded duplicate
(`A#T3#b1`, listed in the verdict's `superseded`), so the naive filter returns 32 where the scorer
scores 30 (n=15 per arm). Cross-check any *n* against the matching `-verdict.json` before quoting it.

**Not every journal keys runs the same way.** `e1-verify` rows have **no `tier` field** — the rung
label is `corpus` (`T1`…`T9`), which `e1-verify-score.mjs:46` renames to `tier` at the seam before
handing the runs to the shared scorer. Grouping its 27 runs by `tier` silently collapses all nine
rungs into one bucket, and taking a median then returns T5's value while looking like a ladder-wide
figure. Group by `corpus` or by `chunk_count` — both are stable, and `chunk_count` is identical
across all three reps of a rung (the tiers are deterministic nested subsets).

**Not every field is at the top level.** `e1-verify` rows lift `chunk_count`, `file_count`,
`edge_count` and `symbol_count` out of `measurement` onto the row — but **not**
`potential_call_count`, which exists only at `measurement.potential_call_count`. Reading it from the
top level yields `undefined`, and any rate built on it silently becomes `NaN`. Fits should refuse a
non-positive series rather than drop it; `e1-unread-fit.mjs` reports `non_positive_values`, which is
how this trap was caught rather than published.

**And `measurement.phase_ms` is NOT the scored value — the top-level `phase_ms` is.** On a run where
Gate 3 failed, `selectFitted` puts the **fitted** attempt at the top level and leaves the **last raw
attempt** under `measurement`. Reading `measurement` therefore scores the wrong attempt on precisely
the runs the retake machinery exists to handle. `e1-verify` has exactly one such row — T3 rep 3,
**240 ms fitted vs 233 ms raw** — and because it is not T3's median, it moves the 27-point fit
(1.3823 instead of 1.3814) while leaving the rung-median fit identical. That asymmetry is the
diagnostic: *medians agree, all-runs does not* means an attempt-selection bug, not an arithmetic one.

Audited across all seven journals: **no committed scorer reads `measurement.phase_ms`**, so no
published result was affected. Divergent rows by journal — **`e1-ladder` 3/27**, `e1-verify` 1/27,
`e1-ab` 0/30, `e1-fts` 0/31, `e1-phase` 0/15, `e1-scan` 0/24, **`e1-hoist` 0/60**. The three in `e1-ladder` are exactly
its Gate 3 triple-failures (T3#2, T4#2, T4#3), which is the expected pattern: divergence is possible
only where a retake was fitted.

Caught by `e1-ladder-score.mjs`'s self-check, which refuses to score unless it reproduces
`e1-unread-fit.json` to 1e-9 — **a cross-script reproduction assertion is worth more than a comment
saying the estimators match.**

> **This paragraph itself carried the error once.** Its first draft claimed `e1-ladder` 0/27. That
> audit was run before the ladder journal existed, and the zero was pattern-matched from the other
> five rather than measured; the adversarial recomputation required before commit (§11.8) caught it
> pre-publication. A count for an artifact that did not exist when you counted is not a count.

### 1.1 `potential_call_count` — recorded on 144 scoreable runs, never read

Recorded by `readGraphCounts` (`eval/e1-common.mjs:688`) into all five journals. It appears in
`e1-common.mjs`, `e1-p0-build.mjs`, `e1-run.mjs` and `e1-phase-run.mjs` — all **runners**. No
scorer, no report, no verdict file references it.

**What it is, precisely:** `SELECT COUNT(*) FROM edges WHERE edge_type='POTENTIAL_CALL'`. It is a
**surviving-row count after primary-key dedup** — an *output*, not a work counter. It is **not** the
number of `resolveCallTarget` invocations, and dividing a phase time by it does not yield a
per-call cost. (This is the same trap `edge_count` sets, recorded once already: both count rows
that survived, not work performed.)

**What it nonetheless shows**, median per tier across E1's ladder:

| tier | chunks | POTENTIAL_CALL rows | per chunk | share of all edges |
|---|---|---|---|---|
| T1 | 3,679 | 953 | 0.259 | 49.7% |
| T3 | 7,761 | 2,011 | 0.259 | 51.7% |
| T5 | 16,529 | 4,641 | 0.281 | 51.4% |
| T7 | 34,691 | 10,903 | 0.314 | 52.9% |
| T9 | 73,359 | 27,127 | 0.370 | 55.9% |

POTENTIAL_CALL rows grow **super-linearly in chunks** — endpoint log-log slope ≈ 1.12 across T1→T9.
Their share of all edges trends upward but is **not** monotonic: across all nine rungs the rate runs
0.259, 0.258, 0.259, 0.275, 0.281, 0.291, 0.314, 0.329, 0.370 rows/chunk — flat over the first three
rungs, then climbing.

> **[CORRECTION, 2026-08-18 — this paragraph said the opposite, and it was wrong.]** It read:
> *"`POTENTIAL_CALL` is what the resolver emits when it cannot pin a call to a definite target, so
> this says: at larger corpora a growing fraction of call sites fail to resolve."* **Both halves are
> inverted.**

A stored `POTENTIAL_CALL` row is a **successfully resolved** call. The evidence is the code, not a
column: `populate.ts:728-736` computes `to_id` from `callToMap` and then `if (to_id === undefined)
return []` — an unresolved call produces **no row at all**. On the emit side the extractor pushes a
`POTENTIAL_CALL` candidate only in the `edge_emitted` bucket, i.e. only when `resolveCall` already
linked the callee (`src/ast/extractors/typescript.ts:1344-1360`). The edge type names the *class of
call that needs file-evidence resolution*, not a resolution failure.

*(A `to_id IS NULL` count is **not** evidence here and was briefly mistaken for it: `edges.to_id` is
declared `INTEGER NOT NULL`, so zero nulls is vacuous. The code path is the evidence.)*

So the rising rate 0.259 → 0.370 rows/chunk says the opposite of what was recorded: **at larger
corpora a growing fraction of call sites successfully resolve** — which is the sensible direction,
since a bigger corpus contains more of its own dependency targets.

**The section's headline warning survives and is strengthened.** The count is still not a work
counter, and now for a sharper reason: it omits every *failed* resolution attempt, and those cost
time while leaving no trace. The count is a record of successes; the work includes the failures. It
does not measure the phase's cost, and must not be presented as if it does.

**CLOSED (2026-08-17).** Two readers, and the distinction matters. `eval/e1-unread-fit.mjs:178-179`
already fits it as `potential_call_share` and `potential_call_per_chunk` over e1-verify's 27 rows —
both *ratios of counts*, which is a sound use. `eval/e1-scan-score.mjs` is the first to divide a
**phase time** by it, as an explicitly labelled descriptive normaliser and never as a per-call cost.

*(The sentence opening this subsection — "No scorer, no report, no verdict file references it" —
was already stale when E1-SCAN read it: it predates `e1-unread-fit.mjs`, and §1's own table above
records the newer state. Corrected here rather than left to contradict the table. E1-SCAN's
registration repeated the stale claim, asserting it was "the first reader of the field"; the
registration is append-only, so that error is corrected in the RESULT block, not edited away.)*

**The warning above then proved itself, the hard way.** E1-SCAN's H3 used this count to argue a *floor*: rows grow at local slope
1.3072 over T8→T9, so a per-row cost flat in F must leave a ≥1.31 slope behind. No such floor
exists — the measured post-fix slope is **1.1051**, below it, because post-fix cost per surviving
row *falls* with scale (117.5 → 96.1 → 88.2 → **81.7** µs). Unresolved calls are cheaper per row
than resolved ones, and their share rises with corpus size, so normalising by them overstates work
at the top of the ladder. H3 was refuted for precisely the reason this section names. **The trap
was quoted in the registration and walked into anyway** — treat any argument that routes through
this count as suspect, including one that cites this warning.

### 1.2 `phase_ms` outside E1-PHASE — 87 unscored runs, including a full guard-era ladder

`phase_ms.{walk,parse,write,edges,finalise}` is recorded on 102 scoreable rows, of which **15** are
fitted by `e1-phase-score.mjs` across all five phases.

One partial exception, easy to miss: `e1-fts-score.mjs` does not merely read `phase_ms.write` as a
denominator — it **fits** it, at `:265-266`, producing `b_write_a` and `b_write_g`, and
`b_write_g = 1.0956` is condition 4 of the E1-FTS verdict. So e1-fts's `write` column is scored.
Its other four phases are not. `e1-ab-score.mjs` and `e1-verify-score.mjs` fit no phase at all.

| journal | rows | rungs | what is unscored |
|---|---|---|---|
| `e1-ab` | 30 | 3 (T1/T5/T9) | all five phases, across a **512× SQLite cache range** |
| `e1-fts` | 30 | 5 | all but `write` (arms A and G, guard off/on) |
| `e1-verify` | **27** | **9** | all five — **the complete post-guard per-phase ladder** |

`e1-ab`'s 30 rows are what retired E1-EDGES. `e1-verify`'s 27 are the larger prize and were missed
for a duller reason: they have no `tier` field, so every by-tier query returns them as one bucket.
It is the only full nine-rung per-phase ladder measured against the shipped binary, and **no scorer
touches it.**

Before registering anything about any phase, fit these first.

### 1.3 Guard-era per-phase exponents exist only in prose

E1-VERIFY re-fitted the ladder against the FTS delete guard and produced a total-duration verdict
(`eval/results/e1-verify-verdict.json`). Its **per-phase** slopes were computed by hand during the
session and survive only as prose and hardcoded constants:

- `b_write = 1.1136` — `IMPLEMENTATION_PLAN.md:5551` (RESULT prose) **and** `vscode-build.mjs:63`.
- `b_duration = 1.0789`, `b_edges = 1.3949`, `b_walk = 0.6108`, `b_parse = 0.9929` — projection
  constants in `eval/vscode-build.mjs:60-64`.

**The estimator is settled** (2026-08-17): per-rung **median**, OLS on the nine `(log chunks, log ms)`
points. `e1-unread-fit.mjs` reproduces **all five constants**, largest deviation `4.9e-5` — pure
4-dp rounding. The script asserts them on every run and exits non-zero if any stops reproducing, so
these are no longer prose.

> **[Correction, 2026-08-17]** An earlier revision of this section reported that `write` lands at
> 1.1117 against 1.1136 and `duration` at 1.0791 against 1.0789, and drew a live consequence from
> the gap. **There is no gap** — the median estimator returns 1.113618 and 1.078941, reproducing
> the recorded constants.
>
> **[Second correction, same day, adversarial review]** The first correction went on to explain the
> old pair as "simply miscomputed by hand", having checked only the median and mean estimators.
> **That etiology is wrong, and the error was systematic rather than manual.** Two specific
> estimator faults reproduce the old numbers to 4 dp:
>
> | old figure | estimator that reproduces it | value |
> |---|---|---|
> | `write` 1.1117 | per-rung-median OLS **with rung T6 dropped** | 1.111717 |
> | `duration` 1.0791 | per-rung-median OLS on **`measurement.duration_ms`** (not top-level) | 1.079053 |
>
> A simultaneous 4-dp match on two independent series is not coincidence. The earlier session was
> almost certainly **dropping a rung** from the fold, and reading `duration_ms` from a different
> field than the one it reported. That matters far more than "hand error" would: a selection bug
> silently touches *every* number derived in that session, whereas a hand slip tells no one where
> else to look. **Any other figure first derived on 2026-08-17 in that session should be re-derived
> against a nine-rung fold before it is quoted.**
>
> Note this is *proof of an estimator that reproduces the numbers*, not proof of provenance — the
> session's actual code was not recovered. Recorded as the most probable cause, not a certainty.
> This is the failure `.claude/CLAUDE.md` §11.1 names, and the follow-on is the §11.3 one: having
> found *an* explanation, the first correction stopped instead of asking what else would fit.

Fitting all 27 runs instead of nine medians gives `edges = 1.3814`, `write = 1.1193` — close, but
not the same number, and the two families must not be mixed. (An earlier revision quoted the
all-runs `edges` as 1.3823; it is 1.3814.)

One consequence remains live:

- **The edges exponent has two values, and they are not interchangeable.** E1-PHASE's scored
  **1.4360** (pre-guard, HC3 [1.2333, 1.6388]) and the guard-era **1.3949** (median family) /
  **1.3814** (all-runs, HC3 [1.2180, 1.5449]). Any claim about the edges exponent must say which it
  uses. The guard-era pair is now fitted but still **descriptive** — `e1-unread-fit.mjs` registers
  no threshold and returns no verdict.

One minor data note, recorded so a later fit does not trip on it: in exactly **1 of 27** rows
(T3 rep 3) the top-level `duration_ms` is 5587 against `measurement.duration_ms` 5551, a 36 ms
(0.6%) difference. Every other row agrees exactly. It does not move the median fit; a mean-based
fit would see it.

### 1.4 E1-VERIFY's spans and FTS counts — 27 rows, nothing reads them

`e1-verify-runs.jsonl` carries the six `write_spans` (`fts_del`, `fts_ins`, `commit`, `rest`, `txn`,
`lock`) on all 27 runs — the only **post-guard, nine-rung** span decomposition that exists. It is now
fitted (`e1-unread-fit.mjs`), all-runs family, HC3 in brackets:

| span | `fts_del` | `fts_ins` | `commit` | `rest` | `txn` | `lock` |
|---|---|---|---|---|---|---|
| b | *degenerate* | **1.1110** | **1.1888** | **1.0344** | 0.9475 | 1.0121 |
| HC3 | — | [1.0989, 1.1230] | [1.1730, 1.2046] | [1.0143, 1.0545] | [0.9053, 0.9896] | [0.9813, 1.0430] |

**The finding is that there is no finding: post-guard, no write span is super-linear.** The largest
is `commit` at 1.19, well under the 1.35 bar, and the write phase's own 1.1193 is consistent with a
sum of near-linear parts. Whatever remains in the write phase is not another `fts_del`.

`fts_del` is **degenerate, not zero-exponent** — it is 0 ms in all 27 runs, so `log(0)` is undefined
and no slope exists. The fit reports `non_positive_values` and refuses to emit a number. A scorer
that silently dropped those rows would publish an exponent fitted on an empty series.

The same journal's `chunk_fts_count` and `identifier_fts_count` **remain unread** — this fit does not
close them. §2.1's "`chunk_fts_count === chunk_count` in 27 of 27" is still hand analysis, not a
scorer output.

---

## 2. What is settled

### 2.1 Indexing scale — the headline

The cold-index ladder is **nine nested subsets of n8n**, T1 (3,679 chunks) → T9 (73,359 chunks), 3
reps each. The super-linear bar is **b ≥ 1.35**, fixed before any measurement and never moved.

| experiment | date | verdict | key number |
|---|---|---|---|
| **E1** | 08-12 | `SUPER_LINEAR` | b = **1.7529**, HC3 [1.6599, 1.8458]; lack-of-fit fires |
| **E1-PHASE** | 08-12 | H1 fires | the exponent is in **write**: b = **1.9685** |
| **E1-AB** | 08-13 | `CACHE_IMPLICATED` / PARTIAL | cache reduces but does not remove it |
| **E1-FTS** | 08-16 | `MECHANISM_IDENTIFIED` | `fts_del` is **91.7%** of T9's write phase |
| **E1-VERIFY** | 08-17 | `HOLDS` | guard drops the ladder to b = **1.0825** |

Quote the **adjusted** fit for both E1 and E1-VERIFY — that is each one's registered primary
(`durationMs − c`). E1's `b_file = 1.7558` and E1-VERIFY's `b_file = 1.0837` are *supporting*
outputs, used for trigger 5's chunk-vs-file comparison, and mixing the two families across a
before/after pair is not a like-for-like comparison.

**The chain, end to end:** total build time grew at b = 1.75. E1-PHASE localised that to the write
phase (b = 1.97) while parse stayed linear (1.0144) and walk was sub-linear (0.6019). E1-AB showed a
1024 MiB page cache cut write time at T9 by ~49% but left the curvature — so the cache was
implicated, not causal. E1-FTS decomposed write into six directly-timed spans and found one:
`fts_del`, with its own exponent of **2.3454**, consuming 91.7% of T9's write phase. E1-VERIFY
re-ran the whole ladder against the fix and returned `HOLDS`.

**The mechanism.** `DELETE FROM chunk_fts WHERE file_path = ?` is a **full scan of the FTS5 table**:
`xBestIndex` cannot consume an equality constraint on an ordinary column, so every per-file delete
scans the entire index. Cost per file therefore grows with corpus size, and the total grows
quadratically. The fix (`43eb928`) skips the delete entirely when the file was never indexed.

**Result of the fix**, measured on E1's own ladder, 27 runs:

- b = **1.0825**, HC3 [1.0651, 1.0998], bootstrap [1.0424, 1.1222] — all four intervals below 1.35.
- Lack of fit **quiet**: F = 1.9141, p = 0.1264, departure 1.40%.
- `fts_del` = **0 ms in all 27 runs** (max 0, sum 0).
- `chunk_fts_count === chunk_count` in **27 of 27** — the guard skips *work*, not rows. This is the
  check that separates a correct guard from a merely fast one.
- T9: **538.6 s → 62.1 s**.
- Write's share of T9 fell from **94.01%** to **51.3%**; parse is now **34.5%**.
  (`IMPLEMENTATION_PLAN.md:5552` says 36.3% — that figure does not reproduce from the journal;
  per-rep T9 parse/duration is 34.04 / 34.49 / 34.48%. Corrected inline in the plan.)

**Indexing scales.** Evidence: `IMPLEMENTATION_PLAN.md` §§ E1 / E1-PHASE / E1-AB / E1-FTS /
E1-VERIFY RESULT blocks; `eval/results/e1*-verdict.json`.

### 2.2 The 150k target, measured

A single cold build of **vscode** at pin `5ebbe53` — a *different corpus*, so it extends the panel
and cannot join E1's nested fit. No exponent is computed from it. `eval/results/vscode-build.json`.

8,653 files · **152,969 chunks** · 118,299 symbols · 174,844 edges · 793.8 MiB · **124,878 ms**
(2.08 min). `parse_errors` 0, `write_errors` 0, `fts_del` 0 ms.

Against a per-phase projection from T9: total **−9.0%**, walk −42.5%, parse −0.7%, write −28.7%,
**edges +21.7%**. Everything beats projection except edges.

**The whale tail is recovered.** 152,969 − 138,440 = **14,529 chunks exactly** — the tail Q1/SCALE
recorded as absent behind two write errors. The Stage 4.5 S1 batching fix (SQLITE_MAX_VARIABLES =
32,766, applied across 8 sites) is proven at real scale.

### 2.3 The edges phase — CLOSED as a scaling question (2026-08-17)

**Settled by E1-SCAN and E1-LADDER.** The `files` prefix scan was the exponent; removing it makes
the phase linear. Post-fix exponent **1.0184** (all_runs, n=27, R² 0.9817, `se_hc3` 0.0351), against
a pre-fix **1.3814** on the same nine rungs — `eval/results/e1-ladder-verdict.json`, RESULT at
`IMPLEMENTATION_PLAN.md` § E1-LADDER RESULT. Leave-one-rung-out spans **[0.9944, 1.0449]**, so
`b ≈ 1.02` is quotable to three figures; E1-SCAN's four-rung `b ≈ 1.0–1.1` is superseded, not
contradicted.

**One residual candidate survives and is not resolved:** a top-half-only fit (T5–T9) gives
**1.1692** against a bottom-half **0.8982**. Unregistered, 15 runs a side, not separable from this
session's noise — but it is where a real residual would show, and it is the reason §2.3 is closed
as a *scaling* question rather than closed outright. More reps per rung would settle it; more rungs
would not.

#### The import-index hoist — a real constant factor inside the now-linear phase (2026-08-18)

Separate from the scaling question above and settled independently. `importResolvedPathFor` ran one
`imports` query per distinct call name per file, re-reading and re-parsing rows that were invariant
across the file. `08b0cd8` builds one index per file, lazily.

**E1-HOIST, 60 runs, 30 paired blocks at T9** — `eval/results/e1-hoist-verdict.json`, RESULT at
`IMPLEMENTATION_PLAN.md` § E1-HOIST RESULT:

- **Paired median ratio 0.9087**, 95% BCa [0.8860, 0.9495] — a **9.13% reduction** in the edges
  phase. Geometric-mean secondary 0.9192 [0.8725, 0.9684], pre-registered, agrees.
- **Median saving 219.0 ms**, against a replay forecast of 87.1 ms that was declared a *lower* bound
  before the run. Direction predicted, magnitude under-predicted 2.5x.
- **Placebo control holds**: `walk` 1.0072, `parse` 1.0030, `write` 0.9987, `finalise` 0.9964 — all
  four CIs contain 1.0, at 12–16 of 30 blocks each, against edges' 25/30.
- Distribution-free confirmation (post-hoc): exact sign test **p = 3.2e-4**.
- **Gate C: the arms build a byte-identical graph** — `file_count`, `chunk_count`, `symbol_count`,
  `edge_count` and `potential_call_count` each a single value across all 60 runs at 73,359 chunks.

**It is immaterial to wall-clock and always was**: ~0.4% of a T9 build by the measured saving,
0.151% by the replay's. The registration **refused a total-duration A/B as unpowered** (~1,091
blocks per arm) before running anything, and that refusal stands — no claim about total build time
comes from this experiment. What it establishes is that the effect is real, confined to the phase it
should touch, and output-preserving.

The rest of this section is the pre-fix record, retained because it is what the next registration
starts from.

- Scored exponent **1.4360**, HC3 [1.2333, 1.6388] (E1-PHASE, pre-guard). The CI **straddles 1.35**.
  E1-PHASE's H2 (edges carries the exponent) **did not fire** — its bar was 1.6.
- Guard-era descriptive slope **1.3949** (see §1.3 — unscored).
- **There is a knee.** From `e1-verify`'s nine-rung guard-era ladder, ms/edge by rung:

  | chunks | 3,679 | 5,332 | 7,761 | 11,278 | 16,529 | 23,854 | 34,691 | 50,299 | 73,359 |
  |---|---|---|---|---|---|---|---|---|---|
  | ms/edge | .0589 | .0563 | .0592 | .0567 | .0569 | .0656 | .0764 | .1117 | **.1753** |
  | edges/chunk | .522 | .526 | .501 | .518 | .546 | .563 | .594 | .605 | **.661** |

  Flat at ~0.057 through 16.5k chunks, then it climbs 3.1× over the last four rungs. Per-edge cost
  is **constant until it isn't** — that shape is the thing to explain.
- vscode sits at 0.165 ms/edge with edges/chunk = **1.14** — 1.73× n8n's density. Most of vscode's
  +21.7% overshoot is edge *density*, not per-edge slowdown.
- POTENTIAL_CALL rows per chunk rise 0.259 → 0.370, share 49.7% → 55.9% (§1.1).
- `resolveCallTarget` is called at `src/graph/populate.ts:698`, declared at `:782`.

**The exponent decomposes, and the larger part is per-edge cost.** An exact identity, since
`edges_ms = (ms/edge) × (edges/chunk) × chunks`:

```
b_edges  =  b_msPerEdge  +  b_edgesPerChunk  +  1
1.3814   =    0.3016     +     0.0798        +  1     (all-runs family)
1.3949   =    0.3151     +     0.0798        +  1     (median family)
```

So **79% of the excess over linear is each edge getting dearer**, not more edges being emitted per
chunk. That is a constraint on any mechanism proposed here: an explanation in terms of emission
volume is arguing about the smaller term.

Two honesty notes on how much this is worth. **The identity itself cannot fail** — OLS is linear in
`y` and the slope of `log C` on `log C` is 1, so the three fits sum by construction (residual
2e-16). It is an arithmetic check, not a result; the *split* between the two terms is the finding.
And **"per-edge cost" is not a synonym for "a mechanism other than the scan"** — the `files` scan
below runs per resolver call and therefore lives *inside* the per-edge term. The decomposition
separates per-edge cost from emission volume; it does not separate one mechanism from another.

#### The `files` prefix scan — a confirmed defect, an unconfirmed attribution

`resolveInFileOrReExportChain` (`src/graph/populate.ts:954-959`) looks its target file up with
`WHERE path LIKE '<resolvedPath>%' ORDER BY path ASC`. Against the shipped schema this is a **full
scan**, and it is the *only* scan among the resolver's lookups:

| query | plan |
|---|---|
| `files WHERE path LIKE ?` | **`SCAN files USING COVERING INDEX sqlite_autoindex_files_1`** |
| `files WHERE path = ?` | `SEARCH … (path=?)` |
| `symbols WHERE name = ? AND file_id = ?` | `SEARCH … idx_symbols_lookup` |
| `symbols WHERE name = ?` | `SEARCH … idx_symbols_lookup` |
| `imports WHERE file_id = ?` | `SEARCH … idx_imports_file` |

Measured with `EXPLAIN QUERY PLAN` against the real 152,969-chunk vscode database, 2026-08-17.
The cause is SQLite's LIKE optimization, which is **disabled** when `case_sensitive_like` is off
(the default, and this repo sets no such pragma) and the candidate index uses BINARY collation —
which `files.path TEXT NOT NULL UNIQUE` (`src/graph/db.ts:234`) does. The function is on the
`import` resolution path (`:812`), the qualified-receiver path (`:886`) and RE_EXPORTS resolution
(`:723`), so it runs per unique `toName` per file.

Confidence, apportioned (`.claude/CLAUDE.md` §11.5):

- **Measured** — the query plan is a scan, on the shipped schema, at target scale.
- **Inferred** — that this scan is a large and growing share of the edges phase. `edges_ms/(edges ×
  files)` falls 89.8 → 13.2 **ns** across the ladder and flattens over the top three rungs (12.79,
  12.49, 13.15 ns), the `a/F + b` shape a per-call O(files) scan predicts once it overtakes a
  constant baseline. The implied baseline, ~0.05 ms/edge, matches the flat part of the ms/edge
  curve. (An earlier revision gave these in **µs** — a 1000× unit error. `113 ms / (1919 × 656)` is
  8.98e-5 ms = 89.8 ns. The shape of the argument is unaffected.)
- **Superseded as an inference — and its conclusion is now refuted by measurement.** A two-term
  model `edges_ms = a·E + b·E·F` cannot fit both ends of the pre-fix ladder under any weighting,
  and that was read as "something else is also super-linear." **E1-LADDER tested that claim
  directly: post-fix the phase is linear (b = 1.0184 over nine rungs).** There is no unnamed
  super-linear second mechanism at n8n scale. The model's misfit is a statement about the model.

  **Recomputed by `e1-ladder-score.mjs` (descriptive section of `e1-ladder-verdict.json`), and two
  of the four figures this file previously carried in prose do not reproduce:**

  | prose claim | recomputed | verdict |
  |---|---|---|
  | relative weighting under-predicts T9 by 23% | −22.7% | reproduces |
  | unweighted fits T9 to −1.1% | **+3.0%** | **does not reproduce** — wrong sign |
  | unweighted misses T1 by −74% | **−82.2%** | **does not reproduce** |
  | vscode under-predicted 30–37% either way | −28.6% / −36.9% | partially — one end outside |

  Unweighted `a = 1.7053e-3, b = 1.3416e-5`; relative-weighted `a = 4.5985e-2, b = 6.7132e-6`. The
  weighting-independent statement stands and now has a script behind it: **no single `(a, b)`
  describes the whole ladder.** The provenance of the two non-reproducing figures cannot be
  reconstructed, because no script ever computed them — which is the §11.1 argument in miniature.
- **Unmeasured** — the actual call count and the actual time inside the scan. No counter exists for
  either. (The *residual* is no longer in this list: it was measured, and it is ~0.02.)

#### The scan is also a correctness bug, and there are two of them

> **[Correction, 2026-08-17, adversarial review]** An earlier revision of this section claimed a
> **"provably behaviour-preserving"** fix: probe `path = resolvedPath` first, fall back to LIKE on a
> miss, on the argument that among prefix matches the exact match always sorts first. **That proof
> is false.** Its premise holds only for case-sensitive, wildcard-free LIKE, and this is neither.

`resolvedPath` is interpolated into the pattern **unescaped**, so any `_` in a real path is a
single-character wildcard; and default LIKE is case-insensitive while the index sorts BINARY. Both
counterexamples below were verified against SQLite — in each, the exact path **exists** and the
current query returns a **different file**:

| files present | `resolvedPath` | LIKE returns | exact returns |
|---|---|---|---|
| `src/my.util.ts`, `src/my_util.ts` | `src/my_util.ts` | **`src/my.util.ts`** | `src/my_util.ts` |
| `src/FOO.ts`, `src/Foo.ts` | `src/Foo.ts` | **`src/FOO.ts`** | `src/Foo.ts` |

`.` (0x2E) sorts before `_` (0x5F), and `FOO` before `Foo`, so `ORDER BY path ASC` hands back the
wrong row first. **This is not only a performance defect — the resolver can bind an edge to the
wrong file**, and snake_case paths make the first case routine rather than exotic. That reframes
the fix: it is a *bug fix requiring a semantics decision* (escape the pattern, or convert to a
range query, and decide whether case-insensitive matching was ever intended), not a free swap.

**There are two such scans, not one.** The second is in `insertReExportFiles`
(`src/graph/populate.ts:1088-1092`), which runs **inside the `phase.edges` timing window**
(`src/indexer/index.ts:475` opens it, `:486` closes it). Fixing only the resolver leaves an
identical O(files) scan in the same measured phase. The two are not interchangeable: the resolver's
LIKE is documented as defensive because the import resolver returns extension-inclusive paths,
whereas `insertReExportFiles`' own comment (`:1086-1087`) says `resolved_path` **may lack an
extension**, so there the prefix match is load-bearing and an exact probe would miss.

**Neither should be shipped on the strength of the fit above** — the residual says the fit is
incomplete, and this program's rule is instrument first.

**Before registering anything here:** §1.2's **87** unscored runs of `phase_ms.edges` are now fitted
(`e1-unread-fit.mjs`) — start from that artifact, not from a new run. And the phase must be
**instrumented before it is A/B'd** — registering a lever against an unidentified mechanism is
precisely what produced and then retired E1-EDGES. (An earlier revision of this line said 89; the
count is 87, per §1.2.)

#### The next step, as revised by adversarial review (2026-08-17)

**A semantics decision gates everything else.** The two LIKE sites are not merely slow, they can
return the wrong file, so no fix is a free swap. Three options, none yet chosen:

| option | fixes the scan | fixes the wrong-file bug | changes behaviour |
|---|---|---|---|
| add an `ESCAPE` clause | no — still scans | wildcard case only | minimal |
| exact probe, then escaped LIKE | at `:957` only (`:1091` needs the prefix) | wildcard case only | the wrong-file cases, which are bugs |
| range query `path >= p AND path < p‖0x10FFFF` | **yes, both sites** | **yes, both cases** | drops case-insensitive matching |

The range query is the only option that fixes both defects at both sites. Its cost is that
case-differing paths stop matching — which is almost certainly correct (nothing documents
case-insensitive path matching as intended; it is a side effect of default LIKE), but it is a
**deliberate semantics change and must be decided, not assumed**.

**The instrument-first plan was judged heavier than needed.** The cheaper decisive test: apply a
candidate fix and build once at T8 and once at T9, fix vs no-fix. The edges phase is 3.4 s and
8.5 s there, so the scan's share is measured directly with no instrumentation risk. If the phase
*is* instrumented instead, the observer effect is negligible (~100 ns/call against an 8.5 s phase)
— but the counters must cover **both** LIKE sites and `resolveThroughStarChain`, or the split will
be attributed wrongly. Keep T1 as a cheap anchor; the knee starts at T6.

**The residual does not gate the fix.** Naming what else is super-linear is required before any
"the curve is explained" claim, but a confirmed correctness-and-performance defect does not need
its residual explained before it is repaired.

Still unmeasured and unnamed: the residual itself; `importResolvedPathFor` JSON-parses every import
row of the file on **every** resolver call, which is per-call CPU that `EXPLAIN` cannot see and is a
live candidate for the constant baseline.

#### DECIDED and SHIPPED: the range query, at four sites (2026-08-17)

The semantics decision above was taken: **the range query**. Case-insensitive path matching is
withdrawn deliberately.

**The site census in the table above was wrong — there are four prefix-match sites, not two.**
Enumerating every `'like'` in `src/` (rather than only the two already under discussion) found two
more, both with the same two defects:

| site | function | note |
|---|---|---|
| `graph/populate.ts:958` | `resolveInFileOrReExportChain` | the resolver; the measured `SCAN` |
| `graph/populate.ts:1093` | `insertReExportFiles` | inside the `phase.edges` window |
| `graph/queries.ts:485` | `resolveTypeContext` | **missed by the earlier census** |
| `graph/queries.ts:569` | `queryProjectSkeleton` | **missed**; prefix is *caller-supplied*, so `%` or `_` in a directory argument silently widened the filter |

(Line numbers are post-fix — each row points at the `>=` bound that replaced the `LIKE`.)

`search/fts.ts:55` also builds a LIKE pattern but is deliberately **left alone**: `globToLike`
translates a user glob, where the wildcards are the point.

Shipped as `graph/path-range.ts` (`pathPrefixUpperBound`) plus the four rewires, with nine tests in
`graph/__tests__/path-prefix-match.test.ts`. All four wrong-file counterexamples were reproduced as
failing tests against the shipped code **before** the fix, including the end-to-end one: a
`POTENTIAL_CALL` edge binding to `src/my.util.ts` when the import named `src/my_util.ts`.

**Measured.**

* The plan changes at the resolver site: `SCAN files USING COVERING INDEX sqlite_autoindex_files_1`
  → `SEARCH … (path>? AND path<?)`, confirmed on the 8,651-file vscode DB with **bound parameters**
  through `better-sqlite3`, not just literal SQL.
* Over 16,848 distinct prefixes drawn from the vscode `files` table (full paths, directory prefixes,
  extension-stripped variants), the range selects **exactly** the same set as a correctly-escaped
  `case_sensitive_like=ON` LIKE. Zero disagreements.
* **No behaviour change on any real corpus.** Comparing old-LIKE against new-range resolution of
  every internal resolved import: **0** regressions (old matched, new does not) and **0** wrong-file
  differences (both matched, different first row). vscode contributes 79,884 such imports and n8n T9
  22,248 — 102,132 distinct; T8 (9,558) and T1 (43) are nested subsets of T9 and are not added to
  that total.

**Inferred, not measured.** The wrong-file bug is real and unit-demonstrated, but it is *latent* in
every corpus checked — none of these repos names two files differing only by case or by `.`/`_`. The
correctness argument for the fix therefore rests on the counterexamples, not on observed corruption.

**MEASURED — the performance claim is settled, and §2.3's headline question is CLOSED.** E1-SCAN
(2026-08-17) built both arms in detached worktrees and ran 24 cells: 2 arms × 4 rungs × 3 blocks,
interleaved with the arm order flipping between blocks. **The scan was the edges exponent.**

| rung | files | no-fix | fix | ratio |
|---|---|---|---|---|
| T1 | 656 | 111 | 112 | 0.991 |
| T5 | 2,880 | 502 | 446 | 1.126 |
| T8 | 8,945 | 3,473 | 1,461 | **2.377** |
| T9 | 13,330 | 8,824 | 2,217 | **3.980** |

The edges exponent (OLS on medians, 4 rungs) goes **1.4382 → ≈1.0** — quoted as a range,
**b ≈ 1.0–1.1**, because re-slicing gives 0.9785–1.1051 and four significant figures would be false
precision. Arm N over the same slices runs 1.2989–2.4709. The T8→T9 local slope collapses
**2.4709 → 1.1051**. Cleanest single view: the edges share of total index time, no-fix
4.53 → 4.27 → 8.51 → **13.53%**, fix 4.67 → 3.84 → 3.76 → **3.85%** — flat.

At T9 this is **11.6% of total build time** (65.2 s → 57.6 s). Arm N reproduces E1-VERIFY within
±4%, and the T1/T5 controls (0.991, 1.126) rule out a spurious global speedup. Full RESULT in
`IMPLEMENTATION_PLAN.md § E1-SCAN RESULT`.

**A named residual risk.** On a case-insensitive filesystem a mis-cased import (`./foo` for
`Foo.ts`) yields a `resolvedPath` in the *specifier's* casing while the walker records the *on-disk*
casing; LIKE papered over that, the range will not, and the edge is silently dropped. This is not
hypothetical — `realpathSync` was measured on this machine and does **not** canonicalize case. It is
unobserved in all four corpora (the 0/102,132 above), and TypeScript's default
`forceConsistentCasingInFileNames` makes it a compile error in a well-formed TS project, but mast
indexes arbitrary repos and JS has no such guard.

**Now measured on a full corpus, not just inferred.** E1-SCAN's Gate C required both arms to agree
on `file_count`, `chunk_count`, `symbol_count`, `edge_count` and `potential_call_count` at every
rung, and **all five matched at all four**, including T9's 13,330 files (48,497 edges, 27,127
`POTENTIAL_CALL`). The regression did not bite. **Read the limit precisely: Gate C compares counts,
not sets** — two graphs can share a cardinality and differ in membership. The set-level evidence is
the 0/102,132 import comparison above; counts-identical *plus* sets-identical is what the claim
rests on, neither alone. The risk is not retired (n8n is one well-formed TS monorepo), but task #9
now has a measurement under it.

**A footgun worth knowing.** SQLite's BINARY collation is `memcmp` over UTF-8; JavaScript's `<`
compares UTF-16 code units, and the two disagree — U+FFFF sorts *above* the surrogate pair for
U+10FFFF. The bound is valid for SQL comparison only. A first draft of the helper's unit test
asserted the JS ordering and failed against a correct bound; the test now compares UTF-8 bytes.

### 2.4 Open: the incremental path still pays the full-scan delete

**The FTS guard fixes cold builds. It does not fix incremental re-indexing.** `populate.ts:503`:

```ts
const fileHadPreviousVersion = existing !== undefined;
if (options.skipFtsDeletes !== true && fileHadPreviousVersion) { /* the two DELETEs */ }
```

The delete is skipped only when the file was **never indexed**. A cold build has no existing files,
so it skips 100% of them — which is why `fts_del` is 0 ms in all 27 E1-VERIFY runs. Re-indexing a
*changed* file still runs both deletes, and each is still a full FTS5 table scan whose cost grows
with the whole corpus. A changed file is by definition one already indexed, so this is the
defining case of incremental work.

`removeDeletedFiles` (`populate.ts:1116`, deletes at `:1129-1130`) runs the same two full-scan
deletes per *deleted* file, unconditionally. It must — the FTS5 virtual tables do not participate
in the foreign-key cascade — but it carries the same per-corpus cost.

**The fact was already known in three places**; what was new on 2026-08-17 is the contradiction
with Stage 4.5. `e1-fts-verdict.json`'s `what_this_is` says the guard "licenses nothing about the
UPDATE path"; the CLI refuses `--unsafe-skip-fts-deletes` together with `--incremental`
(`src/cli/index-cmd.ts:106`); and `src/graph/__tests__/fts-delete-guard.test.ts:93` pins the
behaviour directly. None was connected to the "O(changed files)" claim.

**Do not read E1-VERIFY's `fts_del = 0` as evidence that incremental is fixed.** It is evidence
that a cold build has no existing files. The ladder is cold-build-only by construction and
structurally cannot see this path.

Confidence, stated separately because it differs by claim:

- The scan mechanism is **measured** — E1-FTS, exponent 2.3454, 91.7% of T9's write phase.
- Its persistence on the incremental path is a **code read**, not a measurement.
- Its magnitude at 150k chunks is **unmeasured**. No eval harness measures incremental re-index
  cost, and Stage 4.5's "379 ms for one file at any corpus size" carries no citation anywhere in
  `IMPLEMENTATION_PLAN.md`.

Recorded 2026-08-17 in Stage 4.5 CORRECTION §5. No fix proposed; registered so it is not assumed
away.

### 2.5 Retrieval

The shipped strategy is **lexical BM25 + a declaration-exact ranker (ranker D)**. There is no vector
store: it was deleted at `5d00775` (Stage 7).

| experiment | verdict |
|---|---|
| Q1/RESERVE | identifier decomposition is **HARMFUL**, not neutral — stop rule fired |
| Q1/RESERVE-2 | decomposition doesn't survive; the shipped **TRIGRAM** tokenizer does real work |
| Q1/OUTCOME | hybrid vs lexical is **outcome-neutral at k=12** |
| Q1/ARM-V | V ≈ H everywhere; **F16** stays closed — F16 is the RRF-fusion lever (`IMPLEMENTATION_PLAN.md:6838`); both its hypotheses (`rrf_k` mis-tuning, then fusion itself) were **falsified**, and the finding is that **`rrf_k = 60` should not be changed** (`:6999`, reaffirmed `:8072`) |
| Q1/SCALE | lexical degrades with scale where hybrid does not — real, and **marginal** |
| Q1/IDFUSE | **INERT-LEVER** — the bag ranker fails as a scale rescue and harms off-stratum |
| Q1/DECLEX | **GAP CLOSED** (harm untested) — holds the identifier stratum flat at full scale; the S-ident scale caveat is **DISCHARGED** |
| Q4 | the win has no nameable class, and the class that matters is absent |

The line through them: vectors never earned their cost, the one real scale caveat against pure
lexical was **discharged by ranker D rather than by vectors**, and the fusion alternative to D was
inert. Evidence: `IMPLEMENTATION_PLAN.md` § Q1/* RESULT blocks and the paired design/results reviews
under `eval/results/q1-*-review.md`.

---

## 3. Dead hypotheses — do not re-propose

Each was proposed, tested or measured, and **refuted**. Re-proposing one without new evidence is a
regression.

| hypothesis | how it died |
|---|---|
| The write-phase exponent is the **page cache** | E1-AB: `CACHE_IMPLICATED` / PARTIAL. A 1024 MiB cache cut T9 write ~49% and left the curvature. Cache is a *cost multiplier*, not the exponent. |
| The **edges** exponent is the page cache | E1-AB's own data, re-read — see below. By E1-EDGES' own registered rule: **ALGORITHMIC**. |
| **Homonym amplification** drives edge resolution cost | Measured: **1.124 rows/name**, 11.1% discarded, top-1000 names = 5.6% of rows. Refuted. |
| Post-M1 chunk storage is **O(N)** | Falsified by E1 (b = 1.76), then restored *by repair* — the FTS guard (b = 1.08). True for cold builds only; see §2.4. Corrected in Stage 4.5 CORRECTION §1. |
| The **vector subsystem** is the only component that degrades | Vectors were deleted at `5d00775`. Corrected in Stage 4.5 CORRECTION §2. |
| Incremental indexing is **O(changed files)** at any corpus size | The FTS guard is conditional on the file being *new*, so a changed file still pays two full-scan deletes. See §2.4. |
| E1-PHASE's H2/H3/H4 | H2 (edges carries it) b = 1.436 < 1.6 bar. H3 (parse) b = 1.014. H4 (no phase reaches the bar) — write did. |
| The **edges** exponent has a cause other than the `files` full scan | E1-SCAN: removing the scan takes edges from b = 1.4382 to **b ≈ 1.0–1.1**, T8→T9 local slope 2.4709 → 1.1051, at 24 runs with T1/T5 controls null. The scan *was* the exponent. |
| E1-SCAN's own **H3** — "removing the scan does not make edges linear" | Registered band [1.15, 1.55] on the post-fix T8→T9 slope; observed **1.1051**, missing low. The `POTENTIAL_CALL` floor the hypothesis rested on does not exist — see §1.1. |
| **Something other than the scan is also super-linear** in the edges phase | Inferred from the two-term model's misfit (§2.3). E1-LADDER measured it instead: post-fix **b = 1.0184** over nine rungs, leave-one-out [0.9944, 1.0449]. The misfit was a property of the model, not of the code. |
| E1-LADDER's own **H3** — "the fix postpones the knee rather than removing it" | Registered bar 1.30 on the max adjacent local slope; observed **1.5813** (T7→T8), so **refuted as registered**. But the bar was unresolvable: that statistic's width across rep pairings reaches **1.560**. A knee that unbends is not a knee — T8→T9 is **0.868**. See the caution below. |

#### Do not register a bar finer than its statistic can resolve

E1-LADDER's H3 is the cautionary entry. An **adjacent-rung local slope** on this ladder is a noisy
quantity by construction: neighbouring rungs differ by only ~1.4× in chunks, so `ln` of that ratio
is ~0.34 and a 20% error in one rung's median moves the slope by ~0.5. Recomputed across all nine
rep pairings per segment, the widths run to **1.560**. A bar of 1.30 on the *maximum of eight* such
slopes was never going to mean anything, and the noise was computable in advance from E1-VERIFY's
own rep spreads.

The registered form is refuted and recorded as refuted. The question it meant to ask — is there a
bend? — was answered **post-hoc**: Spearman rank correlation of local slope against ladder position
is **0.976 pre-fix** versus **0.143 post-fix**, and quadratic departure is **45.58%** versus
**8.73%**. Both say the bend is gone. Neither was pre-registered, and neither adjudicates.

Before registering a threshold on a derived statistic, **compute that statistic's noise from data
already committed.** Here that was nine journal rows and five minutes.

#### Two corollaries, both earned by E1-HOIST (2026-08-18)

No hypothesis died here — all three fired — so there is no row in the table above. These are
**design** failures found inside a successful experiment, which is the only place they are cheap.

**Compute the noise of the DECISION RULE, not of the statistic.** E1-HOIST was almost registered at
20 blocks on `n = 7.849 (CV/effect)²`. That closed form sizes a **mean**; the registered primary was
a **median**, ~64% as efficient. Simulating the actual rule — "the 95% BCa interval on the median of
n paired ratios lies below 1.0" — gave **72%** where 80% was claimed. Corrected to 30 blocks before
any run. The lesson refines the entry above: knowing the statistic's noise is not enough if the
estimator and the interval method are then chosen separately. **Simulate the rule you actually
registered.** One simulation, five minutes, caught before 40 wasted builds.

**A bar in absolute units is a bar on the rig, not on the hypothesis.** E1-HOIST's H2 was registered
as a saving in `[40, 350] ms`. It fired — but its own Gate L then measured the session running
**+18% slower** than the one that produced the 87.1 ms forecast, and block 1 alone read 380 ms.
Had the load held, a registered hypothesis would plausibly have failed for a reason unconnected to
what it asked. **On a rig with a drift gate, express magnitude bars relative to a same-session
comparator.** The information needed to see this was already in the registration, in the gate
written three paragraphs above the bar.

**And a warning about how E1-HOIST survived.** Its registered noise assumption (paired ratio CV
5.6%, taken from E1-SCAN's *three* blocks) was wrong by 2.5x — the realised CV was **13.95%**. The
design held only because the effect also came in 2.6x larger than forecast, so the two errors
cancelled. That is luck. A CV estimated from n=3 is not a basis for sizing n=30, and the next
experiment that borrows a noise figure from a three-block cell should widen it or measure it.

#### The edges/cache refutation in full

E1-EDGES proposed to A/B the SQLite page cache against the edges phase. E1-AB had already run that
lever, on the same corpus, with an arm **2× stronger** than the one E1-EDGES intended. E1-AB covers
T1/T5/T9 against E1-EDGES' designed T5–T9, but E1-EDGES' registered conditions read only T5 and T9,
so the coverage gap is immaterial to the retirement.
Median ms/edge from `eval/results/e1-ab-runs.jsonl`:

| arm | `cache_size` | T5 | T9 | T9/T5 (the knee) |
|---|---|---|---|---|
| A | −16000 (≈15.6 MiB, default) | 0.05292 | 0.17945 | **3.391** |
| B | −1048576 (1024 MiB) | 0.05358 | 0.17762 | **3.315** |
| D | −2048 (2 MiB) | 0.05513 | 0.18121 | **3.287** |

Read it two ways, both fatal to the hypothesis:

- **The knee does not move.** A 512× cache span (D → B) changes the T5→T9 growth ratio from 3.287 to
  3.315 — under 1%. Whatever bends the curve is not sensitive to cache.
- **The level barely moves.** At T9, A/B = **1.0103** and D/B = **1.0202** — against E1-EDGES'
  registered condition-3 bar of **1.5**. A 512× more memory buys ~2%.

Both ratios are *arm-vs-arm at T9*, not ratios of the knee ratios. Quoting 1.0103 as a knee figure
is wrong; the knee comparison is 3.391 vs 3.315.

Recorded in `IMPLEMENTATION_PLAN.md` § E1-EDGES AMENDMENT 1 (2026-08-17), which retired the
experiment before any instrument was built.

---

## 4. Settled questions — do not reopen

Reopening any of these requires new evidence *and* an explicit statement of what changed:
**Q4**, harvest-as-verdict-source, **Q1/SCALE**, **IDFUSE**, **DECLEX**, and the vector deletion.

---

## 5. Where the evidence lives

| kind | location |
|---|---|
| registrations, amendments, RESULT blocks | `IMPLEMENTATION_PLAN.md` (chronological; authoritative) |
| raw per-run journals | `eval/results/*-runs.jsonl` |
| scored verdicts | `eval/results/*-verdict.json` |
| adversarial design + results reviews | `eval/results/*-review.md` |
| discarded runs, with the reason | `eval/results/discarded-*/README.md` |
| off-repo assets (corpora, embedded state) | `eval/ASSETS.md` |

Two standing hazards, both of which have already cost a run:

- **Never** open `graph.db` with `?mode=ro&immutable=1` — it is WAL-blind and will read stale data.
- **Run every eval script from `packages/mast`**, never the repo root.

---

## 6. Maintaining this file

- A RESULT block lands in `IMPLEMENTATION_PLAN.md` → its headline verdict lands here, same commit.
- A hypothesis is refuted → §3, with the number that killed it. This is the section that pays for
  itself; an unrecorded refutation gets re-proposed.
- A new journal is committed → re-run the §1 diff (enumerate journal keys, grep the scorers) and
  update the register.
- Amendments are **appended, never edited in place**. That applies to the plan. This file is a
  *derived index* and is edited in place — it must always reflect current state, and the plan
  retains the history.

Numbers here are copied from scored artifacts and carry a pointer. If a number here disagrees with
`IMPLEMENTATION_PLAN.md` or a verdict JSON, **the artifact wins** and this file is the bug.
