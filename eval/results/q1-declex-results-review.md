# Q1/DECLEX adversarial results review (Fable, 2026-08-03, maximum-scrutiny, post-scoring) — verbatim
Evidence beccd52, instrument b148594, registration dd10796. Everything recomputed from
committed artifacts (merged raw sha256 79ab3789... = scorer's recorded source_sha256),
re-run against live tier states, or reconstructed end-to-end. Nothing taken on faith.

## RF-1 (MOST IMPORTANT — registration-compliance omission, direction pro-deletion): the
registered esc-arm harm contrast is MISSING from the scorer output; computed, it shows
significant off-stratum harm at every cap. Registration F-1 (3636-3638) and the verdict row
promise "esc-arm harm contrast reported descriptively in its place" when both strata are
HARM-NULL; the output contains only esc fire rates + match-count distribution
(computeEscapeCapSweep, declex-score.mjs:488-507). Computed with the registered per-query
block bootstrap: cap 20: s_approx -4.83pp [-9.17,-1.0]; s_prose -13.5pp [-19.75,-8.25];
cap 5: s_prose -10.75pp [-16.5,-6.5]; cap 50: s_prose -13.5pp [-20.0,-8.0] — every cell
excludes 0 in the harmful direction (esc fire rates 84.5-100% on the null strata: the only
exposed harm data in the experiment, and it is adverse). Does not touch the primary verdict
(primary arm is D-without-escape, registered harm-untested) but closes off "ship the escape
variant" without a new registration. RESULT must carry these numbers verbatim.

## RF-2 (required caveat): closure statistics are one-legged — the Wilcoxon ns condition is
structurally incapable of failing at this degeneracy. 146/150 zeros, nonzeros [-1,-1,-1,+1]
(s_ident_42/49/84 at -1, s_ident_115 at +1, verified per-row). Exact Wilcoxon: W=2.5,
p=2*(5/16)=0.625 ✓; minimum achievable two-sided p at n=4 is 0.125 — the ns leg could not
have failed. Scorer correctly reports underpowered per the <10 rule; closure rests entirely
on the BCa upper <= 5pp. That leg is solid: seed 3002 reproduces [-5.33pp, 0]; across 50
alternative seeds hi = 0.00000 in all 50; lo stable. CLOSED is genuinely CI-driven and
seed-robust — but the RESULT must state the ns leg was vacuous and the experiment contained
~4 informative pairs on the decision contrast.

## RF-3 (required caveat): the "L+D T4 exceeds H T4" margin rides substantially on
shell-counterpart credit. +1.33pp = 3 queries L+D-in/H-out (s_ident_35, 49, 84) minus 1
reverse (s_ident_121, D-silent lowercase, H rank 4). Reconstructed: 49 clean D-anchored
exact hit (rank 5 vs H 12); 84 and 35 are COUNTERPART hits — D full-matches the parent
class shell to rank 1 while the method target sits at pre-dedup 216 and 511. The
dedup-aware hit rule is the registered metric, applied uniformly — legitimate — but 23/148
of L+D's T4 hits are counterpart credits (vs 14/148 for H); the RESULT must name the
composition rather than let ".9867 > H" read as exact-hit superiority.

## RF-4 (resolved — the exactly-zero F-4 delta is genuine, not an implementation artifact).
Scorer compares measured rates against hardcoded F_R2_PROJECTION constants
(declex-score.mjs:78-82); no shared code path, nothing cached; rates recomputed from raw:
.9800 exactly, s_approx = L exactly, s_prose = L exactly. Mechanism per-row: (a) D-fired ⇒
in-window at T4 in 144/144 original and 146/146 fresh cases (full-name/shell ordering puts
the anchor at D-rank ~1; RRF lands it every time); (b) D-silent ⇒ L+D row-identical to L
(3,199/3,200 original off-stratum row-pairs; s_ident misses {6,7,135} all D-silent
lowercase, the projected rtrim/splice class); (c) the segment channel IS live and adds the
predicted crowd (34/36 segment-only reaches, candidate_count max 139 ≈ the ~140 toJSON
prediction) but 0 of 70 segment-only reaches fell out of window — the crowd sits below
full-name matches by ordering and never displaced a membership. Verified by 48-row
end-to-end reconstruction incl. live embedder for H: 48/48 exact on rank, hit_case,
pre_dedup_rank, mode, every d_diagnostic field. D was live in the fresh fusion.

## RF-5 (honesty point): the pre-stated prediction partially missed. Registered: "Δ' ≈ -2
to -4pp, a-fortiori territory." Observed: θ̂ = -1.33pp, plain CLOSED. H barely degraded on
the fresh draw (D_loss_H = 1.33pp vs ~6pp on the old 400) — the S-ident scale gap on this
draw was mild before D touched it. Deflationary surprise; the RESULT says so.

## RF-6 (report): near-miss consistency trigger. s_approx supporting Δ' CI [-0.67pp,
+10.67pp], θ̂ +5.33pp — L+D trending worse than H off-stratum on the scale metric, lo one
step from the closure-direction trigger. Correctly non-triggering; visible in the RESULT
alongside the recomputed off-stratum level deficits s_approx -7.67pp [-13.0,-3.17],
s_prose -7.25pp [-13.5,-2.75] (hi negative across 20 alternative seeds) — the firewall's
"what deletion forfeits vs H" numbers.

## RF-7 (minor): one window-invisible harm micro-instance — original s_prose_4 T4: D fired
(cc=1), demoted target rank 1→2. Only off-stratum D effect in 3,200 original row-pairs;
fresh off-strata: 4 rank-differing, 0 window-differing rows. Footnote.

## RF-8 (provenance nit, resolved): frozen-set regeneration byte-identical except
git_head_at_generation (committed dd10796 — generation at the amended registration, before
instrument and evidence); determinism gate hashes compact JSON so its hash legitimately
differs from the pretty-printed file's. Cosmetic.

## SOUND: merged-file integrity (19,200 rows, 0 dup keys, exact union of 4 parts, esc parts
only L+D+esc — no contamination; timestamps strictly ordered); efficacy 22+/0-/128z, W=0,
p=2*2^-22=4.77e-7 exact, θ̂ +14.67pp CI [+9.33,+20.0], lo>+8.67pp across 30 seeds — PASS
unconditional; zero degradation = the SAME 148 queries in-window at both endpoints (0
exits, 0 entries; out at both: s_ident_42, s_ident_121, both D-silent); fire rates 4/600 =
0.67%, 2/400 = 0.50% → HARM_NULL correct; verdict row 2 correctly reached, harm-UNTESTED
qualifier + F-9 firewall structurally enforced; fresh-set integrity (0/260 overlap, all 410
targets exist in T1 and exported, anchor 146/150 = 97.33% published pre-scoring = measured
fire rate, determinism PASS, exclusion ≡ 260, seed 154); Gate A 80/80 re-checked; Gate E
re-verified live (0 pending × 4); reproducibility 3,200/3,200 vs idfuse, 1.0 all cells;
597/597 suite passes now.

## WITHDRAWN: BCa-upper-0 as seed luck (50-seed invariant); determinism-hash mismatch as
tampering (serialization + provenance stamp; content byte-identical); F-4 zero delta as
same-code-path echo (constants vs live measurement; 48/48 reconstruction).

## Pre-run predictions scored: ~4.5±1.5 D-silent → 4 HIT; efficacy near-certain → HIT;
harm vacuous → HIT; anchor ~96-97% → 97.33% HIT; Δ' -2..-4pp a-fortiori → -1.33pp plain
CLOSED **MISS** (milder); L+D T4 ≈ .98 → .9867 HIT; toJSON crowd ~140 → 139 old set HIT
(fresh draw never faced a large crowd).

## (a) Does DECLEX_GAP_CLOSED_HARM_UNTESTED survive? YES — with required caveats:
(1) add the esc-arm off-stratum harm contrast (RF-1) — registered "in its place" report
missing and its content adverse; (2) state the statistical degeneracy plainly (RF-2) —
146/150 ties, ~4 informative pairs, ns leg vacuous below 6 nonzeros, closure carried by the
seed-stable BCa upper bound of 0; (3) name the counterpart-credit composition (RF-3) —
23/148 shell credits, 2 of 3 exceed-H queries are shell credits; (4) report the prediction
miss (RF-5) and the near-miss s_approx trigger + off-stratum level deficits (RF-6).

## (b) What this licenses for M2, at registered scope: DECLEX closes exactly one thing —
the S-ident SCALE caveat: for queries literally containing the declared name as a
symbol-shaped token, lexical + declaration-exact (F18 as registered, WITHOUT the escape
variant, now measured harmful off-stratum) holds in_window@10 flat T1→T4 (.9867→.9867,
Δ' vs H CI [-5.33pp, 0]) on a fresh never-scored 150-query set, efficacy over plain lexical
+14.67pp [+9.33,+20.0] — so the M2 delete arm RE-OPENS, F18 the enabling product change,
subject to its own regression suite. It licenses nothing else: harm on identifier-free
queries UNTESTED at the primary construction (the realistic shipped-D harm surface —
mixed-case prose mentioning non-target identifiers — lies outside every stratum); the
S-prose T4 LEVEL gap (H 92 vs L 82 per 100) and the kluster-normal H-L baseline are
unconfronted, and fresh-set descriptives point the same way (L+D -7.7/-7.25pp below H
off-stratum, seed-robust); closure generalizes only to symbol-shaped-token queries from the
same TSDoc-rich exported-declaration population on this one corpus; 15.5% of L+D's window
hits are shell-counterpart credits; and the outcome-at-scale question retains its Reserve
standing — nothing here measures agent task outcomes. Deleting the vector store on this
evidence is a bet that these scoped-out gaps don't matter; M2 must confront each explicitly
before that bet is placed.
