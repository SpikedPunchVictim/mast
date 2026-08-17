# MAST findings index

**Every settled empirical claim about MAST's scaling and retrieval behaviour, in one place, with a
pointer to the evidence that settles it.**

`IMPLEMENTATION_PLAN.md` is ~10,000 lines and is a *plan*: it records registrations, amendments and
RESULT blocks in the order they were written. It is the authoritative record and this file does not
replace it. But it is chronological, not topical — answering "what do we already know about the
edges phase?" means reading fourteen experiment blocks and reconstructing the answer. This file is
that reconstruction, maintained.

---

## The rule

**Before writing a pre-registration, read this file.** Specifically §1 (unread data) and §3 (dead
hypotheses). A registration is not complete until its author has stated, in the registration itself,
that they checked both — and what they found.

This rule exists because of a concrete, expensive failure. **E1-EDGES** was registered on
2026-08-17 to test whether the edges phase's super-linearity was a page-cache effect. It was
retired the same day, before a single measurement, because the adversarial design review found that
**E1-AB had already run that exact lever, on the same corpus and tiers, with a 2× stronger arm** —
and its answer (ALGORITHMIC, not cache) had been sitting in `eval/results/e1-ab-runs.jsonl` since
2026-08-13. E1-AB recorded `phase_ms.edges` on all 30 of its runs and scored only `write_ms` and
`duration_ms`. The data was committed, complete, and unread.

Twenty minutes of analysis on already-committed data retired a 30-run experiment. That ratio is why
§1 is the first section in this file and not an appendix.

---

## 1. The register of unread data

Measurements that are **recorded in committed journals and read by no scorer**. Each row is a
question that may already be answerable without running anything.

| Series | Where it is recorded | Measurement rows | Read by | Status |
|---|---|---|---|---|
| `potential_call_count` | all five journals | **146** | **nothing** | see 1.1 |
| `phase_ms.*` (all 5 phases) | `e1-ab` 30, `e1-fts` 32, `e1-verify` 27 | **89** | nothing (E1-PHASE's own 15 are scored) | see 1.2 |
| guard-era per-phase exponents | `eval/vscode-build.mjs` constants | — | no scorer reproduces them | see 1.3 |
| `symbol_count`, `edge_count`, `file_count` | all five journals | 146 | runners only; descriptive | unscored by design |

Verified 2026-08-17 by enumerating every key in each `eval/results/*-runs.jsonl` and grepping the
five scorers for it. To re-verify after adding a journal, repeat that diff.

**Count rows, not lines.** A journal line is not a run: the files carry retakes, gate records and
calibration rows alongside measurements. `wc -l` over-counts by roughly 2×. Filter on the field you
actually care about (`r.measurement?.phase_ms != null`) before quoting an *n*.

**Not every journal keys runs the same way.** `e1-verify` rows have **no `tier` field** — they carry
`rep` and are identified by `chunk_count`. Grouping its 27 runs by `tier` silently collapses all
nine rungs into one bucket, and taking a median then returns T5's value while looking like a
ladder-wide figure. Group by `chunk_count`.

### 1.1 `potential_call_count` — recorded on 146 runs, never read

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

`POTENTIAL_CALL` is what the resolver emits when it *cannot* pin a call to a definite target, so
this says: **at larger corpora a growing fraction of call sites fail to resolve.** That constrains
any hypothesis about the edges phase. It does not measure the phase's cost, and must not be
presented as if it does.

### 1.2 `phase_ms` outside E1-PHASE — 89 unscored runs, including a full guard-era ladder

`phase_ms.{walk,parse,write,edges,finalise}` is recorded on 104 measurement rows. Only
`e1-phase-score.mjs` fits phase timings, and only over E1-PHASE's own **15**. `e1-fts-score.mjs`
reads `phase_ms.write` alone, as a denominator for span shares. `e1-ab-score.mjs` and
`e1-verify-score.mjs` read none of it.

| journal | rows | rungs | what it is |
|---|---|---|---|
| `e1-ab` | 30 | 3 (T1/T5/T9) | per-phase timings across a **512× SQLite cache range** |
| `e1-fts` | 32 | 5 | per-phase timings for arms A and G (guard off/on) |
| `e1-verify` | **27** | **9** | **the complete post-guard per-phase ladder** |

`e1-ab`'s 30 rows are what retired E1-EDGES. `e1-verify`'s 27 are the larger prize and were missed
for a duller reason: they have no `tier` field, so every by-tier query returns them as one bucket.
It is the only full nine-rung per-phase ladder measured against the shipped binary, and **no scorer
touches it.**

Before registering anything about any phase, fit these first.

### 1.3 Guard-era per-phase exponents exist only in prose

E1-VERIFY re-fitted the ladder against the FTS delete guard and produced a total-duration verdict
(`eval/results/e1-verify-verdict.json`). Its **per-phase** slopes were computed by hand during the
session and survive only as prose and hardcoded constants:

- `b_write = 1.1136` — `IMPLEMENTATION_PLAN.md:5551`, RESULT prose only.
- `b_duration = 1.0789`, `b_edges = 1.3949`, `b_walk = 0.6108`, `b_parse = 0.9929` — projection
  constants in `eval/vscode-build.mjs:60-64`.

**The estimator has since been identified** (2026-08-17): per-rung **median**, OLS on the nine
`(log chunks, log ms)` points. Re-derived from `e1-verify-runs.jsonl`, `walk`, `parse` and `edges`
reproduce the constants to four decimals **exactly**; `write` lands at 1.1117 against 1.1136 and
`duration` at 1.0791 against 1.0789. Fitting all 27 runs instead of nine medians gives
`edges = 1.3823`, `write = 1.1186` — close, but not the same number.

Two consequences, both live:

1. **The edges exponent has two values, and they are not interchangeable.** E1-PHASE's scored
   **1.4360** (pre-guard, HC3 [1.2333, 1.6388]) and the guard-era descriptive **1.3949**. Any claim
   about the edges exponent must say which it uses and that the guard-era one is unscored.
2. **The residual `write`/`duration` disagreement is unexplained.** It is small enough not to move
   any verdict and large enough to mean the recorded constants were not produced by the estimator
   just described. Persisting these fits through a real scorer would settle it and retire §1.3.

---

## 2. What is settled

### 2.1 Indexing scale — the headline

The cold-index ladder is **nine nested subsets of n8n**, T1 (3,679 chunks) → T9 (73,359 chunks), 3
reps each. The super-linear bar is **b ≥ 1.35**, fixed before any measurement and never moved.

| experiment | date | verdict | key number |
|---|---|---|---|
| **E1** | 08-12 | `SUPER_LINEAR` | b = **1.7558**, HC3 [1.6689, 1.8427]; lack-of-fit fires |
| **E1-PHASE** | 08-12 | H1 fires | the exponent is in **write**: b = **1.9685** |
| **E1-AB** | 08-13 | `CACHE_IMPLICATED` / PARTIAL | cache reduces but does not remove it |
| **E1-FTS** | 08-16 | `MECHANISM_IDENTIFIED` | `fts_del` is **91.7%** of T9's write phase |
| **E1-VERIFY** | 08-17 | `HOLDS` | guard drops the ladder to b = **1.0825** |

**The chain, end to end:** total build time grew at b = 1.76. E1-PHASE localised that to the write
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
- Write's share of T9 fell from **94.01%** to **51.3%**; parse is now 36.3%.

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

### 2.3 The edges phase — the one open scaling question

The only component still near the 1.35 bar. **Nothing here is settled**; this section records what
is known so the next registration starts from it.

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

**Before registering anything here:** §1.2's 89 unscored runs of `phase_ms.edges` already cover a
512× cache range *and* a full nine-rung post-guard ladder. And the phase must be **instrumented
before it is A/B'd** — registering a lever against an unidentified mechanism is precisely what
produced and then retired E1-EDGES.

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
| Q1/ARM-V | V ≈ H everywhere; F16 stays closed |
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

#### The edges/cache refutation in full

E1-EDGES proposed to A/B the SQLite page cache against the edges phase. E1-AB had already run that
lever, on the same corpus and rungs, with an arm **2× stronger** than the one E1-EDGES intended.
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
