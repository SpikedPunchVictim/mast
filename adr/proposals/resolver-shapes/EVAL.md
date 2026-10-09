# resolver-shapes — eval manifest

**Record:** [`PROPOSAL.md`](PROPOSAL.md). No ADR yet; one is written when the rows are done.

Checks meant to be run again live in `eval-suite/`. Spike scripts and their output stay under
`spikes/`. Nothing here writes into `eval/results/`.

## The instrument for every row

`eval-suite/graph-scorecard.mjs` against the four baselines in `eval-suite/baselines/`, run
as `eval-suite/GRAPH-SCORECARD.md` describes. `shapes.json` holds the wrong edges of these
rows; a fix shows there as `wrong -> agree` or `wrong -> absent`.

## D115 (`spikes/d115/`)

| File | What it is |
|---|---|
| `field-shadows.py <state dir>` | Counts classes with stored fields, the fields, and the fields whose name is a method of a class above along stored `EXTENDS` edges |
| `field-shadows.out.txt` | Its output on this repository, n8n `9d9e9bf9` and the shapes corpus |
| `n8n-edges-vs-0156146.json` | n8n edges of the D115 build against those of `0156146`, by `inherited-call-edges/spikes/s2-found-on-cli/edge-diff.py` |
| `scorecard-*.compare.txt` | `compare` of each baseline with the D115 build |

## D116 (`spikes/d116/`)

| File | What it is |
|---|---|
| `n8n-edges-vs-d115.json` | n8n edges of the D116 build against those of the D115 build, by the same `edge-diff.py` |
| `scorecard-*.compare.txt` | `compare` of each baseline (as of the D115 commit) with the D116 build |

## D117 and D123 (`spikes/d117/`)

| File | What it is |
|---|---|
| `n8n-edges-vs-d116.json` | n8n edges of the D117 build against those of the D116 build, by the same `edge-diff.py` |
| `scorecard-*.compare.txt` | `compare` of each baseline (as of the D116 commit) with the D117 build, scored after the D143 fix |
| `scorecard-n8n-cli.before-d143.compare.txt` | The same for `n8n-cli` before the scorecard fix: exit 1, one right edge counted `wrong` |

The shapes corpus gained `dynamic-import-block/src/arrow.ts` and `held.ts` for D143; they
are in `baselines/shapes.json` from this commit.

## D118 (`spikes/d118/`)

| File | What it is |
|---|---|
| `static-members.sh <graph.db>` | Counts method rows, static ones, and names a file has both a static and an instance method row for |
| `static-members.out.txt` | Its output on n8n `9d9e9bf9`, this repository and the shapes corpus |
| `n8n-edges-vs-d117.json` | n8n edges of the D118 build against those of the D117 build |
| `scorecard-*.compare.txt` | `compare` of each baseline (as of the D117 commit) with the D118 build |

The timings quoted in `PROPOSAL.md` were read off the terminal and are not kept as a file.

## D119 (`spikes/d119/`)

| File | What it is |
|---|---|
| `subpath-drops.mjs <repo dir>` | Replays `sourceOf`'s search for every `exports` subpath of every `package.json` under a directory and prints which leading directories it dropped. Reads only |
| `subpath-drops.<repo>.tsv` | Its output on n8n `9d9e9bf9`, backstage `25463a867ce7`, directus `9dca3724a6`, langchainjs `62fc484b2`, opentelemetry-js `7f3e7eaa9`, strapi `0a8a9b40d0`, and cdk8s, nest, pulumi and vscode (header only: no subpath of the kind) |
| `n8n-import-diff.txt` | n8n import rows of the D119 build against those of the D118 build |
| `n8n-edges-vs-d118.json` | The same for edges |
| `scorecard-*.compare.txt` | `compare` of each baseline (as of the D118 commit) with the D119 build |

## D120 (`spikes/d120/`)

| File | What it is |
|---|---|
| `n8n-edges-vs-d119.json` | n8n edges of the D120 build against those of the D119 build |
| `scorecard-*.compare.txt` | `compare` of each baseline (as of the D119 commit) with the D120 build |

The agreement of `is_exported` with the compiler is read from `eval-suite/baselines/*.json`
(`symbol flag: is_exported`).

## D121 (`spikes/d121/`)

| File | What it is |
|---|---|
| `same-name-census.py` | Counts the rows that share a file and a name, by kind, with each row's edges, and lists call edges whose target is a type row |
| `census-before.*.txt`, `census-after.*.txt` | Its output on the D120 and D121 indexes of this repository, the shapes corpus and n8n |
| `edge-rows-diff.py` | Every edge of two indexes with each end named by file, name, kind and line |
| `edge-rows-vs-d120.*.txt` | Its output, D120 index against D121. The one for this repository is confounded by its own source changing |
| `shapes-before-fix.row-aware-card.json` | The row-aware scorecard run on the shapes index from before the fix |
| `renamed-keys.mjs`, `renamed-keys.*.txt` | For each baseline: the keys that left `agree` and whether each agrees under the same key with a line |
| `scorecard-*.compare.txt` | `compare` of each baseline (as of the D120 commit) with the D121 build |
| `marker-beside-private.txt` | D146 reproduced on the D120 build |

`eval-suite/graph-scorecard.mjs` changed in this row (D147): an end of an edge on a key
with more than one row is `key@line`. It has no test of its own; the four baselines are
what hold it.

## D122 (`spikes/d122/`)

| File | What it is |
|---|---|
| `walk-through-constructor.py` | Runs the transitive walk with and without the step through a constructor, for every symbol called from the row of a class that declares one, and counts the answers that differ and the time of each |
| `walk.*.txt` | Its output on the D121 indexes of this repository, the shapes corpus and n8n |
| `tool-answer.shapes.txt` | `mast_callers target`, transitive, on the shapes corpus with the change built |

No stored edge changes in this row, so the scorecard and its baselines are as they were.

## D124 (`spikes/d124/`)

| File | What it is |
|---|---|
| `local-alias-census.sh` | Counts the alias rows of an index (an exported row sharing file, line and kind with an unexported row of another name) and the edges on them |
| `census.*.before.txt`, `census.*.after.txt` | Its output on the D122 and D124 indexes of this repository, the shapes corpus and n8n |
| `edge-rows-vs-d122.*.txt` | `spikes/d121/edge-rows-diff.py`, D122 index against D124, for the shapes corpus and n8n |
| `scorecard-*.compare.txt` | `compare` of each baseline (as of the D121 commit) with the D124 build |
| `default-reexport.shapes.txt` | D148 as stored: the rows of `barrel3.ts` and `x.ts`, the edges out of `user.ts`, and `reexport_aliases` |

The four baselines are regenerated from the D124 build.

## D148 (`spikes/d148/`)

| File | What it is |
|---|---|
| `default-census.sh` | Counts default exports, default re-exports and default imports in a source tree by form, and in an index the markers whose source is `default` and the rows flagged as a default export |
| `census-before.n8n.txt`, `census-after.*.txt` | Its output on the D124 and D148 indexes |
| `default-reexport-targets.n8n.txt` | What n8n's 254 default re-exports name: a `.vue` file, a package or alias, or a relative module |
| `edge-rows-vs-d124.*.txt` | `spikes/d121/edge-rows-diff.py`, D124 index against D148 |
| `scorecard-*.compare.txt` | `compare` of each baseline (as of the D124 commit) with the D148 build |

The four baselines are regenerated from the D148 build.

## D130 (`spikes/d130/`)

| File | What it is |
|---|---|
| `default-imports.n8n.txt` | Import rows of the D130 n8n index that bind `default`, those resolved, and those resolved to a file with a flagged default export |
| `edge-rows-vs-d148.*.txt` | `spikes/d121/edge-rows-diff.py`, D148 index against D130, before the shapes corpus gained its package |
| `scorecard-*.compare.txt` | `compare` of each baseline (as of the D148 commit) with the D130 build |

`eval-suite/graph-scorecard.mjs` changed in this row: the reference counts a default
import as a binding of `default`. The shapes corpus gained `packages/default-import/`.
The four baselines are regenerated from the D130 build.

## D144 (`spikes/d144/`)

| File | What it is |
|---|---|
| `forms.n8n.txt` | Count of single-line top-level variables in n8n initialized with `function` and with an arrow (grep; the pattern is on each line) |
| `function-rows.txt`, `new-function-rows.n8n.txt` | Function rows in the D130 and D144 indexes, and the rows only the second has |
| `edge-rows-vs-d130.*.txt` | `spikes/d121/edge-rows-diff.py`, D130 index against D144 |
| `scorecard-*.compare.txt` | `compare` of each baseline (as of the D130 commit) with the D144 build |

`eval-suite/graph-scorecard.mjs` changed in this row: a variable holding a function
expression is a function in the reference. The four baselines are regenerated.

## D131 (`spikes/d131/`)

| File | What it is |
|---|---|
| `declaration-imports.mjs`, `declaration-imports.ten.txt` | Relative specifiers the compiler resolves to a declaration file in ten checkouts, what the probe did before, and (with `MAST_DIST`) what the built resolver answers. Reads the checkouts, writes nothing |
| `unresolved-relative.mjs`, `unresolved-relative.n8n.before.txt` | The n8n import rows with no resolved path at D144, by what the compiler makes of each |
| `import-diff.sh`, `import-diff.{n8n,directus}.txt` | Import rows whose resolved path differs between two indexes (D144 against D131 for n8n; the same checkout before and after for directus, commit 9dca3724a6) |
| `edge-rows.directus.txt` | `spikes/d121/edge-rows-diff.py` on the two directus indexes |
| `scorecard-*.compare.txt` | `compare` of each baseline (as of the D144 commit) with the D131 build |

## D139 (`spikes/d139/`)

| File | What it is |
|---|---|
| `repro.sh`, `repro.before.txt`, `repro.after.txt` | Seven imports and one re-export with unusual names, indexed in a work dir: the stored import rows, symbol names, `reexport_aliases`, call edges and `mast_signature` for `p`. Before is commit c5869de. The call-edge query in the before run failed on a column name (`e.type`); it is `edge_type` in the script as committed |
| `alias-diff.sh`, `alias-diff.n8n.txt` | Import rows whose symbols or aliases differ between the D131 and D139 n8n indexes, and counts of names holding a quote |
| `edge-rows-vs-d131.n8n.txt` | `spikes/d121/edge-rows-diff.py`, D131 index against D139 |
| `scorecard-*.compare.txt` | `compare` of each baseline (as of the D131 commit) with the D139 build |

