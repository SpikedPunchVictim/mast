# MAST N1 embedding-model bake-off harness

Standalone evaluation harness for note **N1** in `../FABLE_FEEDBAK.md` — benchmarks
the incumbent embedding model (`jinaai/jina-embeddings-v2-base-code`) against the
approved finalists per the written rubric. It does **not** switch the model; it
produces scored results and a recommendation. The model decision is a separate
approval gate. Results of the 2026-07-10 run are in `results/` (raw JSON) and
summarized in `../FABLE_FEEDBAK.md` § "N1 bake-off results (run 2026-07-10)".

Nothing here is part of the shipped build (`src/` / `dist/`). These are plain
Node ESM (`.mjs`) scripts that import the **compiled** MAST modules from `../dist`
so the eval exercises the real shipped code paths (`runIndex`, `hybridSearch`
with RRF, `LanceStore`, the SQLite FTS side) rather than a reimplementation. The
only bespoke piece is `harness-embedder.mjs`, a parametrized mirror of the
shipped `Embedder` (identical `pooling:'mean' + normalize:true` logic) — needed
because the shipped `Embedder` hardcodes `dtype:'fp32'` and cannot vary
quantization, pooling, or task prompts.

## Before you re-run anything: is it safe?

Most scripts here write into `results/`, which holds **committed, published** artifacts.
Re-running one during a review overwrites a record, and the damage is provenance — the
values may regenerate identically while the run timestamp moves, which reads as a fresh
measurement that never happened. So a reviewer must not re-run a script that writes there.

Answer the question mechanically, never by grep:

```
node eval/results-writers.mjs                  # classify every script
node eval/results-writers.mjs e1-scan-score    # classify some, with evidence
node eval/results-writers.mjs --writers        # names only, for scripting
```

Each verdict comes with the line that produced it, and **proven** writers are reported
apart from those whose target the scanner could not resolve and therefore assumed. Both
kinds are unsafe to re-run; the distinction is there so conservatism is visible rather
than disguised as evidence.

This exists because D025 answered the same question with
`grep 'writeFileSync|appendFileSync|createWriteStream'`, found nothing in five scorers,
and overwrote five verdicts that all wrote through `writeResult(...)`. The grep was not
wrong, it was *incomplete*, and a vocabulary composed from memory at the moment of asking
is incomplete again the next time someone adds a way to write. See `docs/defects/LEDGER.md`.

## Layout

| File | Purpose |
|---|---|
| `paths.mjs` | Scratchpad locations (model cache, state dirs). Never touches the repo's live `.mast`. |
| `models.mjs` | Contender registry (ids, license, params, ctx) + the CodeRankEmbed drop record. |
| `gold-set.json` | **Frozen** 28 query→relevant-chunk pairs (43 targets), weighted to hard cases. Versioned. |
| `corpus-subset.json` | **Frozen** 3,006 chunk-ids embedded per model (all gold targets + seeded distractors). |
| `build-corpus.mjs` | Stage 1: real Phase-1 index of this repo into a throwaway state dir. Model-independent. |
| `make-subset.mjs` | Freezes `corpus-subset.json` (seed 20260709). Run once, before any scoring. |
| `dump-corpus.mjs` | Helper to inspect the corpus while authoring the gold set. |
| `verify-gold.mjs` | Asserts every gold target exists in the corpus. Must pass before scoring. |
| `harness-embedder.mjs` | `EmbedderLike` with dtype/pooling/prompt knobs; mirrors the shipped embed logic. |
| `run-model.mjs` | Stage 2: embed the subset + measure latency/throughput/footprint + score one model. |
| `run-recipe.mjs` | Supplement: re-score a model pure-vector under its *recommended* recipe (CLS pooling, task prompts). |
| `run-all.sh` | Sequential driver over all contenders (one process each → clean RAM/timing). |
| `truncation-analysis.mjs` | embeddinggemma 2048-ctx truncation counts (gold targets, subset, corpus sample). |
| `aggregate.mjs` | Stage 3: fold `results/*.json` into the scored table, weighted composite, decision rule. Prints Markdown. |
| `score-only.mjs` | Task 9 validation: re-score the incumbent's hybrid retrieval only (no re-embedding — reuses the model state dir), plus gold-vs-junk cosine evidence for the vector-gate decision. Run with a `before`/`after` label around a ranking change. |
| `results/` | Raw per-model results from the 2026-07-10 run + `task9-score-{before,after}.json` (copied from the scratchpad). |

> Note (Task 9): the shipped `similarity_threshold` config key no longer exists —
> `hybridSearch` uses rank-based vector inclusion (§7.3). `run-model.mjs` still
> passes the key for historical fidelity; it is ignored by post-Task-9 `dist/`,
> so its `hybrid_shipped` and `hybrid_thresh0` variants converge on rebuilt code.

## Prerequisites

- `pnpm -F @kluster/mast build` (the harness imports from `../dist`).
- Disk: ~0.6–1.7 GB per model download + ~200 MB per model state dir. Check `df`.
- Network: models download into the scratchpad `model-cache` on first load
  (`env.cacheDir` is set there — not the repo, not the default node_modules cache).

## Re-run

```bash
cd packages/mast
pnpm build                                  # refresh dist/

node eval/build-corpus.mjs                  # ~7 min → scratchpad/base-state (12,853 chunks)
node eval/verify-gold.mjs                   # must print "gold set OK"
node eval/make-subset.mjs                   # freeze the vector pool (only if absent)

bash eval/run-all.sh                        # all contenders, sequential (~1.5–2 h on CPU)
node eval/truncation-analysis.mjs           # gemma ctx-cap analysis
# Optional recipe / quantization probes:
node eval/run-recipe.mjs Alibaba-NLP/gte-modernbert-base cls cls
node eval/run-recipe.mjs onnx-community/embeddinggemma-300m-ONNX prompted mean \
  'task: search result | query: ' 'title: none | text: '
node eval/run-model.mjs Alibaba-NLP/gte-modernbert-base q8

node eval/aggregate.mjs                     # prints the Markdown report block
```

Recovery: if a run is killed after its embed finished, re-run with
`EVAL_RESUME=1 EVAL_THROUGHPUT_OVERRIDE=<ch/s from the killed run's log>` —
the embed cache makes the re-run fast, and the override + carried-over latency
keep the timing numbers honest (provenance is stamped into the result JSON).

## Metrics

Per model, three retrieval variants on the frozen gold set (NDCG@10 / Recall@10 /
MRR; only the first chunk matching a target earns NDCG credit):

- `pure_vector` — raw cosine ranking; isolates the model.
- `hybrid_thresh0` — shipped RRF over full-corpus FTS + vectors, 0.70 gate removed.
- `hybrid_shipped` — the exact shipped config (`similarity_threshold: 0.70`).
  Degenerate on this gold set (see the threshold finding in FABLE_FEEDBAK) —
  kept because it is what actually ships.

Plus: query embed latency (median + p90 over the 28 gold queries, warm,
uncached), subset embed throughput (chunks/sec, batch 32, cold cache), model
download bytes, RSS after load, `vectors.lance` on-disk size, and projected
full-corpus vector payload (`dims × 4 × 12853`).

## Determinism

Corpus, gold set, and vector subset are frozen (and `verify-gold.mjs` gates the
gold set) before any model is scored. The gold set was not edited after any
model's results were seen. The one target fix (q24: a symbol renamed during
authoring verification) happened before the first scoring run.

## Known limitations

- **No production miss-log.** The gold set is hand-constructed to reproduce the
  Task-1 zero-result / near-miss class, not sampled from real agent queries.
  See `gold-set.json > provenance_note`.
- **Shipped-recipe scoring is the headline number.** Mean pooling + no prompts —
  exactly what a naive swap gets. `run-recipe.mjs` probes each model's intended
  recipe separately; both numbers are reported.
- **Subset vector pool.** 3,006 vectors (43 gold needles vs ~2,960 distractors)
  instead of all 12,853 — absolute scores are easier than full-corpus, but every
  model sees the identical pool, so ranking is unaffected.
- **28 queries / 43 targets** separates tiers (±30%+), not near-ties (±5%).
- Single-machine CPU timings; container numbers will differ in scale, not order.
