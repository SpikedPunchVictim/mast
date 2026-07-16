# Stage 3.1 — Graph Centrality as a Third RRF Ranker: Offline Experiment

**Date:** 2026-07-15 · **Plan:** `IMPLEMENTATION_PLAN_VEXP.md` Feature 3 / Stage 3.1 ·
**Verdict: REJECT** (both in-degree and PageRank variants)

Raw data: `results.json` (in-degree), `results-pagerank.json` (PageRank probe).

## Provenance

- **Corpus path: rebuilt.** The frozen 2026-07-10 scratchpad state was checked
  first and found unusable: `chunks.lance` directories survived but **graph.db was
  absent from every state dir** (base-state and all per-model states), and the
  base-state chunks.lance had missing data fragments (LanceStore's corruption
  probe fired: `[mast] WARN: chunks.lance has missing data fragments — wiping
  lance directory; a full reindex will rebuild it`). Rebuilt per eval/README.md:
  `build-corpus.mjs` (480.7s, 1696 files, 0 parse errors, **12,989 chunks** vs
  12,853 recorded on 2026-07-10 — the repo changed over 5 days), then
  `verify-gold.mjs` → **"gold set OK — every target exists in the corpus."**
- **Subset:** frozen `corpus-subset.json` (3,000 ids, seed 20260709) reused
  unedited; 2,952/3,000 ids still resolve against the rebuilt corpus (48 drifted).
  The 2,952 were embedded with the incumbent (jinaai/jina-embeddings-v2-base-code,
  fp32, shipped recipe via `run-model.mjs`); vector store verified at 2,952 rows
  post-embed. FTS side is full-corpus, exactly as in the N1 runs.
- **Fusion params:** rrf_k=60, limit=10, candidate pool 4×limit=40 per ranker —
  identical to shipped `hybridSearch`.
- **Gold set / match rule:** untouched; scoring functions copied verbatim from
  `score-only.mjs` (first-chunk-per-target NDCG credit).

## Before-arm validation vs the recorded 0.580 baseline

Measured before-arm (shipped 2-ranker) NDCG@10 = **0.4884** — a **-0.0916** delta
vs the recorded ungated baseline (0.580, N1 run 2026-07-10), outside the ±0.02
tolerance. Per the plan this forced a stop-and-diagnose before the gate could be
applied. Diagnosis:

1. **Harness reproduction is exact, proven two ways.** The before arm does not
   reimplement fusion — it calls the shipped `hybridSearch` from `dist/`. It also
   matches the independent `run-model.mjs` scoring of the same rebuilt corpus to
   four decimals (0.4884 vs 0.4884).
2. **The delta is subset drift, quantified.** Six queries (q05, q08, q20, q25,
   q27, q28) now have gold targets whose current chunk_ids are **not in the
   frozen 2026-07-09 subset** — chunk_ids are a function of (file_path,
   start_line), so five days of repo edits (including to `hybrid.ts` itself,
   whose `dedupShellMethodCollisions` and `gatherSuggestions` are gold targets)
   moved them out of the frozen vector pool. Comparing per-query NDCG against
   the recorded 2026-07-10 per-query values: the lost-coverage queries account
   for **-2.184 of the total -2.551** NDCG-sum drop (**85.6%**); the remainder
   is one query (q23, -0.369), consistent with corpus-growth noise.
3. **The A/B remains internally valid.** Both arms run on the identical rebuilt
   corpus, subset, and embedder; the experiment measures only the marginal
   effect of the third ranker. The depressed absolute level does not bias the
   delta — if anything the six vector-blind queries are inert ballast for both
   arms (four of them score 0 in both).

Gate applied on that basis.

## Results

| Arm | NDCG@10 | Recall@10 | MRR |
|---|---|---|---|
| Before — shipped 2-ranker (FTS + vector) | **0.4884** | 0.6190 | 0.4921 |
| After — 3-ranker, in-degree centrality | 0.4071 | 0.6012 | 0.3971 |
| Probe — 3-ranker, PageRank d=0.85 | 0.4196 | 0.6012 | 0.4387 |

- In-degree delta: **-0.0813** NDCG@10 (gate requires ≥ +0.05) → **REJECT**.
- PageRank delta: **-0.0688** → **REJECT**.
- Per-query degradation check: worst tier delta **3** in both variants (gate
  allows at most 1) — fails independently of the aggregate.

**Centrality coverage:** 1,990/12,983 corpus chunks (**15.33%**) received a
nonzero in-degree score (10,733 symbols, 3,575 POTENTIAL_CALL+IMPLEMENTS
in-edges; top hubs: 91, 80, 80, 34, 33 …). PageRank above-uniform-floor
coverage is equivalent (15.57%). ~85% of chunks tie at zero and receive
arbitrary (chunk_id-ordered) ranks in the centrality list — every candidate
still collects an RRF contribution from that list, which is pure noise for
zero-centrality candidates.

## Per-query deltas (in-degree arm; firstRel = rank of first relevant hit, — = not in top 10)

| Query | Class | Before ndcg (rank) | After ndcg (rank) | Δndcg | Tier Δ |
|---|---|---|---|---|---|
| q01 | conceptual | 0.431 (4) | 0.500 (3) | +0.069 | -1 |
| q02 | conceptual | 0.000 (—) | 0.387 (5) | +0.387 | -2 |
| q03 | near-miss | 0.264 (4) | 0.387 (2) | +0.123 | -1 |
| q04 | qualified-method | 0.218 (6) | 0.204 (7) | -0.014 | +1 |
| q05 | cross-file | 0.469 (1) | 0.148 (8) | -0.321 | **+3** |
| q06 | conceptual | 0.000 (—) | 0.000 (—) | 0 | 0 |
| q07 | conceptual | 1.000 (1) | 1.000 (1) | 0 | 0 |
| q08 | conceptual | 0.000 (—) | 0.000 (—) | 0 | 0 |
| q09 | conceptual | 0.693 (2) | 0.613 (1) | -0.080 | -1 |
| q10 | near-miss | 0.301 (9) | 0.631 (2) | +0.330 | -2 |
| q11 | conceptual | 0.307 (3) | 0.307 (3) | 0 | 0 |
| q12 | near-miss | 1.000 (1) | 0.387 (5) | -0.613 | **+2** |
| q13 | conceptual | 1.000 (1) | 1.000 (1) | 0 | 0 |
| q14 | cross-file | 0.000 (—) | 0.264 (4) | +0.264 | -2 |
| q15 | conceptual | 1.000 (1) | 1.000 (1) | 0 | 0 |
| q16 | qualified-method | 1.000 (1) | 0.387 (5) | -0.613 | **+2** |
| q17 | conceptual | 0.613 (1) | 0.613 (1) | 0 | 0 |
| q18 | conceptual | 1.000 (1) | 0.631 (2) | -0.369 | +1 |
| q19 | cross-file | 0.651 (2) | 0.000 (—) | -0.651 | **+3** |
| q20 | qualified-method | 0.307 (3) | 0.264 (4) | -0.043 | +1 |
| q21 | conceptual | 0.613 (1) | 0.307 (3) | -0.307 | +1 |
| q22 | conceptual | 0.571 (3) | 0.920 (1) | +0.349 | -1 |
| q23 | conceptual | 0.631 (2) | 0.631 (2) | 0 | 0 |
| q24 | conceptual | 0.605 (2) | 0.387 (2) | -0.218 | 0 |
| q25 | conceptual | 0.000 (—) | 0.000 (—) | 0 | 0 |
| q26 | near-miss | 1.000 (1) | 0.431 (4) | -0.569 | **+2** |
| q27 | conceptual | 0.000 (—) | 0.000 (—) | 0 | 0 |
| q28 | cross-file | 0.000 (—) | 0.000 (—) | 0 | 0 |

Degraded 11 / improved 6 / flat 11. (Tier buckets for the degradation check:
rank 1 / 2–3 / 4–6 / 7–10 / not-found — the plan defines tier resolution only
for aggregate NDCG, so rank-position tiers were fixed mechanically before
scoring; the verdict does not hinge on the bucketing, since the aggregate is
decisively negative.)

## Why it fails: hub displacement, confirmed

Five queries where the shipped fusion already had the answer at rank 1 were
pushed down (q12 1→5, q16 1→5, q18 1→2, q21 1→3, q26 1→4). Inspecting q16's
candidate pool: the gold target `queryBarrelExports` has in-degree 1 and is
outranked in the centrality list by query-irrelevant hubs — `runIndex` (4),
`collectPotentialMatches` (2), `diffManifest` (2), `walkProject` (2). The
centrality ranker rewards being load-bearing, not being relevant — precisely
the failure mode the plan flagged ("centrality biases toward hub symbols
regardless of query intent").

The hub-displacement signature triggered the pre-authorized PageRank probe
(damping 0.85, 76 iterations to convergence, 81ms, same edge set). PageRank
repaired some displacements (q12 back to rank 1, q20 3→1, q03 4→1) but
introduced new ones (q13 1→2, q23 2→5, q01 4→6) and kept the worst losses
(q19 still dropped out of top-10, q05 still 1→8). Net -0.0688 — better than
in-degree, still well below zero. Both knobs are now exhausted per the plan
("do not try further variants beyond these two").

## Interpretation (honest)

Query-independent structural importance does not help this gold set and
actively hurts it: the wins (q02 +0.39, q22 +0.35, q10 +0.33, q14 +0.26 —
identifier-less conceptual queries whose targets happen to be load-bearing)
are outweighed by hub displacement on queries the 2-ranker already answered
perfectly. This is not the "flat-but-promising" HOLD case — the aggregate is
decisively negative, and the damage lands on the highest-value outcomes
(rank-1 hits destroyed). Limitations stated plainly: (1) the absolute score
level is depressed ~0.09 by frozen-subset drift (six queries' targets have no
vector representation on the rebuilt corpus — fully quantified above), so
compare deltas, not levels, against the 2026-07-10 numbers; (2) the gold set
resolves tiers (±30%), not near-ties — but -0.08 is a tier-scale loss, so the
verdict does not lean on fine resolution; (3) with only 3,575 relevant edges
over 10,733 symbols, 85% of chunks tie at zero centrality, making the third
rank list noise for most candidates — a richer edge set (e.g. Feature 1's
checker-verified edges) could change the centrality distribution, and that
would be the only evidence-based reason to revisit this after Feature 1 ships.

## Anomalies (verbatim)

1. `[mast] WARN: chunks.lance has missing data fragments — wiping lance
   directory; a full reindex will rebuild it` — on first `build-corpus.mjs`
   open of the surviving 2026-07-10 base-state; graph.db was entirely absent
   from every scratchpad state dir. Cause unknown (external cleanup of the
   scratchpad between sessions); handled by the documented rebuild path.
2. The first `run-model.mjs` invocation was killed at its caller's 10-minute
   timeout mid-embed (2,784/2,952 vectors); recovered with the documented
   `EVAL_RESUME=1 EVAL_THROUGHPUT_OVERRIDE=5.2` path. A brief overlap between
   the dying original and the resume run wrote no duplicates (final vector
   count exactly 2,952).
3. The corpus itself contains 4 duplicated chunk_ids (10 rows for 4 ids —
   `chunk_id` is a hash of file_path+start_line, and split/regenerated chunks
   in `packages/workbench/sdd/apps/**` generated code collide). All are
   irrelevant distractors; both arms see them identically. Worth a look in the
   indexer someday; immaterial here.
4. `verify-gold.mjs` passed, but 6/28 queries' gold targets are outside the
   frozen embedded subset on the rebuilt corpus (verify-gold checks the
   corpus, not the subset). This is the entire baseline-validation gap — see
   the drift diagnosis above. If the eval harness is used again before a
   re-freeze, `make-subset.mjs` + re-embed should be re-run to restore vector
   coverage (a determinism-rule decision for the harness owner, not taken
   unilaterally here).
