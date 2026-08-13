# E1-AB RESULTS REVIEW (2026-08-13) — adversarial review of the mechanism A/B

Reviewed against: `IMPLEMENTATION_PLAN.md` § E1-AB PRE-REGISTRATION (:4168–4483), AMENDMENT 1
(:4485–4746), AMENDMENT 2 (:4748–4773), AMENDMENT 3 (:4775–4846); the instrument
(`eval/e1-ab-schedule.mjs`, `eval/e1-ab-score.mjs`, `eval/e1-ab-run.mjs`, `eval/e1-ab-report.mjs`,
`eval/e1-common.mjs`); the raw journal (`eval/results/e1-ab-runs.jsonl`, 30 run records + 32
attempt_start records); the verdict (`eval/results/e1-ab-verdict.json`); the quarantine
(`eval/results/discarded-amendment3/`); and the vendored amalgamation
(`node_modules/better-sqlite3/deps/sqlite3/sqlite3.c`, SQLite 3.53.2). Every scorer statistic was
recomputed independently from the raw jsonl and every one reproduced to 4 decimals.

---

## VERDICT

The measurement is sound — all 30 runs pass Gate A with the correct per-arm pragma echo in the raw
journal, Gate P2's chunk counts are ground truth from `SELECT COUNT(*)` (not the pre-write stdout
counter; `eval/e1-common.mjs:493-503`), `db_bytes` is byte-identical across arms at every rung, the
discard of the seven pre-AMENDMENT-3 runs is complete and verifiable by timestamp, and every number
in the verdict JSON reproduces from the raw records. What does not fully survive is the
*interpretation*. **Claim 2 stands and is the strongest result here** — the category-error concern
about comparing `b_write(B)` to E1's 1.35 is real but quantitatively closed by cross-checks
(duration-basis slope for B is 1.5497, still 0.20 above the threshold on E1's own estimand; the
control's duration-basis slope 1.7623 reproduces E1's 1.7529 to 0.01), though EXPONENT_REDUCED
itself fired with a margin of 0.0204 on a bar advertised as "~20σ blunt" and the RESULT must say so.
**Claim 3 understates its own evidence**: ρ_D(T9) = 0.8486 is not merely "an anomaly licensing no
conclusion" — it demonstrates the cache-size response at T9 is non-monotone (the default cache is
the *slowest* of the three sizes tested), which directly contradicts the residency model the design's
own power analysis used (A4 predicted ρ_D(T9) ≈ 1.03), and therefore **Claim 1 must be weakened**:
"page-cache residency" is not a licensed reading of ρ_B; "a cache-size-coupled pager mechanism,
channel unresolved between read-miss volume and spill/eviction policy" is. The near-identity
ρ_C(T5) = 0.6921 vs ρ_B(T5) = 0.6871 plus a source fact the registration's A1 analysis did not carry
— FTS5 segment reads go through *read-only blob handles*, which are mmap-eligible inside a write
transaction (`sqlite3.c:77889`, `:251471`) — resolves the tripwire without overturning the A1 source
reading and re-points the miss traffic at FTS5 merges rather than index B-tree insertions. **Claim 4
as drafted must be withdrawn and rewritten**: the AMENDMENT 3 prediction ("closer to 1.0, not
further") was directionally satisfied on every comparable statistic (C 0.6720→0.6921, B/T5
0.6710→0.6871, B/T1 0.9279→0.9774, recomputed from the quarantined jsonl); "the prediction did not
pay out" is factually wrong in direction. The honest sentence is that it paid out trivially — the
moves are ≤0.05, inside block-to-block spread, so the positional effect the amendment feared is
empirically a few percent and the prediction was too weak to adjudicate anything.

---

## FINDINGS

### F1 — SUBSTANTIVE — ρ_D(T9) = 0.8486 refutes the residency reading of ρ_B; Claim 1's "page-cache mechanism signature" must be weakened, and A8's caveat applies symmetrically to arm B

**Attacks Claims 1 and 3.** Category (c): the numbers permit — in fact demand — an alternative
explanation.

The raw T9 write times: A = 532,487 / 507,071 / 528,201 ms; B = 269,149 / 264,638 / 271,058 ms;
D = 442,570 / 453,925 / 448,246 ms (`e1-ab-runs.jsonl`). **The control — the middle cache size — is
the slowest arm at T9.** A monotone hit-rate story predicts cost non-increasing in cache size; a 2 MiB
cache holding 0.47% of the file cannot have a lower miss volume than a 15.63 MiB cache holding 3.73%
(the registration's own model, A4, IMPLEMENTATION_PLAN.md:4615-4618, which predicted
ρ_D(T9) ≈ 1.03 — measured 0.849, a ~18-point miss of the design's own in-sample model). So the T9
response to cache size is U-shaped, and "cache residency" cannot be the whole channel behind
ρ_B(T9) = 0.513.

The registered instrument already contains the vocabulary for this and applied it asymmetrically.
AMENDMENT 1 A8 (:4687-4694) verified that the spill threshold tracks the cache size
(`sqlite3.c:57599`, `p->szSpill = mxPage`, confirmed at `:57592-57604` this review) and constrained
*arm D's* narration: a D penalty "mixes read-miss cost with spill mechanics". The same fact cuts the
other way for **arm B**: at `cache_size = -1048576` mid-transaction spill is structurally impossible
(no per-file transaction dirties 262,144 pages), while arms A and D both spill under pressure. ρ_B
therefore conflates (i) read-miss elimination with (ii) elimination of dirty-page spill/eviction —
two different pager mechanisms that the design cannot separate. A8's registered language ("both are
cache-size mechanisms, so the arm's role survives; only the narration is constrained") is exactly
correct and must be applied to B in the RESULT, not just to D.

Candidate mechanisms for ρ_D(T9) < 1, evaluated:

- **"Smaller SQLite cache frees RAM for the OS cache": quantitatively dead.** The A−D cache delta is
  ≤ 13.6 MiB (15.63 vs 2 MiB) on a 16 GiB machine against a 418.8 MiB database. A 13.6 MiB shift in
  OS-cache headroom cannot produce a 15% wall-time change at T9.
- **"16 GiB machine under memory pressure at T9": dead in both directions.** It cannot apply to D vs
  A (D uses *less* memory), and it is contradicted for B by B being the fastest arm.
- **Spill/commit dynamics (early small spills vs late large evictions under a full mid-size cache):
  consistent with the U-shape, but SPECULATION.** The run records contain no WAL frame counts, no
  spill counters, no checkpoint counts (`wal_boundary` is an end-state reading that is structurally
  zero in this topology — `eval/e1-common.mjs:398-417`), and no RSS. **The data cannot discriminate.
  Say so plainly in the RESULT**, and note the registered next step for mechanism work is already
  named at :4408-4410 (statement-level / `sqlite3_stmt_scanstatus` profiling).

**What should change:** Claim 1's wording. The dose–response in ρ_B (0.977 → 0.687 → 0.513 across
1.32× / 5.81× / 26.8×) is real, monotone, and cross-block stable (T9 spread 0.016), and it is licensed
as evidence that a *cache-size-coupled* mechanism turns on as the database outgrows the cache. It is
**not** licensed as "the signature of a page-cache [residency] mechanism", because the same
experiment's positive control proves cache-size effects at T9 are not a hit-rate monotone. Claim 3
should be upgraded from "anomaly, licenses no conclusion" to "anomaly that actively bounds the
interpretation of ρ_B" — it is doing real work against Claim 1, and reporting it as inert
under-reports it.

### F2 — SUBSTANTIVE — ρ_C(T5) = 0.6921 is reconcilable with the registered source reading, and the reconciliation re-points the mechanism: FTS5 segment reads are read-cursor traffic, mmap-eligible inside a write transaction

**Attacks Claim 1's mechanism narration; resolves the tripwire constructively.** Category (c).

The A1 source reading is **verified correct as stated** (this review, against the vendored
amalgamation): `bMmapOk` requires `eState==PAGER_READER || (flags & PAGER_GET_READONLY)`
(`sqlite3.c:65261-65263`), write cursors get `curPagerFlags = 0` (`:77886`), and WAL-resident pages
are excluded (`:65286`). But the reading covers only *write-cursor* fetches. The clause the
registration did not carry forward: **read-only cursors get `PAGER_GET_READONLY`
(`sqlite3.c:77889`), which satisfies `bMmapOk` regardless of `eState`** — i.e. read-cursor page
fetches are served from the memory map *even inside an open write transaction*, provided the page is
not currently in the WAL.

And the write phase contains a large class of exactly that traffic: **FTS5 reads its segment data
through read-only blob handles** — `fts5DataRead` → `sqlite3_blob_open(db, zDb, zDataTbl, "block",
iRowid, 0, …)` with flags = 0 (`sqlite3.c:251446`, `:251471`). Trigram segment reads during FTS5's
incremental merges are read cursors, hence mmap-eligible mid-write-transaction. Old segment pages —
written many transactions ago and long since checkpointed — are precisely the pages *not* in the WAL.

This makes three observations cohere without contradicting the A1 analysis:

1. ρ_C(T5) = 0.6921 despite mmap being unable to serve B-tree *insertion* traversals: the speedup is
   on read-cursor traffic the A1 analysis did not model.
2. **ρ_C(T5) ≈ ρ_B(T5) (0.6921 vs 0.6871).** Two levers with disjoint mechanisms (a big user-space
   cache; a memory map at the *default* cache) produce the same ~31% at T5. The parsimonious reading:
   both are removing the same cost — page fetches of checkpointed segment/index data — B by holding
   the pages, C by making the fetch a page-mapped read instead of a `pread` + copy.
3. It names a concrete miss source that is *not* the hypothesised "11 indices' B-tree insertion
   traversals" (:4511-4513): FTS5 trigram merge reads — one of the four mechanism candidates E1-PHASE
   registered as indistinguishable (:4185-4187).

**What should change:** the RESULT should report the tripwire as FIRED (as registered, "a finding in
its own right… triggers a dedicated probe", :4527-4528) *and* record this reconciliation: the
registered source basis (`e1-ab-score.mjs:301-302`) is not wrong, it is incomplete — its scope was
write-cursor fetches, and the contradiction dissolves once read-cursor traffic (FTS5 blob reads;
any intra-write-phase SELECTs) is in the model. The "dedicated probe" has an obvious first target.
This finding is constructive for the program and it would be a waste to report ρ_C only as "source
reading contradicted".

### F3 — SUBSTANTIVE — EXPONENT_REDUCED fired with a 0.02 margin on a bar advertised as "~20σ blunt"; the 1.35 comparison survives the category-error check, but only because the cross-checks close it — publish them

**Attacks Claim 2's reporting; confirms its substance.** Categories (b) and (c).

The registered classification (`e1-ab-score.mjs:186-190`; registered at :4571-4575) is
`b̂_write(B) ≤ b̂_write(A) − 0.20` for EXPONENT_REDUCED. Realized: 1.7127 vs 1.9331 − 0.20 = 1.7331 —
**margin 0.0204**. Per-block paired differences (recomputed): 0.2204 / 0.2012 / 0.2334 — block 2
clears the bar by 0.0012. A2's rationale called the 0.20 bar "~20σ" and "deliberately blunt"
(:4581-4586); the realized effect sits *on* the bar, so the blunt-bar argument does not apply to this
outcome and the RESULT may not describe the classification as robust. Had block 2 been the median,
the verdict text would be identical; had the effect been 0.02 smaller, the classification flips to
EXPONENT_UNTOUCHED with no change in any narrative sentence about mechanism. State the margin.

On the priority question — **is comparing b_write(B) to E1's 1.35 a category error?** The concern is
real: E1's 1.35 governed a 9-rung HC3-fitted slope of calibration-adjusted *total duration*
(`e1-verdict.json`: b = 1.7529, CI [1.6599, 1.8458]); E1-AB's statistic is a 3-point within-block OLS
of *write-only* time in which T5 carries 0.09% leverage — effectively a T1↔T9 chord — with no CI by
registered design (`e1-ab-score.mjs:8-12`). Write-only slopes run systematically *above*
total-duration slopes (parse is linear and dilutes), so judging b_write against a duration-calibrated
threshold makes "still super-linear" easier to claim — a bias running toward the published Claim 2.
Two recomputed cross-checks close it:

- **Estimator mismatch is ~0.04, not ~0.4.** Control A's within-block 3-point write slope is 1.9331
  against E1-PHASE's 5-rung pooled fit 1.9685 (`e1-phase-verdict.json`) — Δ ≈ 0.035, on a different
  binary and day. And A's *duration-basis* 3-point slope recomputes to **1.7623** against E1's
  9-rung adjusted fit **1.7529** — agreement to 0.01. The chord tracks the ladder estimand.
- **The conclusion is threshold-robust on E1's own basis.** B's duration-basis slope recomputes to
  **1.5497** — still 0.20 above 1.35 on the estimand closest to the one 1.35 was registered for (and
  the omitted calibration subtraction can only raise it). D's is 1.6826.

So "b_write(B) = 1.7127, far above 1.35" is defensible — the honest uncertainty is block spread
0.0224 plus a ~0.04 estimator systematic, an order of magnitude below the 0.36 distance — **provided
the RESULT publishes the duration-basis cross-check** rather than asking the reader to take the
category jump on faith. Two supporting numbers deserve the page: **b_hi(B) = 1.8965** — with eviction
physically impossible, the upper half of the ladder is still near-quadratic, the single strongest
number for "the exponent's source is upstream of the cache" — and the A3 corroborating reading
(`b_hi(B) < b_hi(A) − 0.20`) fires by only 0.023 at the medians and fails outright in block 2
(1.8965 vs 2.0574 − 0.20 = 1.8574), so it corroborates only weakly and should be reported as such.

### F4 — SUBSTANTIVE (published wording would be false) — the AMENDMENT 3 prediction was directionally satisfied, not falsified; Claim 4 must be rewritten

**Attacks Claim 4.** Category (c) — and, if published as drafted, a misstatement of the record.

AMENDMENT 3 registered: "The corrected design should therefore be expected to produce ρ_B and ρ_C
**closer to 1.0**, not further from it. That prediction is registered here so the re-run can falsify
it" (:4832-4836). Recomputed from the quarantined journal
(`eval/results/discarded-amendment3/e1-ab-runs.jsonl`) against the scored verdict:

| statistic | discarded (block 1, old order) | scored (median of 3) | move |
|---|---|---|---|
| ρ_C(T5) | 16479/24523 = **0.6720** | 0.6921 | +0.020, toward 1.0 ✓ |
| ρ_B(T5) | 16454/24523 = **0.6710** | 0.6871 | +0.016, toward 1.0 ✓ |
| ρ_B(T1) | 1582/1705 = **0.9279** | 0.9774 | +0.049, toward 1.0 ✓ |

Every comparable statistic moved in the predicted direction. "The prediction did not pay out" and
"falsified" are both wrong. What is *true*: the moves are ≤0.05, all inside the corrected design's
own block-to-block spread (B/T5 spread 0.066, C spread 0.031), and the comparison is n=1 block
against a median of three — so the prediction, being directional with a coin-flip base rate and no
registered magnitude, was **too weak to be confirmed or falsified**. The defensible published
sentence: the prediction was directionally consistent and quantitatively empty; the warm-up effect
AMENDMENT 3 feared is empirically a few percent at most (see F6 for the direct evidence), and the
amendment's justification therefore rests — as its own text says (:4839-4844) — on readability
(collinearity), not on the effect's reality.

### F5 — MINOR — AMENDMENT 3's prior-exposure declaration undercounts: a full diagnostic A/T9 run was observed before the restart and is disclosed only in the quarantine README

**Attacks the amendment-hygiene record, not any statistic.** Category (a), narrowly.

AMENDMENT 3 states "Seven runs existed when this was written — all of block 1's T1 and T5 cells"
(:4779-4780). The quarantine README records more: the old schedule died at A/T9/b1 in a lock race,
and "a re-run of the same cell completed normally in **540,136 ms**"
(`eval/results/discarded-amendment3/README.md:40-45`) — a complete control-arm T9 timing on the
current binary, observed before the restart, on top of the failed race run. The registration's own P0
standard (:4440-4455) is that prior exposure is declared *in the registration text*, not findable in
a side directory. No threshold could plausibly have been tuned by it — every decision statistic is a
within-block ratio and the figure is a control absolute — but the program's standard is disclosure,
and the RESULT should carry the corrected count.

Two related observations, recorded for calibration rather than as violations: (i) the positional flaw
AMENDMENT 3 fixed was **knowable pre-run** — the seed-4409 schedule was deterministic and committed
at AMENDMENT 1; it was inspected only after seven runs existed, and those runs already showed arm C
fast (the amendment's own block-1 T5 figures, :4839-4841, are C and B at positions 2–3). Had C looked
inert in block 1, it is doubtful the collinearity would have forced a restart. The discard is what
makes this legitimate, and the discard is **complete and honest**: quarantined runs span
18:07–18:09Z, the scored journal begins 19:27:41Z, no quarantined record appears in the scored
journal, and both schedule pins carry the same Gate 0 hash (`73f4d1e6…`,
`e1-ab-schedule.json` / `discarded-amendment3/e1-ab-schedule.json`), so no binary change hid in the
restart. (ii) The restart was *also* forced mechanically by the lock race — the amendment's framing
as a purely design-motivated discard omits that a resume decision was needed regardless.

### F6 — MINOR — the T5 square gives arm C the latest position in every block (positions 4, 3, 2); the tripwire arm keeps a residual positional confound — empirically bounded small, but the RESULT must not call T5 "balanced"

**Attacks Claim 1's supporting arm and the AMENDMENT 3 narrative.** Category (b).

The realized T5 orders (timestamps in the scored journal; generator
`eval/e1-ab-schedule.mjs:133-136,155-170` with arms canonically A, B, D, C): b1 = A B D C,
b2 = B D C A, b3 = D C A B. Position sums: D = 6, B = 7, A = 8, **C = 9** — C drew the maximum of the
forced multiset {6,7,8,9} (:4818-4824) and never runs first. The arm whose non-inert reading is the
registered tripwire got the warmest slots in all three blocks. AMENDMENT 3's claim that the residual
imbalance "is not concentrated on one arm" (:4824) is wrong for the arm that mattered.

It does not overturn ρ_C, because the scored data bounds the position effect directly: **B ran first
at T5 in block 2 and was still fast** (15,676 ms vs the control's 23,634 ms at position 4 of the same
block), C's three times are stable across positions 4/3/2 (15,542 / 15,901 / 15,785), and the
control's position-1 runs at T5 and T1 were among its *fastest* (A/T5/b1 pos 1 = 22,455 vs 23,634 at
pos 4) — the opposite sign to warm-up. Position effects at T5 are ≲3% against a 31% arm effect. Report
ρ_C with that bound attached instead of describing the T5 ordering as balanced.

### F7 — MINOR — the machine-readable verdict says "no findings" while the two facts most needing findings sit unflagged: ρ_D(T9) ≤ 0.90 carries no registered flag after A4's demotion, and D/T1's spread finding is in the JSON but printed nowhere

**Attacks gate/reporting adequacy.** Category (b): rules followed, rules inadequate.

`e1-ab-verdict.json` has `mechanism.findings: []` and `driver_findings: []`. Yet:

- **ρ_D(T9) = 0.8486 ≤ 0.90.** A5 registered "ρ_D ≤ 0.90 (shrinking the cache HELPS)… reported
  anomaly" with no rung qualifier (:4639-4640); A4 demoted ρ_D(T9) to "a working-set probe…
  reported without a threshold" (:4623-4624). The scorer resolved the collision by keying
  `D_HELPS_ANOMALY` to T1 only (`e1-ab-score.mjs:224`, `classifyMechanism` takes only `rhoD_T1`) —
  a defensible reading of A4, but the net effect is that the most anomalous number in the experiment
  reaches the verdict record with no flag anywhere. The registered guard ("the CACHE-INERT cell may
  not be claimed while it holds") is moot here since the cell is CACHE_IMPLICATED. The RESULT must
  carry the anomaly manually (the stated intent does this — F1 argues it must do more).
- **D/T1 `spread_finding: true`** (ratios 1.5664 / 1.1543 / 1.2123, spread 0.412 > 0.15) is present
  in the verdict JSON but the reporter prints only `mechanism.findings`
  (`e1-ab-report.mjs:218`), so the console record reads clean. A4 keys the connectivity verdict on
  exactly this cell. The verdict is nevertheless robust to the outlier: the median (1.2123) does not
  depend on block 1, and the *minimum* block ratio (1.1543) independently clears the 1.10 bar.
- A drafting incoherence to record: A5's INTERFERENCE hole reads "ρ_X > 1.10 **on any arm**"
  (:4636-4638), under which ρ_D(T1) = 1.2123 is simultaneously "lever connected" (A4) and
  "INTERFERENCE" (A5). The scorer applies INTERFERENCE to arm B only
  (`e1-ab-score.mjs:126-131,228-231`), which is the only coherent reading — but it is a post-hoc
  resolution of registered text and should be recorded as such in the RESULT.

### F8 — MINOR — both Gate 3 retakes retained the warmer passing attempt, and both retention choices ran toward connectivity firing; no outcome flips, but the registered bias statement must quantify it

**Attacks Gate 3 integrity / Claim 1's connectivity leg.** Category (b).

Two cells retook under Gate 3 (delta 544 ms > 500 ms allowance, both at T1): D/T1/b2 and A/T1/b3
(`gate3_attempts` in the journal). `selectFitted` retains the *passing* attempt when a retake passes
(`eval/e1-schedule.mjs:187-191`); "first-attempt retention" applies only when all attempts fail — as
registered. But the retake is by construction warmer, and the realized substitutions both moved in
the hypothesis-friendly direction:

- D/T1/b2: attempt 1 write 1805 ms → ratio 1805/1672 = **1.0795, below the 1.10 connectivity bar**;
  retained attempt 2 write 1930 ms → 1.1543, above it.
- A/T1/b3: attempt 1 write 1530 ms → retained attempt 2 write 1479 ms, deflating the block-3 control
  and inflating both B/T1/b3 (1.0318, B's maximum) and D/T1/b3 (1.2123, the scored median).

Recomputed under first-attempt substitution in both cells: ρ_D(T1) blocks become
{1.5664, 1.0795, 1.1719}, median **1.1719** — connectivity still fires; ρ_B(T1) median is unchanged.
So the verdict is retention-robust and this is a reporting obligation, not a defect: Gate 3's
registered reconciliation clause (:4375-4378) requires "the direction of any retained bias" to be
stated in the RESULT, and the direction here is toward CACHE_IMPLICATED via its connectivity leg.

---

## WHAT I COULD NOT CHECK

- **Whether SQLite's pager honoured the pragmas internally.** Gate A's registered limit
  (:4370-4374). Behaviourally moot here — arms moved the clock, in both directions — but the echo
  remains configuration evidence, not pager-state evidence.
- **The mechanism behind ρ_D(T9) < 1 and, symmetrically, how much of ρ_B is spill-policy rather than
  read-miss elimination.** The records carry no WAL frame counts, spill counts, checkpoint counts, or
  RSS (`wal_boundary` is end-state and structurally zero in this topology,
  `eval/e1-common.mjs:398-417`). The U-shape interpretation in F1 beyond the quantitative kills is
  SPECULATION and labelled so.
- **Machine idleness across the 73-minute scored window.** No load telemetry exists. Indirect
  evidence is consistent with quiet (A/T9 block spread 5.0%, ratio spreads at T9 ≤ 0.064), but this
  is absence of evidence of interference, not evidence of absence.
- **The tier cut's file-selection order.** I verified T1 ⊂ T5 ⊂ T9 exactly (recomputed from
  `eval/results/e1-tiers.json`: 656 ⊂ 2,880 ⊂ 13,330 files) and that per-rung density is homogeneous
  (5,863 / 5,760 / 5,987 db-bytes per chunk), which defuses the gross composition confound on the
  dose–response; I did not re-derive the manifest's selection ordering from its seed.
- **The identity of the second lock holder in the pre-restart T9 lock race.** The README closes the
  search "by decision" (`discarded-amendment3/README.md:44-45`); the pid follow-up is not done. It
  touched no scored run.

## WHAT SURVIVED

Attacked and left standing:

- **Gate A, on all 30 runs, from the raw journal.** Every run record's `pragmas` field matches its
  arm's registered pair exactly (A `{-16000,0}`, B `{-1048576,0}`, D `{-2048,0}`, C
  `{-16000,1073741824}`); `gate_a.ok` true on all 30; the gate runs *before* Gate 3's retake logic so
  a wrong-arm run cannot be retaken into the record (`eval/e1-ab-run.mjs:148-158`). No silent flag
  failure exists in this data.
- **Gate P2, and the pre-write-counter trap.** The trap (`eval/e1-common.mjs:486-492`) is not merely
  documented — it is avoided: the run record's `chunk_count` comes from `readGraphCounts`'s
  `SELECT COUNT(*)` against the landed `graph.db` (`:493-503`, plain read-only open, not
  immutable-mode), spread into the record after the stdout meta. P2's identical counts (3,679 /
  16,529 / 73,359) are ground truth, `write_errors = 0` is asserted per run
  (`eval/e1-ab-run.mjs:141-145`), and `db_bytes` is byte-identical across every run at each rung
  (21,569,536 / 95,203,328 / 439,140,352) — the arms demonstrably did identical work.
- **The scorer's arithmetic, wholesale.** Every ratio, median, spread, slope, split-half and
  classification in `e1-ab-verdict.json` reproduced independently from the jsonl to 4 decimals,
  including the marginal ones.
- **The discard's completeness.** Timestamps partition cleanly (quarantine 18:07–18:09Z, scored
  journal 19:27–20:45Z), the retired schedule pin retains the dead seed, and Gate 0's hash is
  identical across the restart. The discard is what AMENDMENT 3 claims it is.
- **ρ_C as a real effect rather than a positional artifact.** The strongest available counter — C
  never runs first (F6) — is bounded by the scored data itself: arm B ran first at T5/b2 and kept its
  full effect; the control's position-1 runs were its fastest. The tripwire fired on the arm, not on
  the schedule.
- **Claim 2's substance, attacked three ways.** As a category error (closed by the duration-basis
  cross-check: B = 1.5497 > 1.35 on E1's own estimand); as spurious precision (block spread 0.0224,
  paired per-block A−B differences 0.2204/0.2012/0.2334 all positive, estimator systematic ~0.04
  from two independent cross-checks); and via the curvature reading (b_hi(B) = 1.8965 —
  eviction-free write is still near-quadratic in its upper half). "The cache does not explain the
  super-linearity" is the best-supported sentence in the draft, subject only to F3's margin
  disclosure on EXPONENT_REDUCED.
- **Drift cancellation.** Control write times move ≤5% across blocks at every rung
  (T9: 532.5/507.1/528.2 s) while arm effects are 15–49%; the within-block ratio spreads at T9
  (0.016 for B) show the estimator did what it was registered to do.
