# Q1/SCALE adversarial design review (Fable, 2026-08-02, pre-run) — verbatim

Reviewed: IMPLEMENTATION_PLAN.md 2469-2712 at commit 80cb9bd, before any measurement.
Commissioned per the standing §6 rule. Verified against hybrid.ts, fts.ts, vector.ts,
ab-rank-check.mjs, build-normal-set-r2.mjs, vscode-tsdoc-density.mjs, vscode-embed-sample.mjs.

## Finding 1 (SEVERE) — sign contradiction in the registered contrast
D = metric(T4) − metric(T1) (line 2612) makes degradation NEGATIVE, but the falsification
bullet (2650) registers "D_L − D_H positive" as the pro-vector outcome — under the written
formula that is HYBRID degrading more. The discharge row's "CI upper bound on extra lexical
loss" can be applied to the wrong tail. Direction: toward false DISCHARGED or a
CONFIRMED/a-fortiori swap. Fix: one convention D_loss = metric(T1) − metric(T4) (positive =
degradation); restate all rows; known-answer scorer test where synthetic lexical degradation
must fire CONFIRMED.

## Finding 2 (SEVERE) — discharge corridor + underpowered-rule collision
Under a TRUE ZERO effect, 95% CI half-width on the paired proportion difference is
1.96·sqrt(p_nz/75): ±7.2pp at p_nz=0.10, ±10.0pp at p_nz=0.195, ±12.4pp at 0.30, ±14.3pp at
0.40. So the ≤10pp discharge bound fires under a true null only if p_nz ≤ ~0.195; the
<10-non-zero "underpowered" rule (p̂_nz < 0.133) collides, leaving DISCHARGED reachable only
in a ~[10,14]-of-75 non-zero corridor — and the maximally informative null (all 75 zeros)
routes to "underpowered". CONFIRMED-branch power at n=75: ~0.46 (10pp concentrated), ~0.26
(10pp diffuse), ~0.08 (5pp). n_min for the bound under true zero: 77 (p_nz=0.2), 116 (0.3),
154 (0.4), 193 (0.5). Direction: structurally toward perpetual AMBIGUOUS (pro-incumbent);
collision resolution unknowable. Fix: key discharge on the BCa CI over ALL n (zeros are
data); underpowered rule applies to the Wilcoxon report only; raise n to 150-200.

## Finding 3 (SEVERE) — Gate 5 anti-ceiling logic inverted
T1 ceiling is the IDEAL start for measuring degradation (everything visible); the dead case
is T4 ceiling in both arms — which is discharge evidence, not failure. As written the gate
fires on the most probable data pattern (S-ident exact-name queries near ceiling at T1),
demotes to Δlog2(rank), which has NO registered decision rule — verdict machinery undefined
on the modal path. Direction: unknowable, resolved post-hoc by the prior. Fix: delete the
T1 trigger; register T4-ceiling-both-arms as trivial discharge with the all-n CI.

## Finding 4 (HIGH) — shipped dedup can suppress the target chunk itself
dedupShellMethodCollisions (hybrid.ts:139, 201-253) drops a method when its shell is kept
(228-236) and vice versa (214-221); a suppressed target is absent at ANY depth → censored at
201, though production surfaces the survivor with a hint naming the target. Suppression
depends on relative shell/method ranking → differs by arm and tier → spurious D≠0 and
censoring differentials in the decision-bearing contrast. Exposure: methods are 74,685 of
138,440 chunks. ab-rank-check.mjs:50-54 dodged this via line-containment + file fallback;
the SCALE metric has neither. Direction: unknowable, noise concentrated at the largest
tiers. Fix: score pre-dedup rank, or count shell/method counterpart as a hit at the
survivor's rank; log suppression per arm × tier.

## Finding 5 (HIGH) — HL near-meaningless on this support; which-CI governs discharge is unregistered
Z ∈ {−2..2} mass at 0 → HL estimate ≈ 0 with grid-valued, often degenerate CI ([0,0]); the
discharge row does not name which CI (HL vs BCa) must clear ≤10pp — the degenerate-HL
reading is a loophole into DISCHARGED. Wilcoxon normal-approx with massive ties misbehaves
at m≈10-30. Direction: toward false DISCHARGED. Fix: discharge bound = BCa bootstrap CI on
the all-n proportion difference; HL descriptive or dropped; Wilcoxon exact, unit tests incl.
all-ties and m=12 exact-tail cases.

## Finding 6 (MEDIUM-HIGH) — lexical hotness masks slope; exact-name queries are lookups
A query containing the target's exact symbol name is a near-unique trigram key largely
insensitive to distractor mass; degradation concentrates in shared-term queries. The hot
stratum plausibly has a FLATTER dose-response than realistic queries → a null under-tests
the caveat. Whether the 147 logged agent identifiers were exact target names: UNVERIFIED.
Direction: toward false DISCHARGED. Fix: add a stratum with the exact name removed
(camelCase-split words), or amend the discharge language to "exact-identifier retrieval
only".

## Finding 7 (MEDIUM-HIGH) — "rare" undefined; wrong-tier rarity anti-selects the effect
Rarity computed against T4 selects terms guaranteed still-discriminative at 138k — excluding
exactly the rare-at-15k/common-at-138k terms through which the mechanism would show; T1
statistics are the representative choice. No statistic/threshold/tie-break registered; a
committed generator can embody the discharging choice without any amendment logged.
Direction: toward false DISCHARGED if rare-by-T4. Fix: DF over T1's index only, numeric
threshold, deterministic tie-break, stopword handling stated.

## Finding 8 (MEDIUM) — no tier-integrity gate despite the design's own headline being an index-integrity trap
Nothing asserts per-tier chunk count == frozen manifest, write_errors == 0 per tier build,
or vector scoping (a T1 lance dir holding T4's vectors passes Gate 4; out-of-tier vector
hits die at chunkStore.getChunksByIds (hybrid.ts:123), silently eating H-only candidate
slots — an asymmetric arm distortion). Direction: missing chunks → false DISCHARGED;
vector leakage → false CONFIRMED; both severity-zero class. Fix: Gate 0 per tier: chunk
count == manifest; write_errors == 0; lance count == tier chunk count; anti-join zero
out-of-tier vectors.

## Finding 9 (MEDIUM) — Gate 2 self-check underspecified on depth and arm
No limit or arm stated; measurement runs at limit=200 (pool 800; searchFts over-fetches
limit*2). A wrapper diverging only beyond rank 10, at the pool boundary, or only in H's
embedder wiring passes a limit-10/L-only probe. Fix: 10 probes × 4 tiers × 2 arms at
limit=200, full ordered-list comparison, H probes assert mode:"hybrid".

## Finding 10 (MEDIUM) — verdict overreach; "material inconsistency" is a post-hoc lever
The experiment shows the TARGET's rank holds; the 14.5k picture also includes
outcome-insensitivity and window-composition irrelevance — at 138k the other nine slots fill
with scale-specific distractors, unmeasured, and outcome transfer is across scale AND corpus.
"Material inconsistency" and the monotonicity check have no registered thresholds.
Direction: toward false DISCHARGED. Fix: "discharged at target-rank retrieval level;
residual channels accepted by decision, not evidence"; register inconsistency triggers now.

## Finding 11 (LOW-MEDIUM) — absent fixture files are the distribution's truncated tail
The 14,529 absent chunks are deterministically the two most extreme, most repetitive files —
plausibly the most BM25-stressing distractor mass; 9.5% of the 153k pricing basis. Not in
the external-validity limits. Direction: weakly toward false DISCHARGED. Fix: one limits
bullet.

## Finding 12 (LOW) — "verbatim" impossible; S-prose is identifier-led too
build-normal-set-r2.mjs hardcodes kluster targets/paths (lines 26, 77); only the derivation
rule transfers, via a new generator. The rule PREPENDS the split symbol name (line 94), so
S-prose is identifier-led; comparability claim to the existing evidence base survives (same
rule built it). Fix: reword; note both strata identifier-bearing.

## Checked and found SOUND
Random-nesting unbiasedness (equal file inclusion probability; only realization variance —
cheap multi-seed T1 sensitivity suggested); target-in-T1 conditioning (no interaction);
doc-chunk inclusion rationale; arm-integrity gates 3-4 vs both hybrid.ts loaded guns;
candidate-pool mechanics at depth (limit*2 over-fetch arm-symmetric; brute-force vector, no
ANN nondeterminism); censoring scheme; single decision-bearing test structure; cost
accounting; pre-commit embed deviation "direction: none" (verified: spike scripts issue no
searches; one vector set shared identically); corpus-truth correction consistency.

## Considered and WITHDRAWN
Large-file overrepresentation in T1 (inclusion is by shuffled file position — uniform);
depth-dependent arm asymmetry in FTS/vector paths (shared within tier, cancels in paired
contrast); embedding-nondeterminism-across-registration-boundary (one vector set, shared).
"Expected T1 pool ≈ 497": recomputed 4,357 × 15,000/138,440 = 472; cannot reconstruct 497 —
flagged for one-line correction, feasibility unaffected.

## The biggest thing missing
The registration spent its care on not FABRICATING a scale effect and almost none on whether
its discharge branch can FIRE: sign contradiction (F1), five-count discharge corridor +
underpowered collision (F2), Gate 5 disqualifying the metric on the most probable pattern
(F3), dedup contamination (F4). Modal outcomes as registered: AMBIGUOUS-with-rigour-theatre
or post-hoc-interpreted discharge. Every fix is an amendment plus at most a few hundred
extra searches — all still available because nothing has been measured.
