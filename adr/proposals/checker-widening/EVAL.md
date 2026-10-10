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

## P1, after the fix

| File | What it is |
|---|---|
| `s3-existing-pass-on-n8n/after-the-fix/pass.out.txt`, `time.txt` | `run.sh` on n8n with the fixed pass: exit 0, the counts, `time -l`, and the load averages |
| `s3-existing-pass-on-n8n/after-the-fix/caller-span.out.txt`, `checker-edges.json` | `caller-span.sql` and `classify-checker-edges.py` on that index |
| `s1-cost-yield/n8n-after-the-fixed-pass.json` | `s1` over that index, root project skipped |
| `s1-cost-yield/n8n-second-run.json` | `s1` over the plain index a second time, for timing; under load, see its `note` |
| `s2-checker-edge-lifetime/repro.after-the-fix.out.txt` | `repro.sh` on the fixed build |
| `s5-root-project/owners.mjs <corpus>`, `n8n.json` | Which project each file is given to, by discovery order and by the nearest tsconfig. Builds no program |

## s6 — decorators, and P2 (`spikes/s6-decorators/`)

Second corpus: nest `c3bc75c97` (a copy, no `node_modules`). Its root `tsconfig.json` maps
`@nestjs/*` to `packages/*` with `paths` and extends nothing, so the scorecard builds a
reference for it: `--root <nest> --tsconfig tsconfig.json`, one project.

| File | What it is |
|---|---|
| `decorators-by-parse.mjs <cards> <corpus> <out.json>` | Every decorator in every calling file, by a parse, matched to the call pair it is by file, caller name and callee name. Builds no program |
| `n8n.json`, `nest.json` | Before P2: n8n over the cards of the index the fixed pass left (`s1/n8n-after-the-fixed-pass.json`), nest over a plain index of `0cfcfcd` |
| `n8n-still-lacking.json`, `nest-still-lacking.json` | The same script over the cards of the P2 index, without the pass: the decorator pairs still lacking |
| `nest-compare.out.txt` | `graph-scorecard.mjs compare` of nest before and after P2 |
| `n8n-after.json` | `s1/run.mjs` over a plain n8n index of the P2 build, root project skipped |
| `n8n-after-with-the-pass.json` | The same after `mast index --incremental --checker` on that index, by the build with D159 fixed (`run.mjs ... --workspace-src --skip .`) |
| `pass-after-p2/` | `s3/run.sh` on the P2 index: `pass.out.txt`, `time.txt`, `caller-span.out.txt`, `checker-edges.json`, all of the build with D159 fixed |

## D152 (`spikes/d152/`)

| File | What it is |
|---|---|
| `n8n-before-the-fix.json` | `s1` on n8n with the scorecard before the fix: 70 wrong, 427 unjudged |
| `scorecard-*.compare.txt` | `compare` of each baseline with the same index scored after the fix |

## s7 — what P2 costs an index (`spikes/s7-index-cost/`)

| File | What it is |
|---|---|
| `run.sh` | Indexes a corpus from nothing with two builds in turn, several rounds, so both meet the same load |
| `n8n.out.txt` | n8n `9d9e9bf9`, the build of `0cfcfcd` (before P2) against the build after it, three rounds |

## s8 — a corpus with its packages installed (`spikes/s8-installed-packages/`)

| File | What it is |
|---|---|
| `run.sh` | Indexes a copy of nest's `sample/01-cats-app` and scores it with `node_modules` in place and moved aside |
| `cats.out.txt` | Its output |
| `card-with-node_modules.json`, `card-without-node_modules.json` | The two scorecards |

## s9 — the forms P2 does not read (`spikes/s9-decorators-not-read/`)

| File | What it is |
|---|---|
| `what-they-resolve-to.mjs` | Every decorator and call of a corpus, by what the compiler says the callee is: sites, not pairs |
| `nest.json` | nest `c3bc75c97`, its root project |
| `n8n.json` | n8n `9d9e9bf9`, six projects, `--workspace-src` |

## D156 — a caller listed twice (`spikes/d156/`)

| File | What it is |
|---|---|
| `overlap.mjs <state dir> <mast repo with dist/> <out.json> [how many symbols]` | Asks `mast_callers` for the most-called single-declaration top-level names and, for each potential match, whether its chunk holds a verified call and what else it mentions. Reads a copy of the state dir |
| `nest.json`, `n8n.json` | nest `c3bc75c97` and n8n `9d9e9bf9`, 200 names each, the build before the fix |
| `nest-after.json`, `n8n-after.json` | The same indexes, the build with the fix |
