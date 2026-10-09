# checker-widening — eval manifest

**Record:** [`PROPOSAL.md`](PROPOSAL.md). No ADR yet.

Spike scripts and their output stay under `spikes/`. Nothing here writes into
`eval/results/`. The instrument is `eval-suite/graph-scorecard.mjs`, run as
`eval-suite/GRAPH-SCORECARD.md` describes. Corpora: n8n `9d9e9bf9` (a copy, index built by
`14a67bf`), directus `9dca3724a6` (a copy, no `node_modules`), this repository.

## s1 — cost and yield (`spikes/s1-cost-yield/`)

| File | What it is |
|---|---|
| `run.mjs <corpus> <graph.db> <work dir> <out.json> [--workspace-src] [--skip <dir>]` | Runs the scorecard once per tsconfig project `mast index --checker` would visit, one process each, and sums time, peak memory and the call-pair buckets over the union of keys. Needs a built `dist/` |
| `n8n.json` | n8n, the plain index, after the D152 fix. 80 projects scored, the root project out of memory |
| `n8n-after-the-existing-pass.json` | The same over the index `s3` left, root project skipped. `call_edges_by_the_rule_that_stored_them` has the `checker` edges |

## s2 — how long a checker edge lives (`spikes/s2-checker-edge-lifetime/`)

| File | What it is |
|---|---|
| `repro.sh <work dir>` | Three fixtures: A, a third file changes what a call resolves to (D150); B, a full index without `--checker` (D151); C, a method called on what a function returns |
| `repro.out.txt` | Its output on `7da5ba0` |

## s3 — the shipped pass on real repositories (`spikes/s3-existing-pass-on-n8n/`)

| File | What it is |
|---|---|
| `run.sh <corpus> <state dir> <out dir>` | Copies the state dir and runs `mast index --incremental --checker` on the copy under `time -l` |
| `pass.out.txt`, `pass.err.txt` | n8n: exit 134, the counts of what was written before, and the error without its stack frames (D153) |
| `classify-checker-edges.py <cards> <graph.db> <out.json>` | The `checker` edges by how the scorecard judged them and what the compiler has from the same caller |
| `checker-edges.json` | Its output on n8n (D155, and the samples D154 was read from) |
| `caller-span.sql` | For every `checker` edge, whether its call line is inside a chunk of the symbol it is from |
| `caller-span.out.txt` | n8n (D154) |
| `directus/`, `mast/` | `pass.out.txt`, `time.txt` and `caller-span.out.txt` for the two other corpora |

## s4 — what the lacking pairs are (`spikes/s4-what-the-lacking-pairs-are/`)

| File | What it is |
|---|---|
| `classify.py <cards> <graph.db> <out.json>` | Each lacking call pair by what the calling file's import rows say about the callee |
| `decorators.py <cards> <graph.db> <corpus> <out.json>` | Of the lacking pairs with a top-level callee, how many have the name written as `@name` in the calling file. A text match |
| `n8n.json`, `n8n-decorators.json` | n8n |
| `mast.json`, `mast-decorators.json` | This repository, from the `mast` card of the `14a67bf` build |

The cards the two scripts read are the per-project scorecards `s1/run.mjs` leaves in its work
dir. They are not kept (n8n's are 80 files); `run.mjs` writes them again.

## D152 (`spikes/d152/`)

| File | What it is |
|---|---|
| `n8n-before-the-fix.json` | `s1` on n8n with the scorecard before the fix: 70 wrong, 427 unjudged |
| `scorecard-*.compare.txt` | `compare` of each baseline with the same index scored after the fix |
