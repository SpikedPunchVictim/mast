<!-- SHARD — do not edit the excerpt below. -->

> **Plan excerpt — ADR 012: The edges knee, closed.**
> Verbatim from `IMPLEMENTATION_PLAN.md` at commit `69a587e`, lines 5635–5841, 10142–11396 (concatenated in that order).
> This is the append-only record the ADR was written from; the ADR is the summary, this is the evidence.
> Nothing here has been edited **except heading levels** — see `docs/provenance/verify-plan-shards.mjs`
> for the losslessness proof, which passes at commit `69a587e`, before that repair.
>
> **Structural repair (2026-08-19).** E1-HOIST's pre-registration, its result, and the FTS-INVARIANT
> block were appended at `#` level rather than `##`, which orphaned seventeen `##` subsections —
> `Design`, `Hypotheses`, `Gates`, `Verdict`, `Scope` and the rest read as siblings of the experiments
> instead of children. Three `#` headings became `##` and their seventeen children became `###`.
> No prose, number, or ordering changed. This is the one edit the shards carry.

---

### E1-EDGES PRE-REGISTRATION — 2026-08-17, written BEFORE any measurement

**Question.** The `edges` phase's cost *per edge* is flat through T5 and then climbs 3x by T9.
Is that rise SQLite page-cache capacity — bounded, and already crossed at target scale — or is
it algorithmic, and therefore unbounded?

This is the last component of the build still growing faster than its own exposure. It is
**23.1% of the vscode build** and, since the FTS guard, the largest remaining super-linear term.

##### What is already established, and what is not

Descriptive, from the E1-VERIFY journal and the vscode build (no verdict attaches to either):

| | edges/chunk | ms/edge | symbols+idx (est.) | vs 15.6 MiB cache |
|---|---|---|---|---|
| T5 | 0.55 | 0.057 | 3.0 MiB | 0.19x |
| T6 | 0.56 | 0.066 | 4.3 MiB | 0.27x |
| T7 | 0.59 | 0.076 | 6.2 MiB | 0.40x |
| T8 | 0.61 | 0.112 | 8.9 MiB | 0.57x |
| T9 | 0.66 | 0.175 | 12.9 MiB | 0.82x |
| vscode | 1.14 | **0.165** | 29.5 MiB (measured) | 1.89x |

The default cache is `cache_size: -16000` = **15.6 MiB**, read back from the vscode run's
`appliedPragmas`. `symbols` + `idx_symbols_lookup` + `idx_symbols_file` measure **29.5 MiB** at
152,969 chunks via `dbstat`; per-tier figures scale that linearly in symbol count and are
**estimates**, not measurements.

**Two things this does NOT already show.**

1. **The vscode point cannot carry the plateau claim.** vscode is a different corpus with 1.73x
   n8n's edge density, so its cheaper-than-T9 per-edge cost may be corpus character rather than a
   plateau. This is exactly the confound E1's nested-ladder design exists to remove, and it is why
   the A/B runs on the ladder rather than adding vscode rungs.
2. **A refuted rival is recorded so it is not re-proposed.** The first hypothesis was that
   `insertEdges`' `WHERE name IN (...) AND kind != 'export'` fetches every homonym corpus-wide and
   discards all but the first, making work grow with name collisions. Measured on the vscode graph:
   **1.12 rows per name**, 11.1% of fetched rows discarded, top-1000 names only 5.6% of rows.
   **Refuted.** There is no meaningful homonym amplification.

##### Exposure — registered, and different from E1's

E1 fits everything against **chunks**. This experiment fits `edges` against **edge count**, because
chunks are the wrong denominator for it: predicting the vscode edges phase from T9's per-edge rate
lands within 6% (30,650 ms predicted vs 28,829 measured) where the chunk-based projection missed by
21.7%. Registered now, before any arm is run, so the choice cannot be made after seeing which
denominator flatters the result.

##### Design

**Corpus:** n8n's nested ladder, **rungs T5–T9 only** — the knee region. Same corpus across all
rungs, which is the entire point.

**Arms**, differing in one registered lever:

| arm | `--cache-size-mib` | rationale |
|---|---|---|
| **S** | 16 | the product default, stated explicitly so ARM IDENTITY can verify it |
| **L** | 512 | exceeds T9's whole 418.8 MiB database, so **no** page can be evicted for capacity |

`--mmap-size-mib` is pinned at **0** in both arms (the default the vscode run recorded), so mmap
cannot act as a second, unregistered lever.

**5 rungs x 2 arms x 3 reps = 30 runs.** Arm order alternates by `(block + rungIndex) % 2`, the
positional-balance rule E1-FTS used, so arm never confounds with position in the schedule.

##### Registered conditions — fixed now, immutable

| # | condition | bar |
|---|---|---|
| 1 | **knee reproduces in arm S** — `ms/edge(S,T9) / ms/edge(S,T5)` | >= 2.0 |
| 2 | **arm L flattens it** — `ms/edge(L,T9) / ms/edge(L,T5)` | <= 1.35 |
| 3 | **the lever bites at T9** — `ms/edge(S,T9) / ms/edge(L,T9)` | >= 1.5 |

Condition 1's bar is 2.0 against an observed 3.07x, so it is a reproduction check with headroom,
not a coin flip. Condition 2 reuses **E1's own immutable 1.35**, rather than inventing a threshold
for this experiment.

##### Verdict rule

| outcome | conditions | reading |
|---|---|---|
| **CACHE_BOUND** | 1, 2, 3 all met | the knee is page-cache capacity: bounded, and already crossed at target scale |
| **PARTIAL** | 1 and 3 met, 2 not | cache is implicated but is not the whole mechanism |
| **ALGORITHMIC** | 1 met, 3 not met | **not** the cache. Per-edge growth is algorithmic, the vscode plateau is a corpus artifact, and `edges` is a live scaling risk |
| **VOID** | 1 fails | the phenomenon did not reproduce; nothing is concluded, and no other condition is read |

**Falsification, stated plainly:** if arm L does not move the curve, the page-cache hypothesis is
dead. ALGORITHMIC is the outcome that costs the most and is therefore the one this design must be
able to return — condition 3 is the single point where that is decided.

##### Gates

Gate 0 (binary identity) · **Gate 0b** (dist staleness — note it now filters through `isBuildInput`,
after its first live firing was a false positive on a test file) · Gate 1 (tier file set) · Gate 3
(dual clocks + retakes).

- **ARM IDENTITY.** Each run's `appliedPragmas.cache_size` must equal its arm's request
  (`-16000` / `-524288`). The record keeps what took *effect*, never what was asked for — an arm
  whose pragma silently failed to apply is two copies of the same arm.
- **DB IDENTITY.** For each rung, both arms must produce identical `chunk_count`, `symbol_count`
  and `edge_count`. A cache size must not change what gets indexed; if it does, the arms are not
  comparable and the rung is void.

##### Scope limits, registered in advance

- **Rungs T5–T9 of n8n only.** No claim about T1–T4, about the panel, or about vscode.
- **It tests the mechanism, not the plateau.** vscode's flat per-edge cost stays an inference even
  under CACHE_BOUND, because vscode is not in this design.
- **It measures why `edges` slows, not whether it can be made faster.** No optimisation is proposed
  or evaluated here.
- **The per-tier working-set figures above are estimates** extrapolated from one `dbstat`
  measurement, and are context for the hypothesis — no condition depends on them.

##### Process

Registered and committed **before** the instrument is built and before any run, per Gate 5.
An adversarial design review is commissioned against this block before the first scored run;
amendments are **appended, never edited in place**.

#### AMENDMENT 1 — 2026-08-17, post-design-review, BEFORE any instrument was built

The commissioned adversarial review returned two FATALs. **Both are confirmed against source and
committed data, by me, independently.** The experiment as registered is **RETIRED — it will not
run.** Its deciding condition was already measured, with a stronger lever, and the answer is a null.

##### F1 (confirmed) — E1-AB already ran this lever, at 2x the strength, and found nothing

`eval/results/e1-ab-runs.jsonl` holds 30 scored runs on the **same corpus and same tiers**
(T1/T5/T9), with `cache_size` as the only lever, and it records `phase_ms.edges` and `edge_count`
on every run. E1-AB scored `write_ms` and `duration_ms` only, so the edges phase was **collected
and never read**. That is the sole reason this looked unexplored.

Medians of per-run `phase_ms.edges / edge_count`:

| arm | `cache_size` | T5 | T9 | T9/T5 |
|---|---|---|---|---|
| A | −16000 (default, 15.6 MiB) | 0.05292 | 0.17945 | **3.391** |
| B | −1048576 (**1024 MiB**) | 0.05358 | 0.17762 | **3.315** |
| D | −2048 (2 MiB) | 0.05513 | 0.18121 | — |

Against this registration's own three conditions: condition 1 **passes** (3.391 >= 2.0);
condition 2 **fails** (3.315 > 1.35); condition 3 **fails** — `msPerEdge(A,T9)/msPerEdge(B,T9)` =
**1.0103** against a bar of 1.5. By the registered verdict rule that is **ALGORITHMIC**.

Arm B is **1024 MiB — twice the 512 MiB proposed here**, so the design's arm L is strictly weaker
than an arm already run. And the positive control settles the "did the lever ever bite" question
that F5 raised: **D/B = 1.0202 across a 512x cache span** (2 MiB → 1024 MiB). Per-edge cost moved
2%. The page cache is not the mechanism.

##### F2 (confirmed) — arm S's pragma value was unreachable and would have voided all 15 arm-S runs

`--cache-size-mib 16` cannot produce `−16000`. `cli/index-cmd.ts:170` computes
`parseMebibytes(...) * 1024`, and `graph/db.ts:460` issues `cache_size = -${cacheSizeKib}` — so
16 MiB → 16384 KiB → **`−16384`**. ARM IDENTITY as written demanded `−16000`, so every arm-S run
fails the gate, condition 1 becomes unreadable, and the design goes VOID.

The stated premise was wrong too: the default `−16000` is **15.625 MiB**, which no integer
`--cache-size-mib` can reproduce. The control had to be the *unflagged* arm, as E1-AB's arm A was.

##### What this changes

**The page-cache hypothesis is dead, and the correction runs against me.** Last session's reading —
that the T5→T9 knee was a bounded cache step already crossed — is **withdrawn**. It is not the
cache. `edges` is algorithmic super-linearity in the region measured, which is the more expensive
answer and the one this design was built to be able to return.

**The mechanism is now unidentified, and so is the vscode plateau.** vscode's per-edge cost
(0.165) sits slightly *below* T9's (0.175) despite 3.6x the edges. That was the evidence for a
plateau; with the cache excluded it is unexplained under either hypothesis, and it remains
confounded by corpus (vscode carries 1.73x n8n's edge density). Both are open questions, not
findings.

##### Corrections to this block, recorded rather than edited

- The header **"written BEFORE any measurement" is false** as it applies to condition 3. The
  measurement existed, in this repo, unscored. Stated here rather than silently amended above.
- **The working-set table's column is under-defined** (review F3, confirmed by `dbstat` on the
  retained state dirs): `insertEdges` also reads `files`/`imports` and writes `edges` plus three
  indexes. The true working set is ~2.2x the figure tabulated, crossing the cache at **T7→T8**
  rather than after T9 — i.e. the corrected table makes the cache hypothesis look *stronger*,
  which is what makes F1's null worth recording instead of re-measuring. The registration's claim
  that no condition depends on the table is **verified true**; the conditions are pure ratios.
- **`edge_count` is the surviving-row count, not the work count** (review F4, confirmed):
  `readGraphCounts` reads `SELECT COUNT(*) FROM edges` (`e1-common.mjs:687`), collapsed by
  `PRIMARY KEY (from_id, to_id, edge_type)` under `doNothing()`, and unresolved targets cost a
  full `resolveCallTarget` while contributing zero. The bias *deflates* ms/edge at large rungs, so
  the knee is conservative and condition 1 is safe — but ms/edge is not "cost per unit of work",
  and any future edges experiment must instrument `edgeValues.length`.
- **The +6% vs +21.7% comparison quoted for the exposure change is not like-for-like.** The 21.7%
  miss came from a *super-linear* (b ≈ 1.40) chunk projection, not a linear one. Edge count is
  still the better denominator — a linear-in-chunks projection misses by −38.5% — but the margin
  was overstated.

##### What survives, and what would be worth running

The homonym-amplification rival stays refuted (independently re-measured at 1.124 rows/name
corpus-wide, 1.084 restricted to `method` targets). Attack #1 — that the pragma might not reach
the connection running `insertEdges` — was checked and is **unfounded**: one handle, applied
before DDL, read back before `destroy`.

No replacement experiment is registered here. The next question is **which** algorithmic term
grows, and that is a profiling question, not an A/B — `resolveCallTarget` per unique `toName` per
file is the named suspect (`populate.ts:683-702`), and it is not measured by anything currently in
the harness.

---

### E1-SCAN — does removing the `files` full scan remove the edges knee? PRE-REGISTRATION (written 2026-08-17, BEFORE any measurement)

**Nothing below may be edited after the first scored measurement.** Amendments appended with
timestamp, reason, direction.

#### The mandatory FINDINGS check (repo rule, `.claude/CLAUDE.md`)

Read before writing this: `FINDINGS.md` §1 (unread data) and §3 (dead hypotheses).

**§1 — what I found, and what it changed.**

- **§1.2 named the artifact this registration is built on.** `e1-verify-runs.jsonl` is "the only
  full nine-rung per-phase ladder measured against the shipped binary, and **no scorer touches
  it**", missed because its records carry `corpus`, not `tier`. Every baseline number below is
  derived from it **in this session**, not copied from prose. §1.2's instruction — "Before
  registering anything about any phase, fit these first" — is discharged here.
- **§1.1 is a trap this registration walked into and backed out of.** The first draft normalised
  `edges_ms` by `potential_call_count` and called the quotient "µs per call". §1.1 states plainly
  that this count is `SELECT COUNT(*) FROM edges WHERE edge_type='POTENTIAL_CALL'` — a
  **surviving-row count after primary-key dedup, an output, not a work counter** — and that
  "dividing a phase time by it does not yield a per-call cost." The primary outcome below was
  changed to the **raw `edges_ms` ratio**, which needs no normaliser. Where the count still
  appears it is labelled a *descriptive* normaliser and never called a per-call cost. This
  registration is the first reader of the field, which closes §1.1's "no scorer references it".
- **§1.4 remains open and is untouched here**: `chunk_fts_count` / `identifier_fts_count`, 27 rows.
  Not read by this experiment.

**§3 — what it forbids, and why this is not that.**

§3 records **"The edges exponent is the page cache"** as *dead*: E1-AB moved `cache_size` over a
512× span (D −2048 → B −1048576) and the T5→T9 knee ratio went 3.287 → 3.315, under 1%; at T9 the
arm ratios were A/B 1.0103 and D/B 1.0202 against a registered bar of 1.5. By E1-EDGES' own
registered rule the mechanism is therefore **ALGORITHMIC**. This registration proposes a *specific
algorithmic* mechanism and does not re-propose the cache. No arm here varies any pragma; all arms
run the pinned defaults.

§3 also kills **homonym amplification** (1.124 rows/name measured). Not re-proposed.

#### The claim under test

`FINDINGS.md` §2.3's headline question is open: `SEARCH` replacing `SCAN` in the query plan is a
**query-plan fact, not a phase measurement**. `88f4592` replaced `path LIKE P || '%'` with a
half-open range at four sites; two of them (`populate.ts:958` `resolveInFileOrReExportChain`,
`populate.ts:1093` `insertReExportFiles`) sit inside the `phase.edges` timing window. Measured on
the 8,651-file vscode DB with bound parameters, the resolver's plan moves from
`SCAN files USING COVERING INDEX sqlite_autoindex_files_1` to
`SEARCH … (path>? AND path<?)`. **How much of the edges phase that is worth has never been
measured.**

#### The baseline, derived this session from `e1-verify-runs.jsonl` (27 runs, 9 rungs, 3 reps)

Median per rung. `edges_ms` is `phase_ms.edges` from the fitted attempt.

| tier | chunks N | files F | `edges_ms` | share of `duration_ms` |
|---|---|---|---|---|
| T1 | 3,679 | 656 | 113 | 4.71% |
| T2 | 5,332 | 954 | 158 | 4.59% |
| T3 | 7,761 | 1,393 | 230 | 4.14% |
| T4 | 11,278 | 1,986 | 331 | 4.22% |
| T5 | 16,529 | 2,880 | 514 | 4.13% |
| T6 | 23,854 | 4,191 | 881 | 4.92% |
| T7 | 34,691 | 5,976 | 1,575 | 6.05% |
| T8 | 50,299 | 8,945 | 3,401 | 8.70% |
| T9 | 73,359 | 13,330 | 8,501 | 13.68% |

Estimators, named: **OLS of ln(`edges_ms`) on ln(N), median per rung, 9 points** gives
**b = 1.3949, R² = 0.9690**. That single exponent hides the shape that matters — the curve is not a
power law. **Local endpoint slopes**: T1→T5 = **1.0082** (linear), T8→T9 = **2.4276**. The knee is
real and it is at the top of the ladder.

A full scan predicts exactly this shape: per-resolution scan cost grows with F while everything
else does not, so the scan is invisible when F is small and dominant when F is large.

#### Hypotheses, with pre-committed thresholds

Primary series: **`phase_ms.edges`, median of 3 reps per (arm, rung)**. Ratio is
**no-fix ÷ fix**, so >1 means the fix is faster.

- **H1 (primary).** The scan is the dominant cost in the edges knee.
  **Fires if the T9 ratio ≥ 2.0.** Point forecast **2.74×** (8,501 → ~3,103 ms).
- **H2 (dose–response).** The effect scales with F, and is absent where F is small.
  **Fires if** T9 ratio > T8 ratio > T5 ratio, **and** the T1 and T5 ratios both lie in
  [0.90, 1.15]. Point forecasts: T1 **1.04×**, T5 **0.97×**, T8 **1.79×**, T9 **2.74×**.
  H2 is the discriminating test. A uniform speedup at every rung would mean the fix changed
  something other than the scan, and H1 firing alone would not establish the mechanism.
- **H3 (residual).** Removing the scan does **not** make edges linear.
  **Fires if** the post-fix T8→T9 local slope is in [1.15, 1.55]. Point forecast **1.3072**.
  This is not a hedge: `POTENTIAL_CALL` rows grow super-linearly in chunks — §1.1's endpoint slope
  1.12 across T1→T9, re-derived here as **1.1189**, and **1.3072** locally over T8→T9. Even a cost
  per surviving row that is perfectly flat in F leaves that slope behind. H3 is what hands task #5
  ("name the residual") a measured target instead of a prose one.

**Falsification.** If the T9 ratio is **< 1.2**, the scan is not the mechanism, `SEARCH`-vs-`SCAN`
is a plan improvement with no phase consequence at this scale, and §2.3's open question stays open
with the cache *and* the scan both eliminated. That outcome is recorded as a refutation of H1 in
§3, not softened into "a modest improvement".

**Direction-of-error statement.** I shipped `88f4592` and I expect it to win; the pro-fix result is
the one I am predisposed to. The T1/T5 control rungs exist to make a spurious global speedup
visible, and the correctness gate below can fail the fix outright regardless of any timing.

#### The descriptive plateau model (secondary, explicitly not a mechanism)

Cost per surviving `POTENTIAL_CALL` row is flat across T1–T5 — 118.6, 115.0, 114.4, 106.8,
110.8 µs — median **114.4 µs** — then climbs: T6 127.0, T7 144.5, T8 205.3, T9 313.4. The point
forecasts above are that quantity returning to the T1–T5 plateau. Per §1.1 this is a
**normalisation, not a per-invocation cost**; the number of `resolveCallTarget` invocations is
unmeasured and this experiment does not measure it.

#### Design

Two arms × four rungs × three reps = **24 runs**.

| arm | commit | dist rel-hash (SHA-256, paths relative to `dist/`) | files |
|---|---|---|---|
| **N** (no-fix) | `f774752` = `88f4592~1` | `75040aff0ed9089ace829a72b9666e161935fb2c60950c076ec273e9f6678fcb` | 54 |
| **R** (range fix) | `88f4592` | `2f94a471694f117b69a5ef3eb1b0a83ab12195a9476b35239fbaf96242cd3de9` | 55 |

Rungs **T1, T5** (controls, F = 656 / 2,880) and **T8, T9** (treatment, F = 8,945 / 13,330).

Both arms are built in **detached git worktrees outside the repo** — `/private/tmp/mast-scan-nofix`
and `/private/tmp/mast-scan-fix` — each with its own `dist/`, so no arm can observe or overwrite the
other's build, and neither writes to the repo's `eval/results/`. `node_modules` is symlinked from
the main checkout; the build is plain `tsc`, so the link affects resolution only, not output.

**Why not the repo's own `dist/`.** It was found this session to be **the no-fix binary** — its
`distContentHash` is `b77f0ae3…`, byte-identical to the hash E1-VERIFY pinned, because `dist/` was
never rebuilt after `88f4592` landed. Gate 0b catches this and does name `src/graph/path-range.ts`.
Separately, the repo's `dist/` carries **6 orphaned `.js` files** with no surviving source —
`indexer/{background-embedder,background-embedder-worker,embedder}`, `search/{hybrid,vector}`,
`store/lance`, all dead since the vector deletion at `1522ef1`; `tsc` does not remove outputs whose
inputs vanished. They are unreachable (the only mentions in live emitted code are two comments in
`store/sqliteChunkStore.js`), but they make the repo tree a 60-file build against the worktrees' 54.
Building **both** arms in worktrees is what makes the arm delta exactly three files.

**Ordering.** Interleaved and rung-blocked, following E1-AB: within a block the rungs run in a fixed
order and the two arms alternate, with arm order flipping between blocks (block 1 N-first, block 2
R-first, block 3 N-first). Thermal drift and background load therefore hit both arms roughly
equally instead of loading onto whichever ran second.

#### Gates

Inherited unchanged, imported not re-implemented: **Gate 1** (corpus pin — n8n at
`9d9e9bf97e8ae5382a930cd662637a9cf7046ef9`, verified clean this session — plus the tier file-set
clause A4-MAT-4 and the config pin A4-C4), **Gate 3** (external vs fitted clock, with A4-MAT-6
retakes and `selectFitted`), **Gate P** (phase attribution).

**Gate 0 is deliberately modified, and this is the one waiver in this registration.** Gate 0's
`dist_hash` equality exists to stop the binary moving mid-schedule. Here **the binary is the
independent variable**, so cross-arm equality cannot be required. It is replaced by:

- **Gate S1 (arm identity).** Each arm's dist rel-hash must equal the value pinned in the table
  above, re-checked before every run. A mismatch is a hard stop, not a VOID.
- **Gate S2 (arm delta).** The set of `dist/**/*.js` files differing between the arms must be
  exactly `graph/populate.js`, `graph/queries.js`, `graph/path-range.js` (added). Any fourth
  differing file means the worktrees differ by something other than the fix.
- **Gate 0b (staleness) survives per-arm**: each worktree's newest build-input `.ts` must not be
  newer than its newest emitted `.js`.

**Gate C (correctness) — new, and it can fail the fix on its own.** At every rung, arm N and arm R
must agree exactly on `file_count`, `chunk_count`, `symbol_count`, `edge_count` and
`potential_call_count`. The range query is a **deliberate semantics change** (case-insensitive path
matching was withdrawn), and `FINDINGS.md` §2.3 records the named residual risk: on a
case-insensitive filesystem a mis-cased import yields a `resolvedPath` in the specifier's casing
while the walker records the on-disk casing, so LIKE papered over a mismatch that the range drops.
It was unobserved across four corpora, but never tested on n8n's 13,330 files. **A count divergence
is a finding about correctness that outranks every timing number here**, and it is the measured
answer to task #9 rather than the current inference.

#### What this experiment cannot answer

- It does not measure `resolveCallTarget` invocations (§1.1). Nothing here yields a per-call cost.
- It does not attribute the *residual* — H3 quantifies what is left, it does not name it. That
  stays task #5.
- It measures one corpus family (n8n rungs). The vscode plan evidence is a different corpus and is
  not pooled with these numbers.
- Absolute timings are **not comparable to E1-PHASE's ladder**, whose binary predates the FTS
  guard. E1-VERIFY's are comparable to arm N and are used as a consistency check only: arm N should
  reproduce E1-VERIFY's edges medians, because it is a rebuild of the same commit's source.

#### Cost

~11.6 minutes of indexing (2 arms × 3 reps × (2.4 + 12.4 + 39.1 + 62.1) s), plus tier
materialisation already on disk. Peak transient disk one T9 state dir (~420 MiB); state dirs are
removed after each run. Two worktrees at ~1 GiB each, removed with `git worktree remove` when the
RESULT lands.

#### Artifacts

`eval/e1-scan-run.mjs` (driver, committed with this registration, before any run),
`eval/e1-scan-score.mjs` (scorer), `eval/results/e1-scan-runs.jsonl` (journal, own file — it never
appends to another experiment's record), `eval/results/e1-scan-schedule.json`,
`eval/results/e1-scan-verdict.json`.

---

### E1-SCAN RESULT (2026-08-17) — H1 FIRES, H2 FIRES, H3 IS REFUTED

Scored by `eval/e1-scan-score.mjs` from `eval/results/e1-scan-runs.jsonl`; verdict at
`eval/results/e1-scan-verdict.json`. **24/24 runs, 0 VOID, 0 interrupted, Gate C clean at every
rung, `scoreable: true`.** One Gate 3 retake (slot 1, T1 arm N, delta 532 ms > 500 ms allowance),
logged and retained per A4-MAT-6.

#### The primary series

`phase_ms.edges`, median of 3 blocks. Ratio is no-fix ÷ fix.

| rung | chunks | files | no-fix N | fix R | **ratio** | forecast |
|---|---|---|---|---|---|---|
| T1 | 3,679 | 656 | 111 | 112 | **0.991** | 1.04 |
| T5 | 16,529 | 2,880 | 502 | 446 | **1.126** | 0.97 |
| T8 | 50,299 | 8,945 | 3,473 | 1,461 | **2.377** | 1.79 |
| T9 | 73,359 | 13,330 | 8,824 | 2,217 | **3.980** | 2.74 |

All three reps, to show the spread the medians rest on:
T9 no-fix [9346, 8824, 8632], T9 fix [2210, 2325, 2217];
T8 no-fix [3473, 3483, 3356], T8 fix [1503, 1441, 1461].

- **H1 FIRES.** T9 ratio **3.980** against a registered bar of 2.0. It beats the 2.74 point
  forecast by 45%.
- **H2 FIRES.** Monotone in F (3.980 > 2.377 > 1.126) and both controls inside the registered
  [0.90, 1.15] band (T1 0.991, T5 1.126).
- **H3 IS REFUTED.** Registered band for the post-fix T8→T9 local slope was [1.15, 1.55], point
  forecast 1.3072. Observed **1.1051** — it missed **low**, and the substantive claim it encoded
  ("removing the scan does not make edges linear") is false. See below; this is the most
  informative outcome in the experiment.

#### The exponent, which is the headline

OLS of ln(`edges_ms`) on ln(chunks), median per rung, **4 points**:

| arm | b | R² |
|---|---|---|
| N (no-fix) | **1.4382** | 0.9714 |
| R (range fix) | **0.9972** | 0.9983 |

**Do not quote `0.9972` as a precise exponent.** An adversarial re-slice run before this block was
written shows it is not stable to four figures: dropping T1 gives 1.0738, dropping T9 gives 0.9785,
the top two rungs alone give 1.1051. The defensible statement is **b ≈ 1.0–1.1**. What survives
every slice is the *contrast*: arm N over the same slices runs 1.4382 / 1.8814 / 1.2989 / 2.4709 —
always far above, and violently slice-sensitive because it is bending. Arm R is not bending.

Local slopes make the same point without any fit:

| segment | no-fix | fix | POTENTIAL_CALL growth |
|---|---|---|---|
| T1→T5 | 1.0044 | 0.9197 | 1.0536 |
| T5→T8 | 1.7380 | 1.0662 | 1.1433 |
| T8→T9 | **2.4709** | **1.1051** | 1.3072 |

And the cleanest single view — **the edges share of total index time, which the fix flattens
outright**: no-fix 4.53% → 4.27% → 8.51% → **13.53%** across T1/T5/T8/T9; fix 4.67% → 3.84% →
3.76% → **3.85%**.

#### Why H3 was wrong, which is worth more than H1 being right

H3 reasoned that `POTENTIAL_CALL` rows grow super-linearly in chunks (1.3072 locally over T8→T9),
so a per-row cost flat in F would still leave a 1.31 slope. That floor does not exist: the observed
post-fix slope **1.1051 is below it**, because the post-fix cost per surviving row *falls* with
scale — 117.5, 96.1, 88.2, **81.7** µs across T1/T5/T8/T9 (no-fix: 116.5, 108.2, 209.7, **325.3**).

The registration is on record predicting that floor, and `FINDINGS.md` §1.1 is on record explaining
exactly why the prediction was unsound: `potential_call_count` is a **surviving-row count after
dedup, an output, not a work counter**. The registration quoted that warning, used the count only
as a labelled descriptive normaliser for the primary outcome — and then leaned on it anyway to
build H3's floor. `POTENTIAL_CALL` is what the resolver emits when it *cannot* pin a call, and its
share rises with corpus size (§1.1: 0.259 → 0.370 rows/chunk); unresolved calls are evidently
cheaper per row than resolved ones, so normalising by them overstates work at the top of the
ladder. **§1.1's trap has now been walked into twice in one experiment, once knowingly.** That is
the durable lesson here.

#### Gate C — the correctness result, and its precise limit

**All five counts identical across arms at all four rungs**, including T9's full 13,330-file tree:
`file_count` 13,330, `chunk_count` 73,359, `symbol_count` 51,551, `edge_count` 48,497,
`potential_call_count` 27,127.

**What that does and does not establish.** Gate C compares **counts, not sets** — two graphs can
share a cardinality and differ in membership, so this is strong evidence, not proof, that the arms
built the same edges. The set-level evidence is separate and already recorded in `FINDINGS.md`
§2.3: old-LIKE vs new-range resolution of every internal resolved import agreed exactly on n8n T9's
22,248 and vscode's 79,884. Counts identical here **plus** sets identical there is what the
correctness claim rests on; neither alone.

The named residual risk — a mis-cased import on a case-insensitive filesystem silently dropping an
edge — **did not bite on n8n at any rung**. That is a measurement on 13,330 real files where
previously there was only inference. It does not retire the risk (n8n is one well-formed TS
monorepo; mast indexes arbitrary repos, and JS has no `forceConsistentCasingInFileNames`), but it
is the first evidence beyond the unit counterexamples.

#### Whole-index effect

At T9 the fix removes **6,607 ms** from the edges phase and **7,572 ms** from wall-clock index time
— **11.6% of total build time**, 65.2 s → 57.6 s. Total-duration exponent over these four rungs
moves 1.0922 → 1.0646 (uncalibrated: the empty-corpus constant `c` is not subtracted, because a
ratio design does not need it and measuring it unused invites post-hoc use).

#### Validity checks

- **Arm N reproduces E1-VERIFY**, which measured the same source commit: T1 −1.8%, T5 −2.3%,
  T8 +2.1%, T9 +3.8%. The control is behaving like the binary it is a rebuild of.
- **Gates S1/S2 held before every one of the 24 runs**: arm hashes matched their registered pins
  and the arms differed in exactly `graph/populate.js`, `graph/queries.js`, `graph/path-range.js`.
- **The plan change is confirmed on this corpus too**, not only vscode:
  `SCAN files USING COVERING INDEX sqlite_autoindex_files_1` →
  `SEARCH files USING COVERING INDEX sqlite_autoindex_files_1 (path>? AND path<?)`.
- **H1 is robust to rep selection.** Worst case for the fix (min no-fix ÷ max fix) is still
  **3.713** at T9, clearing the 2.0 bar; best case 4.229.

#### Direction-of-error, honoured

The registration recorded that I shipped `88f4592` and expected it to win. It won by more than
forecast, which is exactly the situation where the controls earn their place: T1 at 0.991 and T5 at
1.126 are what rule out a spurious global speedup. A provisional read of block 1 alone had both
controls *below* the band (0.87, 0.91) and I had drafted language conceding H2 would fail as
registered; the three-block medians moved them inside it. **The block-1 read was noise and the
registered n was right** — recorded because the temptation to report a partial series as a trend is
the failure this ceremony exists to prevent.

#### A correction to this experiment's own registration

The registration claimed E1-SCAN was "the first reader" of `potential_call_count` and that it
therefore closed §1.1's "no scorer references it". **That is wrong**, found while updating
`FINDINGS.md` for this commit: `eval/e1-unread-fit.mjs:178-179` already fits the field as
`potential_call_share` and `potential_call_per_chunk` over e1-verify's 27 rows. §1's summary table
recorded that; §1.1's body prose still said otherwise, and the registration copied the body. The
accurate statement is narrower: **E1-SCAN is the first to divide a phase time by the count.** The
registration is append-only, so the error is corrected here; §1.1's stale sentence is fixed in
place, since `FINDINGS.md` is a derived index.

This is the second §1.1 failure in one experiment, and it has the same root as H3's: a warning was
read, quoted, and then not applied to the sentence being written.

#### What this does not answer

- **Edges is not fully explained, it is fully *linearised*.** b ≈ 1.0–1.1 over four rungs is
  consistent with a residual too small to separate from noise at this n, not with a proof of
  linearity. Nine rungs would measure it properly; four were registered.
- **`importResolvedPathFor`'s per-call `JSON.parse` was never isolated** (task #6). It is inside
  the ~82–118 µs/row constant that remains, and this design cannot see it.
- **One corpus family.** n8n rungs only; vscode contributed the plan evidence, not timings, and the
  two are not pooled.
- **Nothing here measures `resolveCallTarget` invocations.** No per-call cost is claimed.

---

## E1-LADDER PRE-REGISTRATION (2026-08-17) — does a residual survive the range fix?

**Registered before any run.** Gate 5: this block and the three instrument scripts are committed
before `e1-ladder-run.mjs` is invoked. Task #5, re-scoped after E1-SCAN.

### Why this exists

E1-SCAN (`dc5536d`) measured the range fix against the `files` prefix scan and found the scan *was*
the edges exponent: `b` falls 1.4382 → **≈1.0–1.1**. That result is registered, scored, and stands.
What it cannot do is say whether the remaining curve is **flat** or **slightly bent**, because it
measured four rungs (T1/T5/T8/T9) and its own RESULT records that the post-fix exponent is not
stable to four figures across slices (0.9785 / 1.0738 / 1.1051 depending on which rungs are kept).

"Name the residual in the edges curve" is the last open piece of that question. This experiment
resolves it at full ladder resolution.

### Mandatory pre-registration reading (`.claude/CLAUDE.md`, `FINDINGS.md` §6)

**§1 — the register of unread data. Checked; it changed this design twice.**

1. **The pre-fix half of this experiment is already measured, and already fitted.**
   `e1-verify-runs.jsonl` carries `phase_ms.edges` at **all nine rungs**, 3 reps each — a complete
   pre-fix ladder. §1's `phase_ms.*` row is marked **CLOSED 08-17**: `e1-unread-fit.mjs` reads all
   87 rows, and `e1-unread-fit.json` already publishes
   `e1_verify.phases.edges.all_runs.b = 1.3814453328704095` (n=27, `se_hc3` 0.0794) and
   `rung_medians.b = 1.3949401082042703` (n=9, `se_hc3` 0.1593).
   **E1-LADDER therefore runs one arm, not two.** The comparator is a committed artifact.
   Re-derived from the journal this session as the §11.1 check: OLS on the nine rung medians gives
   **1.394940**, reproducing the committed figure to six figures.

2. **`potential_call_count` is a trap this program has already sprung twice**, once knowingly
   (§1.1, and E1-SCAN's H3 died on it). **No hypothesis below routes through it.** All three are
   stated on `phase_ms.edges` against `chunk_count` only. It is not used as a normaliser, a floor,
   or a denominator anywhere in `e1-ladder-score.mjs`.

3. **Two journal-shape traps, both avoided in the scorer.** `e1-verify` rows have **no `tier`
   field** — the rung is `corpus`, and grouping by `tier` silently collapses nine rungs into one
   bucket that returns T5's value. And `potential_call_count` sits only under `measurement`.
   E1-LADDER's own journal writes `tier` *and* `corpus` for exactly this reason.

4. **Still open in §1 and untouched by this experiment:** `chunk_fts_count` / `identifier_fts_count`
   (27 rows, task #7). Not read here — out of scope, and named so the register stays honest.

**§3 — dead hypotheses. Checked. This experiment re-proposes none of them, and one needs care.**

- *"The edges exponent has a cause other than the `files` full scan"* is **dead** (E1-SCAN).
  E1-LADDER **does not reopen it.** It accepts that the scan was the exponent and asks only how much
  curve is left underneath. Should H1 be refuted, that is *new evidence* about a residual, not a
  revival of the dead hypothesis — and the registration says so in advance so the distinction
  cannot be made after the fact.
- *E1-SCAN's H3* is **dead**, killed by the non-existent `POTENTIAL_CALL` floor. H3 below is a
  different hypothesis with a similar name; it rests on adjacent-rung local slopes and touches no
  row count.
- *The edges exponent is the page cache* is **dead** (E1-AB). No cache lever here; `cache_size` is
  left at its default and pinned by Gate 1's config clause.

### Design

**One arm.** The post-fix binary at `HEAD = dc5536d`. `git log 88f4592..HEAD -- src/` returns **zero
commits**, so this binary is source-identical to E1-SCAN's arm R. Working tree clean.

**Nine rungs x 3 reps = 27 runs**, the full E1 ladder, hardlinked from the pinned n8n worktree via
the frozen `e1-tiers.json` manifest (seed 811): T1 656f/3,679c through T9 13,330f/73,359c.

**Order** is `seededShuffle(pairs, 811)` over the 27 (corpus, rep) pairs — the established
convention. The input is 27 pairs, not E1-PHASE's 15, so this is a genuinely different permutation
and not a prefix of any prior schedule. Committed to `e1-ladder-schedule.json` with the binary pin
before the first run.

**No calibration.** `c` is `runIndex`'s fixed cost, and E1-PHASE's calibration TSDoc establishes it
lands **inside the `walk` phase** — schema DDL, lock-marker init and the empty walk all precede the
first phase boundary. The outcome here is `phase_ms.edges`, which `c` does not touch. Measuring an
unused constant invites post-hoc use; it is not measured. Total-duration figures, if reported at
all, are labelled **uncalibrated**.

### The estimator, fixed in advance

OLS of `ln(phase_ms.edges)` on `ln(chunk_count)`.

- **Primary: `all_runs`, n = 27** — every scored run, one point each. This is the estimator that
  produced the pre-fix comparator, so both sides of the contrast are computed the same way.
  Chosen over rung medians *because the committed artifact shows it is the tighter of the two*:
  pre-fix `se_hc3` is 0.0794 at n=27 against 0.1593 at n=9.
- **Secondary: `rung_medians`, n = 9**, reported alongside.
- HC3 standard errors are reported and are **context-only**, carrying `e1-unread-fit.mjs`'s own
  `ci_is_context_only` flag. The rungs are **nested subsets** (T1 ⊂ T2 ⊂ … ⊂ T9), so the points are
  not independent draws and no p-value is claimed. Every threshold below is a bar on a **point
  estimate**, as in E1-SCAN.

### Hypotheses

**H1 (primary) — no residual worth naming.** `b_R(all_runs) <= 1.15`.
Point forecast **1.05**. Refuted if `b_R > 1.15`, in which case the residual is real and its
magnitude is `b_R - 1`, which is the number task #5 has been asking for since it was opened.

**H2 (separation control) — the contrast reproduces.** `b_verify - b_R >= 0.20`, with
`b_verify = 1.3814453328704095` read from `e1-unread-fit.json`. This is the guard against the
machine, the harness, or the fit having moved: if H1 fires *and* H2 fails, H1 is an artifact and
the run is not evidence of anything.

**H3 (no bend) — the fix does not merely postpone the knee.** `max` over the eight adjacent-rung
local slopes `<= 1.30`.

This is the hypothesis four rungs could not test, and the reason nine are worth nine minutes. The
pre-fix ladder is *flat at the bottom and bends hard above T4* — derived this session from
`e1-verify-runs.jsonl`:

| segment | T1→T2 | T2→T3 | T3→T4 | T4→T5 | T5→T6 | T6→T7 | T7→T8 | T8→T9 |
|---|---|---|---|---|---|---|---|---|
| pre-fix slope | 0.9033 | 1.0003 | 0.9740 | 1.1513 | 1.4689 | 1.5512 | 2.0722 | **2.4276** |

A post-fix exponent averaging 1.05 is compatible with two very different worlds: a flat curve, or a
flat bottom with a knee that has moved above T9's chunk count. Only the top-end local slopes
separate them, and an average over the whole ladder hides the difference. **H3 is the residual
test; H1 is the summary.** Bar set at 1.30, comfortably under the pre-fix maximum of 2.4276 and
above the 1.1051 E1-SCAN measured for post-fix T8→T9.

### Gates

Inherited unchanged: **Gate 0** (dist content hash pinned across all 27 runs), **Gate 0b**
(staleness — src newer than dist), **Gate 1** (n8n corpus pin, A4-MAT-4 tier file-set verification,
config pin), **Gate 3** (external vs fitted clock with A4-MAT-6 retakes and `selectFitted`),
**Gate P** (phase attribution >= 0.95), **Gate P2** (a rung's three reps report identical
`chunk_count`). A4-MAT-3 attempt journaling and A4-MAT-7's VOID queue apply.

**Gate L (new) — cross-experiment replication, registered as a FINDING, not a blocker.**
Because this binary is source-identical to E1-SCAN's arm R, four of these nine rungs are a direct
re-run of measurements taken three days ago. E1-SCAN arm R medians: **T1 112, T5 446, T8 1461,
T9 2217 ms**. E1-LADDER's medians at those rungs are compared and **any deviation beyond ±15% is
reported as a finding**. It is not a blocker because machine state legitimately varies between
sessions; the band is generous on purpose (E1-SCAN's arm N reproduced E1-VERIFY within ±4%). A
violation would say the two experiments are not measuring the same thing, which matters more than
either result.

### Scoreable

`scoreable: true` requires 27/27 complete, 0 VOID, and Gate P2 identical at every rung.

### Also computed, explicitly descriptive and adjudicating nothing

`e1-ladder-score.mjs` recomputes the **two-term model** `edges_ms = a·E + b·E·F` on e1-verify's 27
**pre-fix** runs, reports its weighted and unweighted fits, its T1 and T9 residuals, and its
out-of-sample error against the vscode build (`vscode-build.json`: F = 8,653, E = 174,844,
`edges_ms` = 28,829, pre-fix binary `b77f0ae3…`).

**Why it is here and why it is fenced off.** `FINDINGS.md` §2.3 quotes "under-predicts T9 by 23%",
"misses T1 by −74%" and "vscode under-predicted by 30–37%" and then admits, in the same paragraph,
that these are **prose-only — no committed script computes them**. That is the §11.1 failure the
file itself warns about, and it is the second half of task #5. Persisting them retires the prose.

It enters **no hypothesis and no verdict**. The model was an *inference device* for "something else
is also super-linear"; E1-SCAN tested that claim by direct counterfactual and H1/H3 test it again
here at nine rungs. Measurement outranks the fit. If the recomputation fails to reproduce the prose
figures, **that is the finding** and it is reported as one rather than reconciled away.

### Direction of error, declared

I wrote the range fix, I predicted linearity in E1-SCAN, and I expect H1 to fire. That is the
condition under which controls earn their place, so H2 is registered as a hard falsifier of H1 and
H3 is written to catch the specific way a fix like this fails silently — by moving a knee rather
than removing it. E1-SCAN's block-1 read had both its controls outside the band before the full n
brought them in; partial series will not be reported as trends here either.

---

### E1-LADDER RESULT (2026-08-17) — H1 FIRES, H2 FIRES, H3 IS REFUTED BY ITS OWN NOISE

Scored by `eval/e1-ladder-score.mjs` from `eval/results/e1-ladder-runs.jsonl`; verdict at
`eval/results/e1-ladder-verdict.json`. **27/27 runs, 0 VOID, 0 interrupted, `scoreable: true`.**
Three Gate 3 triple-failures (T3#2, T4#2, T4#3) logged and retained per A4-MAT-6 — all three in the
T3/T4 region, which is a machine-contention signal and matters below.

#### The primary series

`phase_ms.edges`, median of 3 reps. Pre-fix column is `e1-verify`'s committed nine-rung ladder.

| rung | chunks | files | pre-fix | post-fix | ratio |
|---|---|---|---|---|---|
| T1 | 3,679 | 656 | 113 | 110 | 1.027 |
| T2 | 5,332 | 954 | 158 | 154 | 1.026 |
| T3 | 7,761 | 1,393 | 230 | 238 | 0.966 |
| T4 | 11,278 | 1,986 | 331 | 340 | 0.974 |
| T5 | 16,529 | 2,880 | 514 | 417 | 1.233 |
| T6 | 23,854 | 4,191 | 881 | 676 | 1.303 |
| T7 | 34,691 | 5,976 | 1,575 | 977 | 1.612 |
| T8 | 50,299 | 8,945 | 3,401 | 1,758 | 1.935 |
| T9 | 73,359 | 13,330 | 8,501 | 2,439 | **3.485** |

- **H1 FIRES.** Post-fix exponent **1.0184** (all_runs, n=27, `se_hc3` 0.0351, R² 0.9817,
  `ci_hc3` [0.9461, 1.0908] — context-only). Bar was 1.15. Rung-medians estimator agrees at
  **1.0339** (R² 0.9930).
- **H2 FIRES.** Separation **0.3630** against a 0.20 minimum, with `b_verify = 1.3814453328704095`
  read from `e1-unread-fit.json` and reproduced from the journal by the scorer's self-check to
  within 1e-9.
- **H3 IS REFUTED.** Max adjacent local slope **1.5813** at T7→T8, against a bar of 1.30. **The
  refutation carries no mechanism content — the bar was finer than the statistic can resolve.**
  See below.

#### The residual, named: there isn't one

`b - 1 = 0.018`. Nine rungs say the post-fix edges phase is **linear in chunks**, and unlike
E1-SCAN's four-rung fit this one is stable:

| slice | E1-SCAN (4 rungs) | E1-LADDER (9 rungs) |
|---|---|---|
| leave-one-rung-out range | 0.9785 – 1.1051 | **0.9944 – 1.0449** |

Every one of the nine leave-one-out fits lands within 0.026 of the full-ladder value. E1-SCAN's
RESULT refused to quote `0.9972` as a four-figure exponent and was right to; **b = 1.02 is now
quotable**, and that precision is what the extra five rungs bought.

**The one slice that still hints at a residual, reported because it is the strongest counter-
evidence available:** fitting only the top half (T5–T9) gives **1.1692** — above H1's bar — while
the bottom half (T1–T5) gives **0.8982**. Neither was registered. With 15 runs a side at this
session's noise level the split is not distinguishable from noise, and the leave-one-out stability
argues against reading it as structure. But it is the honest residual candidate and it is not
resolved here.

#### Why H3 was refuted, and why that refutation says nothing about the mechanism

The registered statistic — the largest single adjacent-rung local slope — has a noise width
approaching **1.6**, recomputed here across all nine rep pairings per segment:

| segment | median-based | range over rep pairings | width |
|---|---|---|---|
| T1→T2 | 0.907 | [−0.172, 1.388] | **1.560** |
| T5→T6 | 1.317 | [0.803, 2.111] | 1.308 |
| T7→T8 | **1.581** | [0.924, 1.931] | 1.006 |
| T8→T9 | 0.868 | [0.447, 1.819] | 1.371 |

Adjacent rungs differ by only ~1.4× in chunks, so `ln` of that ratio is ~0.34 and a 20% error in one
rung's median moves the slope by ~0.5. **I registered a bar of 1.30 on a quantity whose own
uncertainty is ±0.5 or worse.** That is a design error in the registration, and it is mine: the
noise was computable before the run from E1-VERIFY's rep spreads and I did not compute it.

The substantive claim H3 encoded is *also* false, and for a reason visible without any statistics:
**a knee that unbends is not a knee.** The T7→T8 slope of 1.581 is immediately followed by T8→T9 at
**0.868**. Pre-fix, the profile rises monotonically to the top rung; post-fix it oscillates around
its own mean:

| segment | T1→T2 | T2→T3 | T3→T4 | T4→T5 | T5→T6 | T6→T7 | T7→T8 | T8→T9 |
|---|---|---|---|---|---|---|---|---|
| pre-fix | 0.903 | 1.000 | 0.974 | 1.151 | 1.469 | 1.551 | 2.072 | **2.428** |
| post-fix | 0.907 | 1.160 | 0.954 | 0.534 | 1.317 | 0.983 | **1.581** | 0.868 |

**Post-hoc and unregistered, labelled as such:** Spearman rank correlation of local slope against
ladder position is **0.976 pre-fix** (near-perfectly monotone — a real bend) and **0.143 post-fix**
(no trend). Post-fix slopes have mean 1.0380, which is the fitted exponent, and SD 0.3158, which is
the noise. The registered descriptive curvature statistic agrees: quadratic departure
**45.58% pre-fix, 8.73% post-fix**.

Had H3 been registered as a trend test rather than a max-of-eight, it would have fired. It was not,
so **it is recorded as refuted**, and the trend figures above are reported as post-hoc context that
adjudicates nothing.

#### Gate L — cross-experiment replication, one excursion

Same source (`git log 88f4592..HEAD -- src/` empty), Gate 0 hash pinned across all 27 runs.

| rung | E1-SCAN arm R | E1-LADDER | deviation |
|---|---|---|---|
| T1 | 112 | 110 | −1.8% |
| T5 | 446 | 417 | −6.5% |
| T8 | 1,461 | **1,758** | **+20.3%** |
| T9 | 2,217 | 2,439 | +10.0% |

**T8 is outside the ±15% band — reported as the finding Gate L was registered to produce.** What
can be said: the two rungs' rep sets *overlap* — E1-LADDER T8 is [1390, 1758, 1936] against
E1-SCAN's [1503, 1441, 1461] — so the minimum here sits below E1-SCAN's median. This session was
measurably noisier: within-rung spread reached 60.9% (T1), 38.2% (T6), 31.1% (T8) against E1-SCAN
arm R's tight T8 spread of 4.3%, and three runs failed Gate 3 on all three attempts. What **cannot**
be said is that this is proven to be contention rather than something real about T8; the binary is
identical and no code explains it, but a null explanation is not a measurement. T8's median is also
the single largest contributor to H3's 1.581.

#### The two-term model, recomputed — and two of the four prose figures do not reproduce

`edges_ms = a·E + b·E·F`, fitted on `e1-verify`'s 27 **pre-fix** runs. **Descriptive; adjudicates
nothing.** This retires the prose-only figures in `FINDINGS.md` §2.3.

| fit | a | b | T1 error | T9 error | vscode (out of sample) |
|---|---|---|---|---|---|
| unweighted OLS | 1.7053e-3 | 1.3416e-5 | **−82.2%** | **+3.0%** | **−28.6%** |
| relative-error weighted | 4.5985e-2 | 6.7132e-6 | −14.4% | **−22.7%** | **−36.9%** |

Against what §2.3 asserts in prose:

| prose claim | recomputed | verdict |
|---|---|---|
| relative weighting under-predicts T9 by 23% | −22.7% | **reproduces** |
| unweighted fits T9 to −1.1% | **+3.0%** | **does not reproduce** — wrong sign |
| unweighted misses T1 by −74% | **−82.2%** | **does not reproduce** |
| vscode under-predicted 30–37% either way | −28.6% / −36.9% | **partially** — one end outside |

The qualitative conclusion is unchanged and now has a script behind it: **no single `(a, b)`
describes the whole ladder** (T1 off by −82% while T9 sits at +3%), and vscode is under-predicted
out of sample by roughly 29–37% under either weighting. The provenance of the two non-reproducing
figures cannot be reconstructed — no script computed them — which is exactly the argument for not
having prose-only numbers.

#### A defect the self-check caught before it could matter

The scorer refuses to run unless it reproduces `e1-unread-fit.json` exactly, because H2 subtracts
that script's number from this one's. On first execution it failed: `rung_medians` matched to zero
while `all_runs` differed by 0.00088. Cause — reading `measurement.phase_ms` instead of the
top-level fitted value. On a Gate 3 failure `selectFitted` puts the fitted attempt at the top level
and leaves the last raw attempt under `measurement`, so the raw field scores the **wrong attempt on
exactly the runs the retake machinery exists to handle**. E1-VERIFY has one (T3 rep 3: 240 fitted
vs 233 raw), which does not move T3's median — hence the medians matching while the 27-point fit
shifted.

**Completeness check, per §11.3:** no committed scorer reads `measurement.phase_ms`, so **no
published result is affected**. Divergent rows by journal: **`e1-ladder` 3/27** (its three Gate 3
triple-failures, T3#2/T4#2/T4#3), `e1-verify` 1/27, `e1-ab` 0/30, `e1-fts` 0/31, `e1-phase` 0/15,
`e1-scan` 0/24.

**This paragraph's first draft said `e1-ladder` 0/27, and that was false.** The audit behind it was
run before the ladder journal existed; the zero was pattern-matched from the other five rather than
measured. The §11.8 recomputation required before commit caught it while this block was still
uncommitted. Recorded rather than silently corrected, because the failure mode — quoting a count
for an artifact that did not exist when the count was taken — is the one §11.1 exists to prevent,
and E1-LADDER is the journal with the *most* divergent rows of any in the program.

#### What this does not answer

- **One corpus family.** n8n only. The top-half slice at 1.1692 and vscode's 1.73× edge density both
  point at the same untested question, and `vscode-build.json` remains a **pre-fix** build.
- **The T5–T9 sub-fit is unresolved**, not dismissed. Separating a ~0.15 residual from this
  session's noise needs more reps per rung, not more rungs.
- **H3's real question was answered post-hoc.** The registered form was a bad instrument; the trend
  and curvature figures that answer it were not pre-registered and are labelled throughout.
- **Nothing here isolates `importResolvedPathFor`'s `JSON.parse`** (task #6), and nothing here
  measures `resolveCallTarget` invocations. No per-call cost is claimed.
- **The pre/post contrast is cross-session.** The pre-fix column is E1-VERIFY's, measured days
  earlier on a different binary build of the same source. E1-SCAN's within-session A/B remains the
  stronger causal evidence; this experiment's contribution is resolution, not causation.

---

### CORRECTION (2026-08-18) — `POTENTIAL_CALL` was described backwards, in §1.1 and in E1-SCAN's RESULT

Found while characterising `importResolvedPathFor` for task #6. Appended, not edited, because the
E1-SCAN RESULT block is part of the committed record.

**The claim, as written** (E1-SCAN RESULT, this file ~:10407, and `FINDINGS.md` §1.1):
"`POTENTIAL_CALL` is what the resolver emits when it *cannot* pin a call, and its share rises with
corpus size; unresolved calls are evidently cheaper per row than resolved ones."

**It is inverted.** A stored `POTENTIAL_CALL` row is a **successfully resolved** call:

- `src/graph/populate.ts:728-736` — `to_id` comes from `callToMap`, then
  `if (to_id === undefined) return []`. An unresolved call produces **no row at all**.
- `src/ast/extractors/typescript.ts:1344-1360` — the extractor pushes a `POTENTIAL_CALL` candidate
  only in the `edge_emitted` bucket, i.e. only where `resolveCall` already linked the callee.

The edge type names the *class of call requiring file-evidence resolution*, not a failure to
resolve. So the rising 0.259 → 0.370 rows/chunk means a growing fraction of call sites **succeed**,
which is the sensible direction: a larger corpus contains more of its own targets.

**A `to_id IS NULL` count is not evidence** and was briefly mistaken for it during this check —
`edges.to_id` is declared `INTEGER NOT NULL`, so zero nulls is vacuous. The code path is the
evidence. Recorded because the vacuous check *agreed* with the right answer, which is the most
dangerous kind of wrong evidence.

**What this does and does not disturb.**

- **E1-SCAN's H3 refutation is unaffected.** H3 died on a measured slope (1.1051 against a
  registered [1.15, 1.55] band). That is a measurement and it stands. Only the *explanatory sentence*
  attached to it was wrong.
- **§1.1's headline warning survives and is strengthened.** `potential_call_count` is still not a
  work counter — and now for a sharper reason than the one recorded. It counts *successes* and omits
  every failed resolution attempt, each of which costs real time and leaves no trace. The count
  understates work, and it understates it by an amount no committed artifact measures.
- **The "unresolved calls are cheaper per row" explanation is withdrawn.** The falling post-fix cost
  per surviving row (117.5 → 81.7 µs) is still measured; the mechanism offered for it was not.

---

## E1-HOIST PRE-REGISTRATION (2026-08-18)

**Does the per-file import index (`c04d906`) show up in the T9 edges phase, and by how much?**

Registered before any run (Gate 5). Task #6.

### What `FINDINGS.md` said before this was written

Required by `.claude/CLAUDE.md`. Both sections were read in full; here is what was found and what it
changed.

**§1 (unread data) — three items bear on this design, all three altered it.**

1. **`measurement.phase_ms` is not the scored value; the top-level `phase_ms` is.** On a Gate 3
   failure `selectFitted` puts the *fitted* attempt at the top level and leaves the *last raw*
   attempt under `measurement`. The scorer for this experiment reads **top-level `phase_ms.edges`**
   and asserts it, exactly as `e1-ladder-score.mjs` does.
2. **`potential_call_count` is a surviving-row count, not a work counter** (§1.1), and it has already
   killed one hypothesis that routed through it (E1-SCAN's H3). **No statistic in this registration
   is normalised by it.** The outcome is a phase time and a paired ratio of phase times.
3. **`chunk_fts_count` / `identifier_fts_count` remain unread at 54 rows.** This experiment adds 40
   more and does not read them. That is task #7 and is not smuggled in here; it is recorded so the
   §1 re-run after this journal lands does not report it as new.

**§3 (dead hypotheses) — one entry is directly load-bearing, and it set the sample size.**

*"Do not register a bar finer than its statistic can resolve"* — the caution E1-LADDER's H3 paid
for. Applied here **before** any bar was written, which is the whole point of the entry:

- The noise was computed from committed data first. `e1-ladder-runs.jsonl`, `phase_ms.edges`,
  3 reps/rung: median CV **7.45%**, T9 **9.61%**, T8 16.43%. `e1-scan-runs.jsonl` does better
  because its arms are blocked and adjacent — within-cell CV at T9 **2.86%**, and the **paired
  within-block ratio CV 5.6%**.
- The effect was measured before it was hypothesised (below).
- The sample size follows from those two numbers rather than from convention.

Also checked and deliberately **not** re-proposed: the edges exponent is **closed as a scaling
question** (§2.3, `b = 1.0184`). This registration makes **no claim about any exponent.** It is a
constant-factor question at one rung, and a design that produced an exponent here would be
re-opening a settled matter with a worse instrument.

### The effect size, measured first

Both implementations were replayed verbatim against the retained `run-T{1,5,8,9}-r3` databases
through the real Kysely + better-sqlite3 stack — paired, warmed, with arm order alternating between
reps. Not a registered experiment; an instrument calibration, so the bars below face a number
instead of a guess.

| rung | queries | import rows fetched | saved (median) | % of edges phase | % of total build |
|---|---|---|---|---|---|
| T1 | 1.67× | — | 0.2 ms | 0.18% | 0.008% |
| T5 | 2.32× | 2.82× | 5.2 ms | 1.25% | 0.045% |
| T8 | 3.07× | 4.65× | 31.0 ms | 1.76% | 0.080% |
| **T9** | **3.50×** | **5.93×** | **87.1 ms** | **3.57%** | **0.151%** |

Three caveats on that table, each of which weakens it in a stated direction:

- **The workload is a LOWER bound.** It is reconstructed from stored `edges` rows, and a stored row
  is a *successfully resolved* call (§1.1). Failed resolutions called `importResolvedPathFor` too and
  left nothing behind. The true saving is ≥ these figures.
- **The lookup keys are approximate.** The replay feeds target-symbol names, which are not always the
  real lookup key for qualified resolutions, so arm N's short-circuit may land in the wrong row.
  Bounded by re-running T9 with **every lookup forced to miss** — arm N's worst case — which gives
  **81.7 ms** against 87.1. The estimate is insensitive because the query dominates, not the parse.
- **The first version of this table was wrong, by 6×.** It reported 194 ms at T8 and 289 ms at T9.
  The rep loop ran arm N then arm H every time, so N warmed the cache for H, and the host was at
  load average ~15. Alternating the order and re-measuring on a quiet moment reproduced the original
  reading (31.0 vs 32.7 ms at T8). Recorded rather than quietly corrected: **a benchmark that does
  not alternate arm order is measuring its own schedule.**

### Why T9 only, and what is deliberately not run

Blocks per arm for 80% power at α = .05, from the measured effect and the E1-SCAN paired-ratio CV:

| rung | effect | paired ratio CV | n/arm — outcome `phase_ms.edges` | n/arm — outcome `duration_ms` |
|---|---|---|---|---|
| T5 | 1.25% | 25.2% | 3,191 | — |
| T8 | 1.76% | 2.8% | 20 | 7,422 |
| **T9** | **3.57%** | **5.6%** | **20** | **1,091** |

> **[CORRECTION, made before any run — the closed form above is the wrong one.]**
> `n = 7.849 (CV/effect)²` is the sample size for a **mean**. The registered primary is a
> **median**, which is ~64% as efficient on normal data, so the formula understates what this
> design needs. Simulating the *actual registered decision rule* — "the 95% BCa interval on the
> median of n paired ratios lies entirely below 1.0", 400 trials per point at the design point
> (effect 3.57%, ratio CV 5.6%):
>
> | n | 20 | 30 | 40 | 50 |
> |---|---|---|---|---|
> | power (median, primary) | **72%** | **87%** | 93% | 98% |
> | power (geomean, secondary) | 83% | **94%** | 99% | — |
>
> **20 blocks would have been an 80%-power claim delivering 72%.** The design is therefore 30
> blocks, and the table above is retained rather than rewritten because the wrong closed form is
> the more useful thing to leave in the record.
>
> This is E1-LADDER's H3 failure caught one step earlier: the same error — a bar or a bound whose
> statistic cannot deliver what is claimed of it — found *before* the runs rather than in the
> verdict, because §3 now says to look. The check that found it cost one simulation.
>
> If the realised ratio CV comes in at 8% rather than 5.6%, n=30 delivers ~75% (geomean) and the
> result will be reported as **underpowered**, not as negative. The scorer computes realised power
> from the observed CV and writes `adequately_powered` into the verdict for exactly this reason.

Two consequences, both registered as design commitments rather than discovered later:

- **A total-build-duration A/B is refused as unpowered.** At T9 it needs ~1,091 blocks per arm —
  roughly 35 hours of builds — to resolve an effect worth **0.151% of a build**. It is not run, and
  no statement about total build time will be made from this experiment. This is the §11.9 call
  stated up front.
- **T1/T5/T8 are not run.** T5 needs 3,191 blocks; T1's effect (0.18%) is smaller than the rung's own
  noise by two orders of magnitude. Running them would produce three null cells that look like
  evidence of no effect and are actually evidence of no power. **A null at an unpowered rung is not a
  finding, and this design refuses to manufacture three of them.**

The cost of this restraint is real and is stated: **there is no dose-response arm.** E1-SCAN could
show its mechanism switching off at T1; this one cannot, because the mechanism is ~40× smaller. H3
below is the substitute — a within-run placebo control instead of a cross-rung one.

### Design

- **Rung:** T9 (13,330 files / 73,359 chunks), pinned by `eval/results/e1-tiers.json`, seed 811.
- **Arms:** `N` = no-hoist, `78745be26ffee3373cb9831f3a7ac4791bf57cdc`;
  `H` = hoist, `c04d906c71d517ad3a2cb4a38966ef3c52689674`. The two commits differ in exactly
  `src/graph/populate.ts` and one new test file — verified with `git diff --name-only`.
- **Blocks:** 30. Each block runs both arms adjacent in time; **arm order flips between blocks**
  (E1-SCAN's rule — a fixed order loads thermal drift onto whichever arm always runs second).
- **Total runs:** 60.
- **Outcome:** top-level `phase_ms.edges`.
- **Primary statistic:** the **median over blocks of the within-block paired ratio**
  `edges_H / edges_N`, with a 95% BCa bootstrap CI over the 30 block ratios, 10,000 resamples.
- **Pre-registered secondary:** the **geometric-mean ratio** with a log-space t-interval.
  Registered *now*, before any run, precisely because it is the more powerful of the two — an
  estimator that becomes available only after the primary disappoints is a second chance, not a
  robustness check. The median stays primary because it is robust to the single wild run this rig
  does produce (E1-LADDER's T1 rung: 95 / 110 / 162 ms). **Both are reported whichever way the
  primary goes**, and disagreement between them is itself reported.

**This CI is inferential, and that is a genuine difference from every prior E1 experiment.** The
E1/E1-VERIFY/E1-LADDER intervals all carry `ci_is_context_only: true` because nested subsets are not
independent draws. Here the 20 blocks *are* independent repeated runs of the same pair, so the
interval means what an interval normally means. Its scope is **this host, this corpus, this rung** —
it does not generalise across machines, and no claim below extends it.

### Hypotheses

**H1 (primary) — the hoist reduces the T9 edges phase.**
FIRES if the 95% CI on the paired median ratio lies **entirely below 1.0**.

**H2 (magnitude) — the reduction agrees with the mechanism measurement.**
The replay predicts 87.1 ms saved (worst-case bound 81.7 ms). FIRES if the observed median saving
falls in **[40, 350] ms**. The band is wide on purpose and asymmetric for a reason: the prediction is
a *lower* bound, so overshoot is expected and undershoot is the informative failure. Below 40 ms the
replay over-predicts by >2× and the mechanism is not what is being measured; above 350 ms the saving
is 4× the mechanism and something other than the hoist moved.

**H3 (specificity / placebo) — the hoist touches only the edges phase.**
`walk`, `parse`, `write` and `finalise` each get the same paired-ratio treatment. FIRES if **all
four** 95% CIs contain 1.0. This is the internal control that replaces the missing dose-response arm:
the hoist cannot touch those phases, so if one of them also shifts, the shift is session drift and
H1 is confounded. **H3 failing invalidates H1 rather than merely adding a caveat** — registered that
way now so the temptation to read it as a footnote later is foreclosed.

### Gates

Inherited from E1-SCAN unless noted.

- **Gate 0 / 0b** — per-arm `dist/**/*.js` content hash, pinned in the schedule module; each arm's
  `dist/` must not be older than its own `src/`.
- **Gate S1 / S2** — arm identity (each arm's rel-hash matches its registered value) and arm delta
  (the arms' `dist/` must actually differ, and only where expected). An A/B whose arms are the same
  binary is the failure these catch.
- **Gate 1** — corpus pin: `MAST_STATE_DIR` unset, no stray config, and the indexed file set matches
  the T9 manifest exactly (A4-MAT-4).
- **Gate 3** — external vs fitted clock, with A4-MAT-6 retakes; failures logged and the fitted
  attempt retained, never dropped.
- **Gate P** — the five phases must account for ≥ 0.95 of the fitted clock.
- **Gate C (blocking, correctness)** — **the two arms must build an identical graph**:
  `file_count`, `chunk_count`, `symbol_count`, `edge_count` and `potential_call_count` equal across
  arms in every block. This is the strongest available check that the hoist preserved behaviour —
  73,359 chunks against the 200-file replay used during development — and **it outranks every timing
  number here.** A Gate C failure ends the experiment as a correctness finding regardless of H1.
- **Gate 5** — this registration is committed before any run.

### What would make this experiment worthless

Stated in advance so it cannot be rationalised afterwards:

- Gate C fails → the hoist is not behaviour-preserving; timing is irrelevant and the commit is a bug.
- H3 fails → the session drifted; H1's interval is not attributable to the arms.
- The host is under variable load (it was at load average ~15 while this was written) → the paired
  ratio CV exceeds E1-SCAN's 5.6%, power drops below the registered 80%, and **the honest report is
  an underpowered null, not a negative result.** The realised ratio CV will be reported alongside the
  verdict so power can be checked after the fact rather than assumed.


---

## E1-HOIST RESULT (2026-08-18)

**All three registered hypotheses fire. The per-file import index removes 9.13% of the T9 edges
phase — 2.5× more than the mechanism replay predicted — and the two arms build a byte-identical
graph over 73,359 chunks.**

Instruments: `eval/e1-hoist-{schedule,run,score}.mjs`, registered and committed at `235e8de`
before any run. Journal `eval/results/e1-hoist-runs.jsonl`, verdict
`eval/results/e1-hoist-verdict.json`. **60/60 runs, 30/30 complete blocks, 0 VOID, 0 interrupted,
0 Gate 3 misses, 0 Gate P failures, `scoreable: true`.**

### Verdict

| | statistic | 95% CI | registered bar | |
|---|---|---|---|---|
| **H1** | paired median ratio **0.9087** | [0.8860, 0.9495] | CI entirely below 1.0 | **FIRES** |
| **H2** | median saving **219.0 ms** | [—] | in [40, 350] ms | **FIRES** |
| **H3** | placebo phases all null | — | every non-edges CI contains 1.0 | **FIRES** |

Arm medians: **N 2617 ms, H 2329.5 ms.** Pre-registered secondary (geometric-mean ratio)
**0.9192**, 95% t [0.8725, 0.9684] — agrees with the primary, as registered it would be reported
either way.

H3's placebo set, which is what makes H1 attributable rather than merely observed:

| phase | ratio | 95% CI | blocks with H < N |
|---|---|---|---|
| `walk` | 1.0072 | [0.9905, 1.0394] | 12/30 |
| `parse` | 1.0030 | [0.9929, 1.0179] | 14/30 |
| `write` | 0.9987 | [0.9879, 1.0142] | 16/30 |
| `finalise` | 0.9964 | [0.9203, 1.0528] | 15/30 |
| **`edges`** | **0.9087** | **[0.8860, 0.9495]** | **25/30** |

Four phases sitting at 12–16 of 30 is coin-flip behaviour; the edges phase at 25/30 is not. **The
placebo control is the most valuable single row in this table** — it is what separates "the hoist
did this" from "the session drifted", on a rig that Gate L shows drifted 18%.

### GATE C — the result that outranks the timing

**The arms built an identical graph in every one of the 60 runs.** Recomputed independently of the
scorer, across all five counts:

| | `file_count` | `chunk_count` | `symbol_count` | `edge_count` | `potential_call_count` |
|---|---|---|---|---|---|
| arm N | 13,330 | 73,359 | 51,551 | 48,497 | 27,127 |
| arm H | 13,330 | 73,359 | 51,551 | 48,497 | 27,127 |

Every column is a single distinct value across both arms and all 60 runs. The hoist rewrote how
import evidence is looked up — from a query per call name to one index per file, with first-write-
wins replacing a row-scan short-circuit — and the resulting graph is unchanged at 73,359 chunks.
**This is a far heavier equivalence check than the 200-file replay used while developing the
change**, and per the registration it outranks every timing number here. Had it failed, `c04d906`
would have been a bug regardless of how fast it was.

### Two post-hoc analyses, labelled as post-hoc

Neither was registered; neither adjudicates. Both are reported because they bear on whether H1 is
believable.

**A distribution-free confirmation.** 25 of 30 blocks favour the hoist; an exact two-sided sign test
gives **p = 3.2 × 10⁻⁴**. This uses no bootstrap, no normality assumption and no estimator choice,
so it is the one statement here that survives any objection to the BCa machinery.

**The effect is not an artifact of the machine freeing up.** Wall-clock per build fell from ~92 s to
~55 s over the schedule as background load drained. Splitting the schedule in half:

| | median ratio | median arm-N edges |
|---|---|---|
| blocks 1–15 (loaded) | 0.9025 | 2662 ms |
| blocks 16–30 (quiet) | 0.9210 | 2334 ms |

The effect is present in both halves, and slightly *larger* under load — consistent with the
mechanism, since a redundant query costs more on a contended machine. Arm order flips every block,
so ordering is balanced within each half.

### Where the extra 2.5× came from — INFERRED, not measured

The replay predicted 87.1 ms; the experiment measured 219.0 ms, a factor of **2.51×**. Gate L puts
this session **+18.0%** slower than the one that produced the prediction, which lifts the
drift-adjusted forecast to 102.8 ms and leaves a residual factor of **2.13×**.

That residual is consistent with the caveat the registration attached to the prediction: the replay
reconstructs its workload from stored `edges` rows, and a stored row is a **successfully resolved**
call (§1.1). Every failed resolution called `importResolvedPathFor`, cost real time, and left
nothing to count. A residual near 2× implies roughly half of all calls resolve to nothing.

**This is inference from a mechanism, not a measurement**, and it is recorded in the §11.5 sense:
the 219.0 ms is measured, the 2.13× is arithmetic, and the attribution of that 2.13× to unresolved
calls is *unmeasured*. The registration predicted the direction (it declared the forecast a lower
bound) and the direction held; that is weaker evidence than a count, and it is not upgraded here.

### Three defects in this experiment's own instruments

Recorded because a future reader will otherwise inherit them silently.

**1. The runner and the scorer compute different medians.** The runner reports arm N's T9 edges
median as **2623 ms**, the scorer as **2617 ms**. Both are right about their own definition and
neither is wrong about the data: `n = 30` is even, the runner takes `element[n/2]` and the scorer
averages `element[14]` and `element[15]` (2611 and 2623). The Gate L delta is 18.31% by one
convention and 18.04% by the other — both outside the ±15% band, so no verdict moves. **But two
instruments in one experiment disagreeing by 6 ms on the headline arm median is a defect**, and it
was found only because the two numbers were printed side by side.

**2. The scorer's post-hoc power figure uses the wrong closed form** — the same `n = 7.849
(CV/effect)²` that the registration corrected for the *design*. It is a mean-based formula reported
against a median-based decision rule, so `n_required_for_80pct_power: 19` in the verdict understates
the requirement. Simulating the registered rule at the realised parameters (effect 9.13%, ratio CV
13.95%) gives **85% at n = 19 and 91% at n = 30**. The conclusion — adequately powered — survives,
but it survives on a number the scorer did not compute. **The scorer was deliberately NOT patched
and NOT re-run**: it produced the registered verdict, and editing an analysis instrument after
seeing its output is the thing pre-registration exists to prevent. The correction lives here instead.

**3. H2's band was the wrong shape.** `[40, 350] ms` is absolute, on a rig whose own Gate L exists
because it drifts between sessions. It fired, but block 1 alone read 380 ms — outside the band — and
had the machine stayed at its initial load the registered H2 would plausibly have failed for a reason
that has nothing to do with the hypothesis. **A magnitude bar on a drifting rig should be expressed
relative to a same-session comparator**, not in milliseconds. The registration's own Gate L had the
information needed to see this and it was not used.

### Realised noise, against what was assumed

Registered assumption: paired ratio CV **5.6%** (from E1-SCAN's n=3 blocks). Realised: **13.95%** —
2.5× worse. The design survived only because the effect also came in 2.6× larger than forecast; the
two errors happened to cancel. **That is luck, not method.** An E1-SCAN CV estimated from three
blocks was never a sound basis for sizing thirty, and the honest reading is that this experiment was
powered by accident.

Arm N's own run-to-run CV was 10.8% (range 2108–3258 ms); arm H's range was 1864–3634 ms, its
maximum *exceeding* arm N's, driven by a single block-2 outlier (H 3634 vs N 2662, ratio 1.365).
**That outlier is why the median is the registered primary**, and it is the case the robust
estimator was chosen for before the data existed.

### Scope

`ci_is_context_only: false` — unlike E1/E1-VERIFY/E1-LADDER, whose nested-subset rungs are not
independent draws, these 30 blocks are independent repeated runs of the same pair, so the interval
is inferential in the ordinary sense. Its scope is **this host, this corpus, this rung**. Nothing
here generalises across machines, and **no claim is made about total build time** — the registration
refused that outcome as unpowered (~1,091 blocks per arm) before any run, and the refusal stands.

At 0.151% of a T9 build by the replay's accounting, or ~0.4% by this experiment's measured saving,
**the hoist remains immaterial to wall-clock and always was.** What this experiment establishes is
that it is real, that it is confined to the phase it should touch, and that it changes no output.


---

## FTS INVARIANT — closing §1's last actionable row (2026-08-18)

**Not an experiment.** No registration, no hypothesis, no threshold, no verdict. Task #7. It closes
the two `FINDINGS.md` §1 rows that arithmetic over committed journals could close, and it corrects
every row-count in that table, including one this session published two commits ago.

Instrument: `eval/e1-fts-invariant.mjs` → `eval/results/e1-fts-invariant.json`, with
`eval/__tests__/e1-fts-invariant.test.mjs` (11 tests).

### What was closed

**`chunk_fts_count === chunk_count` holds in 138 of 138 rows** — `e1-verify` 27, `e1-ladder` 27,
`e1-scan` 24, `e1-hoist` 60, spanning both arms of two A/Bs. §2.1 carried this as "27 of 27" hand
analysis; it is now a script that exits non-zero if it breaks.

Why it is worth a script rather than a sentence: this is the check that distinguishes a **correct**
FTS delete guard from a merely fast one. The guard at `1dba79b` skips
`DELETE FROM chunk_fts WHERE file_path = ?` when the file was never indexed, taking T9 from 538.6 s
to 62.1 s. A guard that skipped the delete when the file *had* been indexed would be exactly as fast
and would silently orphan rows. Nothing was running that check.

**`identifier_fts_count === chunk_count − markdown_chunk_count`, exactly.** The 0.9446–0.9568 ratio
recorded in §1.4 was never a fuzzy proportion. Measured against three retained databases: every
chunk lacking an identifier row is markdown, and every markdown chunk lacks one — T1 204/204,
T5 744/744, T9 3484/3484, **zero non-markdown misses in all three**. The variation across rungs is
just the markdown share of each nested subset.

**Confidence classes kept separate (§11.5):** the identity is *measured* on 3 databases and
*inferred* on the other 135 journal rows, which record no markdown chunk count. The script reports
the ratio it can compute and states the identity it cannot assert.

### The counting failure this exposed, in two stages

**Stage 1 — the row being closed.** Its tally was tracked at 27, then 54, then **114**, and all
three omitted `e1-scan`'s 24 rows. The true total is **138**. The most recent of those wrong
figures was written by this session, one commit earlier (`7264154`), while performing the §1
maintenance the rule in §6 requires.

The cause was not arithmetic. Each re-count asked *"does this new journal add a new series?"* and
incremented a running total. That is §11.3 exactly: **"is X true?" and "what else is like X?" are
different questions, and only the second yields a complete list.** The maintenance rule was followed
to the letter and still propagated the omission, because it diffs the *new* journal against the
register instead of re-deriving the register from *all* journals.

**Stage 2 — and then the same question, asked of the rest of the table.** Closing one row prompted
"what else is like this?", and the answer was: every other row. The table said "all five journals /
144" long after there were eight. Re-derived across all eight, folding each journal properly:

| row | table said | actually |
|---|---|---|
| `potential_call_count` | 144 | **255** |
| `external_ms` | 144 | **255** |
| `symbol_count` | 144 | **255** |
| `edge_count` | 144 | **255** |
| `phase_ms.*` | 87 | **213** |
| `write_spans.*` | 27 | **168** |

`symbol_count` was wrong in the other direction — listed "unscored by design" when Gate C in both
two-arm experiments reads it as a **correctness input**.

**A register maintained one row at a time decays everywhere except the row you touched.** §6's rule
is amended: re-derive every row from every journal; never increment.

### Scope, stated

The "Read by" column was re-verified by grepping every scorer and report for each field name. That
check is **name-based and therefore coarse** — a field read for one journal counts as read
everywhere — which is the caveat §1's method paragraph already carried and which this pass did not
remove. Spot-checked, not exhaustively verified.


---

## Stage 4.6 — the incremental FTS delete, closed by a rowid block (2026-08-18)

Closes FINDINGS.md §2.4, which was registered on 2026-08-17 as a known-open defect with an
**unmeasured** magnitude. Both halves are now measured, and one of them refuted the claim that
motivated the fix.

### What was wrong

`DELETE FROM chunk_fts WHERE file_path = ?` is a full FTS5 table scan — `xBestIndex` will not
consume an equality constraint on an ordinary column. The Stage 4.5 guard skips that scan when a
file was **never** indexed, which fixes cold builds and by construction cannot fix the incremental
path: a *changed* file is one that was already indexed, so it pays two full scans, and each grows
with the size of the whole corpus rather than the size of the file.

### The measurement that was missing (§2.4's own gap)

One changed file, real E1 corpora, median of repeated re-indexes:

| corpus | `chunk_fts` rows | delete for one changed file |
|---|---|---|
| T1 | 3,679 | 3.0 ms |
| T5 | 16,529 | 18.2 ms |
| T8 | 50,299 | 95.6 ms |
| T9 | 73,359 | 151.6 ms |

OLS on log-log: **b = 1.32, R² = 0.9975**, projecting **384 ms per changed file at 150k chunks**
(346 ms at vscode's 138,440).

**This refutes Stage 4.5's "379 ms for one file at any corpus size."** The *magnitude* is close
enough to be a real measurement someone took at roughly this scale; the words *"at any corpus
size"* are the error, and they are the load-bearing half — they assert the exact invariance the
data denies. Recorded in §3 as a dead claim.

### The mechanism, and a design that was wrong before it was right

The fix records the contiguous rowid block each file owns (`files.chunk_fts_lo/hi`,
`ident_fts_lo/hi` — `db.ts:43`, DDL `db.ts:279`, additive migration `db.ts:538` following the
`edges`/`metrics` precedent), because a rowid is the one column FTS5 will seek on.

**The first version of this design was refuted by measurement before any code was written.** The
registered plan was a single `DELETE ... WHERE rowid BETWEEN ? AND ?`, justified by reading the
query plan `SCAN chunk_fts VIRTUAL TABLE INDEX 0:=` as "constraint consumed". That reading was
wrong: the operative word is `SCAN`, FTS5 cannot use a rowid *range*, and only exact equality is a
seek. Isolating the locate cost at T9:

| | locate cost |
|---|---|
| `WHERE file_path = ?` (scan) | 75.01 ms |
| `WHERE rowid BETWEEN ? AND ?` | 75.96 ms |
| `WHERE rowid = ?` × 11 rows | 0.0293 ms |

So the deletes are issued one rowid at a time (`deleteFtsRowidBlock`, `populate.ts:401`). Full
delete of one 11-chunk file at T9: **1.125 ms by per-rowid equality against 129.8 ms by
`file_path`.**

Three supporting facts, all measured:

- `SELECT max(rowid)` on a 73,359-row `chunk_fts` is `SEARCH ... INDEX 192:` at **0.0008 ms**, so
  reserving a block explicitly costs nothing (`reserveFtsBlock`, `populate.ts:370`). The block is
  therefore true *by construction*, not inferred from SQLite's assignment order.
- Blocks were **already** contiguous 100% of the time before this change (8,945/8,945 files in
  `chunk_fts`, 8,572/8,572 in `identifier_fts`) because files are written one at a time.
- The two curves do cross for a file holding a large fraction of the corpus. On a synthetic 73k
  corpus: 27x faster at 5 chunks, 11.5x at 200, 2.8x at 1,000, still **1.3x at 3,000 chunks (4% of
  the corpus)**. No real file approaches the crossover, so there is deliberately **no size
  heuristic** — an untested branch firing on no real input is worse than the branch it replaces.

Reserving happens *before* the old rows are deleted (`populate.ts:459`). Deleting first would lower
`max(rowid)` and hand back rowids the old block still occupies. Reserving early only leaves gaps,
which cost nothing.

The old block is read by the monotonic write-guard's existing SELECT, which already ran before the
`files` row is deleted and reinserted — the last point at which the old block is readable. No
reordering of the write path was required.

### RESULT — both arms through the same code path

The "scan" arm is produced by nulling the recorded block, which triggers the documented
pre-migration fallback in `deleteFtsRowidBlock`. Same code, same corpus, same transaction
machinery; arm order alternates per rep (the E1-HOIST cache-warming lesson).

| corpus (synthetic) | `chunk_fts` rows | scan arm | block arm | speedup |
|---|---|---|---|---|
| T1~ | 3,684 | 0.85 ms | 0.116 ms | 7x |
| T5~ | 16,530 | 3.37 ms | 0.102 ms | 33x |
| T8~ | 50,304 | 10.70 ms | 0.093 ms | 116x |
| T9~ | 73,362 | 15.14 ms | 0.087 ms | **174x** |

- scan arm: **b = 0.97, R² = 0.9992** — cost grows with the corpus.
- block arm: **b = −0.09, R² = 0.9920** — the corpus-size dependence is *gone*, not reduced.

**Confidence, separated (§11.5).** The exponents and the 174x are **measured on a synthetic
corpus** (uniform 6-chunk files, generated content). Its absolute constants are ~10x smaller than
the real corpus — 15.14 ms against T9's 151.6 ms — because generated content yields a smaller
trigram index, and its scan-arm exponent is 0.97 against the real corpus's 1.32. What transfers is
the **shape**: one arm scales with the corpus and the other does not. The claim "incremental
re-index is now O(changed file), not O(corpus)" is measured for the shape and **inferred** for the
constant on a real repository. Re-measuring on a real corpus at 150k chunks remains unmeasured.

### Tests

`src/graph/__tests__/fts-rowid-block.test.ts`, 6 tests. The load-bearing one is
`leaves a neighbouring file untouched when one file is re-indexed`: an over-wide block does not
fail loudly, it silently deletes another file's search rows, and the only symptom is a document
that stops being findable. Also pinned: block bounds exactly the rowids owned, the two tables are
tracked independently (markdown chunks produce no identifier rows), a chunkless file records a NULL
block, the block moves on re-index, and a NULL block still cleans correctly via the fallback.

Suite 1,095 passing (was 1,089). `tsc --noEmit` clean, `eslint src` clean. `pnpm align:check`
remains red at its pre-existing baseline, **unchanged: 324 → 324 (0)**.

---

