# Q1/IDFUSE adversarial results review (Fable, 2026-08-03, post-scoring) — verbatim
Evidence 5a34b9b, instrument 3b0cc46, registration 692f6f0. Full independent recompute from
idfuse-measure-raw.json (8,000 rows); line-level audit of all four instrument files + the
runner driver; live re-execution of the fusion against the real tier states (53 queries
reconstructed end-to-end, plus three full-cell counterfactual sweeps).

## F-R1 (MOST IMPORTANT FOR THE RESULT) — Off-stratum harm real, mechanism-verified, structurally invisible to every registered statistic; independent disqualifier of F17-as-constructed.
L+I vs L paired per tier — s_approx: -8.7pp T1 (1 helped/14 hurt, exact p=0.00098), -8.0 T2,
-9.3 T3, -7.3 T4; s_prose: -9pp T1 (p=0.0117), -12 T2/T3 (p=0.0018), -9 T4. Significant at
EVERY tier of both strata, including T1 (pre-scale). Not a wiring artifact: all 24 T1 harm
rows reproduce exactly against the real tier state; the 800-candidate slice cannot cause it.
Mechanism = RESERVE-1-style vote dilution: target at fts-rank 1-2, but ranker I's OR-bag
matches ~800 chunks (pool cap hit 18/24) with target I-rank ABSENT or 24-792 — competitors
accumulate fts+I double votes and leapfrog a single-vote target. Structural gap: harm is
tier-flat so D_loss cancels it; Delta'-scale triggers can never fire on it; no registered
statistic compares L+I vs L off-stratum. Direction: makes INERT-LEVER more damning. Required
caveat: F17-as-constructed would be dead on harm grounds even had efficacy passed.

## F-R2 (MECHANISM ANSWER) — Hypothesis (a) dominates with (b) as a secondary cap; declaration-exact Reserve variant is INDICATED, with one modification.
For all 21 s_ident/T4 L+I out-of-window queries: target's rank within ranker I's own
ordering — median 28, min 6, max 99; only 2/21 <= 10; outranked ~26:1 by non-same-name
bag matches (call-site/reference chunks under bag-BM25 doc-length/IDF math) -> (a). But (b)
real: forcing target to I-rank 1 rescues only 12/21 (fusion dilution cap). Declaration-exact
counterfactual (symbol_name == query term, target ranked LAST among same-name — pessimistic):
rescues 20/21; full T4 s_ident cell = .9933 (beats H .9333). Ungated it inherits common-word
harm (s_prose T4 .73). SYMBOL-GATED declaration-exact: T4 s_ident .9800, s_approx .8400 = L
exactly, s_prose .8200 = L exactly (zero harm); T1 s_ident 1.0000; D_loss ~2pp vs H 6pp —
closure shape, no off-stratum cost. Caveats: post-hoc same-400-queries projection (selection
risk — needs fresh registered run); symbol-shape gate loses all-lowercase identifiers
(rtrim/splice class — the 3 L+Isym regressions), so variant should OR-in whole-query-token
matches on symbol_name regardless of shape. The Reserve promotion condition ("if bag-BM25
ranking of declarations proves weak") is now empirically met. L+Isym curiosity resolved:
35.5% is all-strata aggregate; on s_ident L+Isym matches 94% of targets; beats L+I at T4 by
shedding prose-token votes (6 gains, 3 losses = all-lowercase identifiers).

## F-R3 — Inertness attack FAILS; ranker I was genuinely live.
29/29 reconstructed rows (all 21 T4 failures + 8 L-out-of-window incl. all 4 efficacy
rescues) reproduce recorded L+I rank AND pre_dedup_rank exactly from searchFts + searchRankerI
+ RRF(k=60) + dedup against the real tier state. Target inside I's 4x pool in every failure.
Genuine rescues confirmed (s_ident_7: 51->5 via I-rank 6; _44: 14->5; _25: 12->8). Inert AS
REGISTERED, not by defect: F1 fix implemented verbatim; Gate B extended fixtures pass 22/22.

## F-R4 — Independent recompute: all headline numbers reproduce.
All 60 cells match. Delta' {0:133,+1:14,-1:3}, theta=+7.33pp, exact Wilcoxon p=0.0127258
(=committed). Efficacy {0:145,+1:4,-1:1}, theta=+2pp, p=0.375, not knife-edge (net +3 vs ~+5
needed). BCa CIs match. Scorer rerun with committed seeds byte-identical. Verdict mapping
correct; F2 collision cell correctly cannot fire. W=27 worry resolved: min-rank-sum
convention, all 17 |Delta'|=1, ranks all 9, W- = 3x9 = 27; p equals sign test exactly.

## F-R5 — Trigger early-return: registration-conformant; honest-limits note.
Registered trigger clauses attach only to GAP CLOSED/GAP SURVIVES; INERT-LEVER cell carries
no trigger language. Immaterial here: no supporting CI excludes 0 in either direction; every
tier sequence weakly monotone. Caveat, not overturn.

## F-R6 — Gate D's 100% is real. Archived file byte-identical to 8868404 blob (sha
3a7027fe...); fresh file distinct run (sha 4f86c819...). Independent 3,200-row comparison
reproduces 3,200/3,200. Deterministic pipeline makes 100% credible.

## F-R7 — Driver fidelity clean; CLI-defect recurrence confirmed.
idfuse-run-score.mjs contains no scoring/verdict logic (argv parsing + orchestration +
descriptive blocks the registration assigns to the score step). idfuse-score.mjs has no
entry point despite the wrapper fixing exactly this — the parent's defect class recurred on
1 of 2 new files. Process finding; cosmetic for validity.

## F-R8 (cosmetic) — Costs line says 6,400 (4 arms) but L+Isym is registered (F7) and run:
8,000 rows. Drafting slip; arms tables license the run.

## Surface 8 — biggest things the result is missing (now quantified):
(1) the off-stratum harm number (F-R1); (2) "inert" under-describes: ranker I anchored 100%
of s_ident targets (F7 any-match = 1.000 on the decision stratum) and helped at T1-T3
(T3: +4.67pp, 8/1, nominal p=0.039; L+I T1 = .9933 = H's T1) — it fails AT T4 SPECIFICALLY
because bag crowding grows with corpus size (I-pools saturate the 800 cap at T4): the lever
degrades with scale for the same reason chunk_fts does, so it cannot fix a scale problem;
(3) the mechanism decomposition and the now-met promotion condition for declaration-exact.

## SOUND: all 60 cells; F7 aggregates; Gate A 80/80; Gate C 0 violations (recomputed from
raw); row-internal consistency; no duplicate rows; 29 censored / 1,011 suppression; seeded
reproducibility; pool conventions as registered (8x/4x/4x); F1 derivation + Gate B verbatim;
in-file judgment calls honest and correctly directioned.

## WITHDRAWN: W=27 implies |Delta'|=2 (min-rank-sum convention); Gate D self-join (byte
provenance + independent recompute); off-stratum harm as wiring artifact (24/24 reproduce);
L+Isym diagnostic bug (aggregate-vs-stratum confusion); rare-word flooding stays withdrawn
but its cousin — common-word OR-bag flooding off-stratum — is exactly F-R1's verified harm.

## VERDICTS
(a) INERT-LEVER survives — YES, with required caveats: (1) off-stratum harm (-7..-12pp,
significant every tier, invisible to Delta' by construction) as independent disqualifier of
F17-as-constructed; (2) lever is inert AT T4 IN THE REGISTERED CONTRAST while mechanically
live and helpful at T1-T3 — "failed as a scale rescue," not "does nothing"; (3) triggers/
monotonicity not evaluated on the INERT-LEVER path (conformant, immaterial here); (4) M2
consequence stands (delete arm stays blocked) but "vectors' defensible niche" should not be
over-read — see (b).
(b) Mechanism: (a) dominates — declaration does not rank well inside ranker I (median I-rank
28; 2/21 top-10; outranked ~26:1 by non-same-name bag matches) — but the OR-bag caps any fix
via fusion dilution (perfect I-rank-1 rescues only 12/21). Indicated next experiment: the
declaration-exact Reserve variant, symbol-gated with a whole-query-token escape for
all-lowercase identifiers — pessimistic projection: T4 s_ident .9800-.9933 (vs H .9333,
L+I .8600), s_approx/s_prose exactly = L (zero harm). Post-hoc projection; must be freshly
registered. A live, evidence-backed lever — which materially weakens the "defensible niche"
reading of this INERT-LEVER result.
