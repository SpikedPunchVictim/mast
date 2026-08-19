# Off-repo eval assets — what they contain and which experiment needs them

These live under `~/.cache/mast-eval/` and are **deliberately not committed** (~2.7 GB
total; they are regenerable inputs, not evidence). All *evidence* — every result JSON, the
30 run outputs, the 147-call search log, the sealed arm manifest — **is** committed under
`eval/results/`. This file is the index so a future session can tell, without opening
anything, what each asset is for and whether it is worth rebuilding.

**Remove worktrees with `git worktree remove`, never `rm -rf`.**

---

## Embedded state dirs — the only expensive items (~45 min compute total)

> **`07d705b` is a `kluster` SHA and does not resolve in this repo.** MAST was split out of
> the kluster monorepo on 2026-08-19, and the citation rewrite that followed deliberately
> left this one alone: it is not a reference to a mast commit, it is the corpus pin — the
> commit you check out to rebuild `base-state-r2`. Reproducing any headline Q1 ranking
> number therefore requires the kluster repository, which is the one eval asset that did
> not become self-contained at the split. The E1 track is unaffected; its corpora are the
> six external OSS repos pinned in `e1-common.mjs`. See `docs/provenance/`.

### `base-state-r2` — 291 MB
kluster corpus pinned at `07d705b`. **10,943 chunks, 100% embedded.**
Serves the `kluster-normal` (n=11) and `kluster-anti` (n=28) gold sets.

Every headline Q1 ranking number comes from here: the authoritative baseline
(`q1-final.mjs`), RESERVE-1, RESERVE-2, and the arm-V equalisation. Pinning matters —
`chunk_id` is `sha256(file_path + ":" + start_line)`, so ids break on *line drift*; a live
tree silently invalidates every frozen gold target.

Rebuild: `git worktree add --detach ~/.cache/mast-eval/corpus-kluster 07d705b` →
`MAST_EVAL_R2=1 node eval/build-corpus.mjs` (~13 s) → `node eval/embed-full-corpus.mjs`
(**~30 min**). `MAST_EVAL_R2=1` is mandatory or you rebuild the leaky v1 corpus.

### `base-state-nest` — 105 MB
nestjs/nest pinned at `f7fffd6`. **4,994 chunks, 100% embedded.**
Serves `nest-external` (n=20) — the n ≥ 2 external replication, the only corpus nobody
here tuned anything against. It is what keeps every kluster result honest.

Rebuild: worktree + build + embed (**~14 min**).

### `ab-state` — 191 MB
Frozen snapshot of the live `.mast` taken 2026-08-02, **1,820 files / 14,464 chunks /
14,481 vectors** (17 orphan vectors from superseded chunks; per-chunk backlog was 10).
Serves the entire **Q1/OUTCOME** experiment — gates 1–4 and all 30 agent runs read this one
snapshot so index drift could not differ between arms.

Rebuild: `node eval/ab-freeze.mjs`. **Note:** this reproduces *a* snapshot, not *the*
snapshot — the live index has moved since. The committed run evidence is the durable
record; re-freezing gives a new baseline, not this one.

Taken via SQLite's backup API, not `cp`: the live `graph.db` held 8.2 MB in a WAL that a
plain file copy drops silently. That trap previously cost a session a false "the write path
is broken" conclusion.

### `vscode-state-full` — 4.7 GB
vscode pinned at `5ebbe53282bd1d5d3453405d9e6a34ee2eb7f42d`. **138,440 chunks, 100%
embedded** (8,653 files indexed; two whale fixture files absent — see
`IMPLEMENTATION_PLAN.md`'s Q1/SCALE registration, "Corpus-truth correction"). Breakdown:
`lance/` 2.0 GB, `embed_cache/` 2.0 GB (shared with the three tier dirs below via symlink),
`graph.db` 736 MB. Serves Q1/SCALE as **T4** (the full-scale tier) and is the shared
embed-cache source for T1–T3.

Rebuild: `git worktree add --detach <dir> 5ebbe53282bd1d5d3453405d9e6a34ee2eb7f42d` → Phase-1
build (**577 s** measured) → `node eval/embed-full-corpus.mjs`. **~7.4 h measured** (embed.log:
"done in 446.3 min"), not the ~4.0 h projected from a 500-chunk sample — embed rate degrades
over the run (**9.6–10.5 ch/s at the start, 5.15–5.28 ch/s by the end, 5.2 ch/s effective
over the full 137,940-chunk run**). The sample-based projection understates full-run cost by
~1.85×; price future embeds off the measured full-run rate, not a short sample.

### `vscode-state-t1` / `vscode-state-t2` / `vscode-state-t3` — 151 MB / 636 MB / 1.4 GB
Nested random-file-subset tiers of the same vscode checkout (seed 153, committed manifest):
**15,003 / 49,998 / 89,989 chunks**, each a strict subset of the next (T1 ⊂ T2 ⊂ T3 ⊂ T4).
Each has its own `graph.db`/FTS index and its own `lance/vectors.lance`, but all three
`embed_cache/` dirs are **symlinks into `vscode-state-full/embed_cache`** — no chunk is
re-embedded across tiers, only re-populated into that tier's Lance table from the cache (0
cache misses measured, Gate 0(c)/(d)). Serves Q1/SCALE's T1/T2/T3 dose–response points.

Rebuild (cheap once `vscode-state-full`'s embed_cache exists): `eval/scale-build-tiers.mjs` →
Phase-1 per tier (sub-linear in file count, bounded by the full corpus's 577 s) →
`eval/scale-embed-tiers.mjs` (cache-populate only — **16.8 s / 220.5 s / 956.3 s** for
T1/T2/T3, no model calls).

---

## Cheap or replaceable

| asset | size | what it is | rebuild |
|---|---|---|---|
| `model-cache` | 614 MB | jina-embeddings-v2-base-code ONNX weights | re-download; set as `env.cacheDir` before any `pipeline()` |
| `decomp/*.db` | 112 MB | RESERVE-1/2 FTS variant indexes (trigram/unicode61 × content/decomposed) | `node eval/decomp-index.mjs`, `node eval/reserve2-index.mjs` — minutes |
| `corpus-kluster` | 123 MB | git worktree @ `07d705b` | `git worktree add` — seconds |
| `corpus-nest` | 11 MB | git worktree @ `f7fffd6` | `git worktree add` — seconds |
| `ab-wt` | 1.5 GB | 12 per-task worktrees, each with that task's source doc deleted | `node eval/ab-run-setup.mjs` — **disposable, safe to remove now** |
| `scale-corpus-t1` / `-t2` / `-t3` | 12 MB / 38 MB / 69 MB | pinned vscode file-subset worktrees (seed 153) the Q1/SCALE tier states were indexed from | `git worktree add` — seconds |
| `~/temp/enterprise-apps/vscode` | 1.5 GB | full pinned vscode checkout @ `5ebbe53282bd1d5d3453405d9e6a34ee2eb7f42d`, source for `vscode-state-full` and the tier worktrees above | `git clone` + pin — network-bound, not compute-bound |

---

## Environment

- `MAST_EVAL_STATE` — overrides `BASE_STATE_DIR`. **Required** by nearly every script.
- `MAST_EVAL_R2=1` — required by `build-corpus.mjs`; without it you rebuild the void v1 corpus.
- `MAST_AB_STATE` / `MAST_AB_ARM` / `MAST_AB_LOG` / `MAST_AB_RUN` / `MAST_AB_TASK` — the A/B harness.
- Run every script from `packages/mast`, never the repo root.
- **Never** open `graph.db` with `?mode=ro&immutable=1` for metrics reads — it is WAL-blind
  and reports the `metrics` table as empty.

## If these are lost

Nothing in the committed record becomes unverifiable — the evidence is in `eval/results/`.
What is lost is the ability to *re-run* ranking arms without ~45 min of embedding (Q1/OUTCOME
assets) or **~7.4 h of embedding** (the Q1/SCALE `vscode-state-full` corpus, whose cache the
T1–T3 tiers depend on). The Q1/OUTCOME and Q1/SCALE conclusions do not depend on these dirs
surviving — but the `identifier_fts`-fusion lever queued next (`HANDOFF_Q1.md` §4a) is
designed to reuse the frozen T1–T4 tier states at zero re-embed cost, and that plan does
depend on them surviving.
