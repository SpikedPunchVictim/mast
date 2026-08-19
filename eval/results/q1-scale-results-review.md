# ADVERSARIAL RESULTS REVIEW — Q1/SCALE scored result (verdict row 1, SCALE_CAVEAT_CONFIRMED)
(Fable, 2026-08-02, post-scoring. Artifacts audited at 8868404/a313926. All headline numbers
independently recomputed from eval/results/scale-measure-raw.json with review-authored code,
then cross-checked against the committed scorer; every recomputation matched exactly.)

## RANKED FINDINGS

### F-R1 (HIGH — required caveat, direction: toward false CONFIRMED). The AMENDMENT-1 hit rule (F4 counterpart credit) is load-bearing for CONFIRMED-vs-AMBIGUOUS.
Under the pre-amendment hit rule (target's own declaration chunk only), the decision-bearing
test is not significant and the registered table outputs AMBIGUOUS. Recomputed, all three
variants through the committed wilcoxonSignedRankExact + bcaBootstrap(seed 1001) +
evaluateVerdict:
| variant | pos/neg | p | BCa CI | registered-table output |
|---|---|---|---|---|
| registered (post-dedup + counterpart) | 13/3 | 0.02127 | [+0.0133, +0.1133] | row 1 CONFIRMED |
| exact-target-only (pre-amendment) | 13/5 | 0.09625 | [-0.0067, +0.1067] | row 4 AMBIGUOUS |
| pre-dedup rank (chunk-id, dedup-free) | 15/5 | 0.04139 | [+0.0067, +0.1200] | row 1 CONFIRMED |
Mitigating facts verified: the dedup-free pre-dedup sensitivity confirms (p=0.041, same
θ̂ +6.7pp); the three positives the amendment adds (s_ident_95/103/104 — ScanCodeChord,
KeyCodeChord, ModelPickerWidget) are corroborated by pre-dedup chunk-id ranks (L degrades
T1→T4 8→53, 17→138, 14→85 vs H 4→21, 5→27, 1→6); exact-only introduces spurious flips
(s_ident_31/_69 score H "degraded" when H's T4 result is the counterpart at rank 1-2 naming
the target). No variant discharges: CI upper bound 0.107-0.120 > 0.10 in all three.
Required caveat: "CONFIRMED is hit-rule-sensitive; p = 0.021 / 0.096 / 0.041 under
amended / pre-amendment / pre-dedup rules."

### F-R2 (MEDIUM — required limitation). Effect size below the registration's own materiality bound; row 1 has no magnitude gate.
θ̂ = +6.7pp, all-n BCa CI [+1.3pp, +11.3pp] (seed-stable, lo>0 in 200/200 alternative
seeds). The registration defines 10pp as the materiality line; the point estimate is below
it and the CI reaches +1.3pp. Row 1 fires on significance alone. RESULT must report:
"statistically confirmed direction, magnitude 6.7pp [1.3, 11.3] — below the registered
10pp materiality bound at point estimate", not outcome-relevance.

### F-R3 (MEDIUM — registration-design comment, not grounds to overturn). Consistency triggers guard only the DISCHARGE branch.
Confirmed reading (lines 2679-2688): no supporting result could ever demote CONFIRMED.
On the data: S-approx Δ exactly zero (9+/9-, CI [-0.06,+0.053]); S-prose directionally
consistent but ns (12+/5-, θ̂=+7pp, CI [-0.02,+0.14]); Δlog2 CI [-0.015,+0.285] includes 0.
An even-handed registration would plausibly have output AMBIGUOUS. Structural pro-CONFIRMED
asymmetry — mirror image of the pro-DISCHARGE asymmetries AMENDMENT 1 fixed. The rule is
the rule; row 1 stands; symmetric triggers required in any future registration.

### F-R4 (MEDIUM — gate-evidence gaps, mostly toward false DISCHARGED, closed by this review).
(1) Gate 0(c)/(d) never run on T4; (2) Gate 4 ran ~2.5 min AFTER scoring (04:22:34Z vs
04:20:05Z) — registration requires before; (3) T4 shows write_errors: 2 (whales not
excluded — pre-registration full index reused). All closed independently: direct Lance
count on vscode-state-full = 138,440 vectors, 138,440 distinct chunk_ids, 0 duplicates,
0 out-of-tier by full anti-join; T1-T3 counts match the frozen manifest. No residual
material risk; log the ordering deviation.

### F-R5 (LOW — statistical characterization, no error). The "exact Wilcoxon" is exactly a sign test here; verdict rides on 13-vs-3 of 16.
All 16 non-zero Δ have |Δ|=1, ranks tie at 8.5, W = 3×8.5 = 25.5, exact p = two-sided
binomial = 1394/65536 = 0.021270751953125 — matches to all digits. Two of the 13 positives
(s_ident_95/103, ScanCodeChord/KeyCodeChord, same file src/vs/base/common/keybindings.ts,
identical rare-word suffix) are near-twins, not fully independent; collapsing them still
gives p = 0.0352 (12+/3- of 15). The 13 positives are otherwise dispersed (9 distinct
top-level directories; 7 plain functions with exact hits in all 8 cells).

## SOUND (checked, found solid)
Independent recompute of all 24 cells, counts, W/p, BCa CIs (seeds 1001/1002, insensitive
across alternatives), HL [0,0] degenerate as pre-predicted; mode/arm integrity 1600/1600
per arm in RAW, 0 duplicate keys, same tier objects per query-pair; driver fidelity
(limit=200, rrf_k=60, explicit chunkStore, correct embedder per arm; drivers ARE committed
at 8868404; instrument byte-identical a313926→8868404; seed 1001 pre-committed); query_id
deterministic and joins cleanly; s_approx↔s_ident pairing 0 mismatches; Gate 2 80/80 under
the widened criterion (undercount disclosed, widening runs anti-false-pass); manually-copied
gate file byte-identical to original; ceiling proximity QUANTIFIED and runs the OTHER way
(base-rate asymmetry ≈ -0.3pp toward DISCHARGE; L's out-of-window-at-T1 queries all worsened
further, invisible to D_loss_L — measured Δ is conservative; rank co-metric agrees: mean
log2 shift H +0.584, L +0.717); S-approx inversion is NOT a pipeline artifact — S-approx
degrades both arms equally (-17 each), vs S-ident H -9 / L -19: hybrid's scale-protection
exists only when the exact identifier is in the query. Coherent innocent mechanism verified
in code: hybridSearch's lexical path uses only trigram chunk_fts; identifier_fts exists but
is NOT consulted by hybridSearch, so exact names have no exact-token lexical anchor and
their trigram profile dilutes with scale, while the vector arm anchors on the name in the
declaration (paired-row inspection confirms, e.g. s_ident_73 S-approx H 2→64; _103 H 3→20).
F6's masking hypothesis empirically falsified, not subverted. Registered-rule application
correct (row 1 fires; T4-ceiling no-trigger correct at 140/126 < 143; monotone by
inspection; underpowered rule correctly not triggered at 16 ≥ 10; discharge was genuinely
reachable — at realized p_nz=0.107 a null CI would be ≈ ±5.2pp ≤ 10pp — the data refused
it). Tier manifest seed 153, realized counts match, arms see identical tiers.

## WITHDRAWN
Suppression-differential bias (flat across tiers — H 12,14,13,12; L 20,20,21,21 — cannot
fabricate a T1→T4 change; pre-dedup sensitivity bypasses dedup and confirms); BCa seed
cherry-pick (pre-committed, 200/200 seeds agree, row 1 doesn't key on the CI); monotonicity
CI improvisation (no approximation could change zero flags; informational-only);
Δlog2-aggregate tuning (sign convention matches F1, seed-insensitive, can only run toward
AMBIGUOUS, honestly reported ns); whale-file absence (pre-registered F11 limit,
arm-symmetric, absence runs toward false DISCHARGED); stale_files/index_fresh:false (mtime
artifact, arm-symmetric; counts + Gate 2 are the operative integrity evidence).

## VERDICT ON THE VERDICT
Row 1 survives — yes, with required caveats: (1) hit-rule sensitivity (p = 0.021/0.096/
0.041; F4 amendment load-bearing for CONFIRMED-vs-AMBIGUOUS, added pairs corroborated by
pre-dedup ranks); (2) magnitude +6.7pp [+1.3, +11.3] below the 10pp materiality line at
point estimate — "confirmed" means direction, not outcome-relevance; (3) consistency
triggers guard only discharge — supporting strata do not corroborate; a symmetric
registration would plausibly have read AMBIGUOUS; (4) T4 gate-evidence gaps closed post-hoc
(138,440 vectors, 0 out-of-tier, 0 dupes) and the gate-4-after-scoring ordering deviation
logged. Practically, CONFIRMED and its worst-case alternative (AMBIGUOUS) route to the same
next action — Q1 stays open, the delete arm stays blocked, a pro-vector resolution still
requires the outcome test at scale — so no incumbent-favouring shortcut is smuggled in;
the caveats prevent the write-up claiming more than a marginal, identifier-stratum-specific,
sub-materiality retrieval effect.
