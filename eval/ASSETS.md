# Off-repo eval assets — what they contain and which experiment needs them

These live under `~/.cache/mast-eval/` and are **deliberately not committed** (~2.7 GB
total; they are regenerable inputs, not evidence). All *evidence* — every result JSON, the
30 run outputs, the 147-call search log, the sealed arm manifest — **is** committed under
`eval/results/`. This file is the index so a future session can tell, without opening
anything, what each asset is for and whether it is worth rebuilding.

**Remove worktrees with `git worktree remove`, never `rm -rf`.**

---

## Embedded state dirs — the only expensive items (~45 min compute total)

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

---

## Cheap or replaceable

| asset | size | what it is | rebuild |
|---|---|---|---|
| `model-cache` | 614 MB | jina-embeddings-v2-base-code ONNX weights | re-download; set as `env.cacheDir` before any `pipeline()` |
| `decomp/*.db` | 112 MB | RESERVE-1/2 FTS variant indexes (trigram/unicode61 × content/decomposed) | `node eval/decomp-index.mjs`, `node eval/reserve2-index.mjs` — minutes |
| `corpus-kluster` | 123 MB | git worktree @ `07d705b` | `git worktree add` — seconds |
| `corpus-nest` | 11 MB | git worktree @ `f7fffd6` | `git worktree add` — seconds |
| `ab-wt` | 1.5 GB | 12 per-task worktrees, each with that task's source doc deleted | `node eval/ab-run-setup.mjs` — **disposable, safe to remove now** |

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
What is lost is the ability to *re-run* ranking arms without ~45 min of embedding. The
Q1/OUTCOME conclusions do not depend on these dirs surviving.
