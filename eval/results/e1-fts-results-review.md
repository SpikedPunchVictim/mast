# E1-FTS RESULTS REVIEW (2026-08-14) — adversarial review, post-run

Reviewer: independent adversarial pass. Every statistic below was recomputed from
`eval/results/e1-fts-runs.jsonl` with an independent script (fold, OLS, HC3, medians,
ratios all reimplemented — nothing read from `e1-fts-verdict.json` was trusted). Source
checked: `src/graph/populate.ts`, `src/indexer/index.ts`, `src/cli/index-cmd.ts`,
`eval/e1-fts-{schedule,score,report,run}.mjs`, `eval/e1-phase-score.mjs`,
`eval/e1-common.mjs`. Registration checked: IMPLEMENTATION_PLAN.md:5028–5357
(base + AMENDMENTS 1–4). Claims attacked: the scoring commit `5963c65`, the
registration text, and the scorer's own comments.

---

## VERDICT ON THE VERDICT

**MECHANISM_IDENTIFIED stands.** Every one of the five registered conditions
replicates exactly from the raw journal, each with a margin that no defect found
below can close:

| condition | recomputed | threshold | margin |
|---|---|---|---|
| `b_fts_del` | 2.3454 | ≥ 1.6 | +0.75 |
| T9 `fts_del/write` (median run, block 3) | 0.9169 | ≥ 0.50 | +0.42 |
| T9 `write_A/write_G` (median of 15.42/16.42/15.96) | 15.957 | ≥ 2 | 8× |
| `b_write(G)` | 1.0956 | ≤ 1.35 | −0.25 |
| `b_rest` | 1.1768 | ≤ 1.35 | −0.17 |

The fold is correct (30 retained runs; the superseded `A#T3#b1` and the voided
`G#T3#b1` are excluded by `foldJournal`'s last-record-wins rule,
`e1-fts-report.mjs:50-72`). All 30 retained runs have `gate3.ok === true`; recomputed
tiling spans 0.9937–0.9994; the voided record's own spans tile to 0.9945, confirming
AMENDMENT 3's account. The T3/b1 repair moves no adjudicating number by more than
0.012 (details in S3). The causal core — deletes timed directly at 2.35 exponent,
their removal collapsing the write exponent to 1.10 with the database the same size —
is overdetermined by three mutually-bracing measurements and survives every attack
mounted here.

The problems are in the write-up, not the arithmetic. Three claims around the verdict
are wrong as stated, and two more are licensed by weaker evidence than the text implies.

---

## WRONG

### W1 — "15/15 db-identity pairs byte-identical" — the gate verifies byte COUNT, not bytes

Commit `5963c65` says "byte-identical"; the registration (line 5151) says
"`db_bytes(G) == db_bytes(A)` ... is what makes arm G confound-free". What is actually
measured: `db_bytes: statSync(join(stateDir, 'graph.db')).size`
(`eval/e1-common.mjs:587`), compared for exact equality
(`dbIdentityVerdict`, `e1-fts-schedule.mjs:177-196`). That is file SIZE. Two SQLite
files of identical size can differ in content; SQLite sizes are quantized to whole
pages, so differing row content that lands in the same page count passes this gate.

Content identity was verified once, on the 56-file smoke corpus only:
`src/graph/__tests__/write-spans.test.ts:198` (`expect(skipped).toEqual(await
ftsContent(control))`). No run in the 30-run schedule had its content digested.

Converging evidence makes identity very likely true: `chunk_count`, `symbol_count`,
`edge_count`, `file_count` are read from `graph.db` itself (`readGraphCounts`,
e1-common.mjs) and are identical across all 6 runs at every rung (recomputed), and the
code path differs by exactly two skipped DELETEs whose zero-match property is the
hypothesis under test. But "byte-identical" was claimed and only "byte-count-identical"
was measured. The one failure mode this actually leaves open: if some delete had
matched rows (a path double-populated within a run), arm A would remove rows arm G
kept, and page-count coincidence could hide it. No `chunk_fts`/`identifier_fts` row
count is recorded per run, so the journal cannot exclude it. Low probability;
unverified as claimed.

### W2 — "the intervention delta and the directly-timed span are the same quantity by two independent routes"

(`e1-fts-score.mjs:149-151`; registration line 5177-5178 "two independent
measurements of the same quantity".) They are neither the same quantity nor
independent, and the journal itself proves the first half.

`write_A − write_G` = `fts_del_A` + (arm A's other spans − arm G's spans). That second
term is the delete-scan's collateral cost — cache pages the scans evict that every
other statement then re-faults — and it is measurably nonzero with a consistent sign
at both registered rungs. Recomputed per-span medians:

| T9 span | arm A | arm G | A−G |
|---|---|---|---|
| fts_ins | 11,306 | 9,055 | +2,251 (+25%) |
| commit | 15,458 | 13,658 | +1,800 (+13%) |
| rest | 7,090 | 4,166 | **+2,924 (+70%)** |
| txn+lock | 3,250 | 2,448 | +802 |
| **total non-del** | **37,099** | **29,242** | **+7,858** |

The T9 "2.07% agreement" (438,768 vs 429,882) is not two routes converging on one
number — it is the spillover term (7,858 ms ≈ 1.8% of `fts_del`) being small relative
to the 15% tolerance. Same sign at T7 (+1,925 ms, 2.45%). Nor are the routes
independent: both are computed from the same three arm-A runs.

The check itself is sound as a bounded-disagreement gate, and it passed honestly. The
description is wrong — and the wrongness hides a real, unreported finding: **the
delete-scan costs ~2% more than its own span**, because its cache eviction taxes every
other statement in arm A. This also means every arm-A span exponent is contaminated
upward by the growing scan (see U2).

### W3 — "b_write_a = 1.9379 replicates E1-PHASE's b_write = 1.9685 on a different binary and a different schedule" — this is not a replication in any independent sense

Recomputed from `e1-phase-runs.jsonl`: E1-PHASE's `b_write` refits to exactly 1.9685,
on chunk counts **3679 / 7761 / 16529 / 34691 / 73359** — digit-for-digit the same
five values as every E1-FTS rung. The two experiments share: the frozen corpus
manifest, the identical materialised tier trees, the machine, the OS, the harness, the
estimator (`fitSeries` is *imported* from `e1-phase-score.mjs`, so agreement of method
is by construction), and the production code path. What differs: the binary (rebuilt
with six timers) and the wall-clock day. "Different schedule" is cosmetic — the
interleaved arm G does not change what arm A's fifteen runs measure.

This is a repeatability check under instrument perturbation. It has value — the six
added spans could in principle have perturbed the write phase, and absolute levels did
shift (T5 −11%, T9 −6.5% vs E1-PHASE medians), so slope agreement to 0.031 (≈0.8 HC3
SE) genuinely shows the timers did not destroy the phenomenon. But it is one lab
measuring one specimen twice with the same ruler. Calling it a replication — the
commit ranks it as one of "two corroborations worth more than the verdict" — claims
inter-experiment evidence the design cannot produce.

---

## UNSUPPORTED (but plausibly or partially true)

### U1 — "2.02 lies OUTSIDE the measured interval [2.303, 2.388]" — the conclusion survives, the licensing does not

Two problems, one of them structural.

**The interval is quoted after being disclaimed.** The scorer registers the HC3 CI as
"context and not a bar" (`e1-fts-score.mjs:9-12`, `ci_is_context_only: true`), then
the commit quotes it as the instrument that excludes 2.02. You do not get to disclaim
an interval for your conditions and deploy it for your model comparison.

**The interval is anticonservative for exactly the reason the disclaimer exists.** The
15 runs are 5 rungs × 3 blocks and the residuals cluster by rung: recomputed rung-mean
residuals from the pooled line are T1 +0.028, T3 −0.135, T5 +0.138, T7 +0.018,
T9 −0.049 (ln units) against a within-rung sd of 0.064. That is systematic lack of
fit, reproduced in every block — the ln-ln relation is *curved*, with adjacent-rung
slopes 2.103 / **2.701** / 2.222 / 2.253. HC3 corrects heteroskedasticity, not
clustering, and treats 13 df as real; the fitted `b` is a chord across a visibly
non-power-law relation, and no amount of block replication shrinks the misfit.

**The conclusion nonetheless stands on other legs**: per-block slopes are
2.3169 / 2.3716 / 2.3476 (sd 0.027; a 3-cluster t-interval is [2.277, 2.414]); the
5-point rung-median fit gives 2.350; the *smallest* adjacent-rung slope is 2.103. Every
honest cut exceeds 2.02. The measured growth really does outrun the pure `N·F` scan
model — but it is licensed by the point estimate's margin and its cross-block
reproducibility, not by a ±0.042 interval.

**What the one-number gloss hides**: the +0.33 excess is not spread evenly — it is
concentrated in the T3→T5 step (local slope 2.70, and `(ratio−1)` grows ×3.62 across
that step against ×~2.25 elsewhere, see U3). Something categorical happens between
45.6 MB and 95.2 MB of database — the obvious suspect is the FTS content shadow
tables outgrowing the 15.6 MiB page cache (`cache_size: -16000`), changing per-byte
scan cost. Unmeasured, unmodelled, and materially relevant to extrapolating the fix's
benefit beyond T9.

### U2 — "no second super-linear term survives in rest" — true, but the scored number is the contaminated one, and the condition alone doesn't cover what the label implies

The condition tests only `rest`, in **arm A**. Two spans it does not test sit above
it: `b_commit` = 1.2128 (CI up to 1.267) and `b_fts_ins` = 1.1642. Had `commit` come
in at, say, 1.5 with a small share, MECHANISM_IDENTIFIED could still have fired — the
condition structure has a gap. In this data the gap is closed empirically by
`b_write(G)` = 1.0956, which caps the aggregate remainder, and by per-span fits in
arm G — which the author never reported and which are the *clean* numbers:

| span | b (arm A, scored) | b (arm G, recomputed) |
|---|---|---|
| rest | 1.1768 | **1.0124** |
| fts_ins | 1.1642 | 1.0923 |
| commit | 1.2128 | 1.1684 |

Arm A's span exponents are inflated by the delete-scan's growing spillover (W2): the
scored `b_rest = 1.1768` reads as "rest grows at 1.18" when rest's intrinsic growth is
1.01 and the remainder is scan collateral. The registered claim is *stronger* than the
author knows — the `chunks` TEXT-PK autoindex term the PARTIAL branch was built for is
not just below the bar, it is absent (arm G's rest is flat-linear). But a super-linear
term at small share *inside* a span (e.g. the symbols insert within `rest`) remains
untestable at this granularity; the label "no second super-linear term survives"
should be scoped "in any measured span at material share".

### U3 — "the shape a quadratic term removed from a linear remainder must have"

A quadratic-over-linear ratio has `(ratio − 1) ∝ N`: each ×2.11 chunk step should
multiply `(ratio − 1)` by ~2.11. Observed: ×2.27, **×3.62**, ×2.19, ×2.26. The
monotone climb is real and the constant-factor exclusion it supports is valid (see
S5), but the *quadratic* shape claim fails at the same T3→T5 step as U1. The curve is
"monotone and super-linear", not "the shape a quadratic term must have".

---

## STANDS

### S1 — The verdict arithmetic, in full
Every number in `e1-fts-verdict.json` that was recomputed matched to the printed
precision: all six exponents and their HC3 CIs, all five rungs' shares under both
readings, all fifteen per-block ratios, both validity rel-errors (0.0245 / 0.0207),
min tiling 0.9937, chunk identity, db-size identity. No discrepancy anywhere.

### S2 — AMENDMENT 2: the contradiction was real and the resolution is stricter
Registration lines 5160-5171: the MECHANISM_IDENTIFIED clause reads "iff all four
hold" (no `b_rest`); the PARTIAL clause reads "iff (1-2) hold but `b_rest > 1.35`, or
(3-4) fail". The case {all four hold ∧ b_rest > 1.35} is claimed by both. Resolving to
PARTIAL adds a fifth blocking condition to the author's pre-declared expected outcome
— strictly harder for the author, and `adjudicate()` (`e1-fts-score.mjs:198-240`)
implements exactly that. The second ambiguity (median run vs median of shares) was
fixed pre-run in code with both readings published; at T9 they differ (0.9169 vs
0.9215) and the *lower* one adjudicated. Both resolutions verified clean.

### S3 — AMENDMENT 3 and the T3/b1 repair: verified, and immaterial
Recomputed: all 30 retained runs have `gate3.ok === true`; min tiling 0.9937; the
voided `G#T3#b1` record's own spans (2,513 ms) against its own write (2,527 ms) give
0.9945 — the run was fine and the gate compared two attempts, exactly as the amendment
says. The repair ran ~8h later (17:04Z ≈ 10:04 local, vs the main schedule at
~02:05–02:47 local) and BOTH repaired runs are elevated against rung peers (A: 5,691
vs 4,338/4,580; G: 3,156 vs 2,364/2,359 — +24% and +33%). The within-pair ratio,
1.803, sits inside the other blocks' range (1.835, 1.942) — the pair drifted
*together*, which is a live demonstration that the within-block estimator's premise
held, not a breach of it. The elevated levels do enter the pooled fits, where drift
does not cancel; measured influence: `b_fts_del` 2.3454 → 2.3442 dropping the pair
(and 2.3463 substituting the superseded original), `b_write_a` → 1.9399, `b_write_g`
→ 1.1074. Nothing adjudicating moves by more than 0.012, and T3's ratio adjudicates
nothing. One honest footnote the author owes: had the original pair survived, T3's
ratio row would read median 1.942, not 1.835 (the unscored original pair's ratio was
2.090). Cosmetic here.

### S4 — AMENDMENT 4: real defect, correctly quarantined
`orphanedAttempts`' per-key counting genuinely double-charges a repaired-and-resumed
cell; `ftsOrphanedAttempts` (`e1-fts-report.mjs:231-256`) segments per terminal record
and is correct on this journal (0 interrupted). E1's scored instrument left unmodified
— the right call.

### S5 — The constant-factor exclusion
Ratios 1.368 / 1.835 / 4.020 / 7.620 / 15.957, monotone, spread ≤ 0.135 per rung. A
constant-factor artefact (arm-flag overhead, binary difference between arms — there is
none, both arms are one binary per Gate 0's pinned dist hash in
`e1-fts-schedule.json`) produces a flat ratio. The claim as worded — "could not be
produced by a constant-factor artefact" — is exactly right. (It does not exclude
size-dependent artefacts; nothing was claimed about those.)

### S6 — The instrument
`fts_del` brackets exactly the two DELETEs (`populate.ts:475-480`); arm G differs by
exactly `skipFtsDeletes !== true`; the production path passes no accumulator and pays
zero (`timed`, `populate.ts:151-163`); `--unsafe-skip-fts-deletes` refuses
`--incremental` (`index-cmd.ts:99-110`); `arm_identity` asserts `fts_del === 0` in G.
On the prompt's specific worry — the tiling gate CAN pass under cross-span
misattribution (it checks only the sum) — the cross-brace is the intervention delta,
and recomputing the validity check at the three unregistered rungs gives rel-err
8.6% (T1), 11.5% (T3), 0.5% (T5): all inside the 15% tolerance even where it was
never required to hold. The `rungShares` tie/fallback concern: with 3 runs and
integer-ms writes the median is always a member, `find` always succeeds, and no rung
has tied writes (verified); the `?? cell[0]` fallback is unexercised — but see
residual weakness 5.

### S7 — Ordering
The journal's realised order matches `buildFtsSchedule` exactly: blocks 1/3 run
G,A,G,A,G across the rungs; block 2 runs A,G,A,G,A. The forced imbalance (each arm
first 2-of-3 at any given rung) is what the registration said it would be (line
5124-5126), recorded rather than described as balanced.

---

## WHAT THE RESULT LICENSES — AND WHAT IT DOES NOT

**Licensed.** On a cold build, on this machine, on this corpus family: the per-file
FTS5 delete-scan carries the write phase's super-linear exponent. That is causal, not
correlational — the deletes were removed, nothing else changed (size-verified,
count-verified, one flag), and the exponent fell from 1.94 to 1.10 while the database
came out the same size at every pair. The guard fix (skip the DELETEs when the `files`
row did not previously exist) is worth building, with its verification path already
registered (E1's 9-rung ladder, immutable 1.35 bar).

**Not licensed** (the registration itself disclaims most of these, correctly):
- Anything about the **update path**, where the deletes do real work (registered).
- The **quantitative scan model**. `b_fts_del` = 2.35 ≠ 2.02, the excess is
  concentrated in one rung step, and the in-build scan cost's dependence on cache
  regime is unmeasured. Cost predictions beyond T9 extrapolated from either number
  are unsupported.
- "**Independently replicates E1-PHASE**" — same specimen, same ruler (W3). Say
  "repeats under the instrumented binary".
- **E1-AB's `rho_D(T9)` = 0.8486** — registered open, still open.
- Any claim beyond one machine, one corpus family, `cache_size = -16000`, mmap off.
  Every run shares those; the experiment has zero external-validity degrees of freedom.
- "No second super-linear term **anywhere**" — supported only at span granularity and
  material share (U2).

## WHAT SHOULD HAVE BEEN MEASURED AND WAS NOT

1. **A content digest per pair** in the scored schedule. The infrastructure existed
   (the smoke test does it); 15 extra digests would have converted W1's "very likely"
   into "verified".
2. **Per-rung FTS byte counts (F) in-run**, so the `N·F` model could be fitted
   against the data that tests it, instead of leaving a +0.33 exponent residual
   attributed to nothing.
3. **The arm-G span exponents** (rest 1.01, fts_ins 1.09, commit 1.17). They were in
   the journal all along, they are the uncontaminated versions of the numbers the
   verdict quotes, and they make the author's own case better than the numbers the
   author chose.
4. **The A−G span-by-span delta** (the ~2% spillover, W2) — reported, it would have
   turned a mislabelled "agreement" into a finding about cache-eviction collateral.

## RESIDUAL WEAKNESSES, RANKED BY THREAT TO THE CONCLUSION

1. **The unexplained curvature** (U1/U3). The mechanism's *identity* is safe, but the
   T3→T5 regime change means the measured 2.35 is a blend across at least two
   operating regimes. If the intended production corpus sits at a different
   size-to-cache ratio, both the cost model and the projected benefit of the fix
   shift by unknown amounts. This is the only finding that could embarrass the
   program later.
2. **Size-only DB identity** (W1). Low probability of concealment, but it is the one
   gate the whole confound-free claim rests on, and it was measured one rung below
   its name.
3. **Zero external validity**: one machine, one corpus family, one pragma
   configuration, n=3 blocks. The registered conditions' margins (8× on the ratio)
   make qualitative reversal implausible elsewhere, but nothing here demonstrates it.
4. **Arm-A span-exponent contamination** (U2/W2): `b_rest`, `b_commit`, `b_fts_ins`
   as published are upper bounds on intrinsic growth, not measurements of it.
5. **Latent scorer defect**: `rungShares`' `?? cell[0]` fallback
   (`e1-fts-score.mjs:130`) silently selects the first run when an even sample makes
   the median a non-member — the exact class of error `medianRun` in
   `e1-phase-score.mjs:49-60` throws on. Unexercised at n=3, armed the moment a
   block is ever dropped.
6. **The repair's 8-hour displacement** (S3): provably immaterial here (≤0.012 on any
   fit), but only because the margins were huge; the protocol has no registered bound
   on how much level drift a repaired pair may import into the pooled fits, where
   within-block cancellation does not operate.
