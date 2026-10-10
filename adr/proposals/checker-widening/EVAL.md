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

## s10 — calls through a namespace import (`spikes/s10-namespace-imports/`)

Corpora: n8n `9d9e9bf9`, nest `c3bc75c97`, directus `bac54f5` (`api/tsconfig.json`), vscode
`65f2c060` (`src/tsconfig.json`), this repository. All copies with nothing installed.

| File | What it is |
|---|---|
| `sites.mjs <corpus> <out.json> [--workspace-src] <tsconfig>...` | Every call and `new` whose callee is a chain rooted in a module namespace, by how the file got the namespace, how the call is written, what the compiler says is called, and whether that is declared in the imported file. Sites, not pairs. Builds programs, reads no index |
| `n8n.json`, `nest.json`, `directus.json`, `vscode.json`, `mast.json` | Its output: n8n over the six projects of s9, the others over one project each |
| `n8n-after.json` | `s1/run.mjs ... --workspace-src --skip .` over a plain n8n index of the build with the rule. Before is `s6-decorators/n8n-after.json` |
| `vscode-compare.out.txt` | `graph-scorecard.mjs compare` of vscode indexed by the build of `3ca0c9b` and by the build with the rule |
| `vscode-cards-summary.json` | The counts of the two scorecards, which are 180 MB each and not kept, and the keys newly wrong and newly unjudged |
| `js-beside-dts.sh <work> <mast before> <mast after>`, `js-beside-dts.out.txt` | A module that is `lib.js` with `lib.d.ts`, called through a named and a namespace import and as a tagged template, scored by both builds (D162) |

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

## s11 — two gaps in the scorecard (`spikes/s11-scorecard-gaps/`)

| File | What it is |
|---|---|
| `shapes-old-and-new-scorecard.out.txt` | `compare` of the shapes corpus, one index, scored by the scorecard of `ca3d294` and by the fixed one |
| `vscode-compare.out.txt` | The same for vscode `65f2c060`, the index of the namespace-rule build (before: the card `s10/vscode-cards-summary.json` counts) |
| `n8n-cli-compare.out.txt` | `compare` of the `n8n-cli` baseline of `ca3d294` with the same index scored by the fixed scorecard |

## s12 — a namespace another file exports, withdrawn (`spikes/s12-exported-namespace/`)

| File | What it is |
|---|---|
| `first-attempt.patch` | The attempt as it stood when it was reviewed, a diff of `src/` against `95788fa`. Not applied |
| `n8n-after.json` | `s1/run.mjs ... --workspace-src --skip .` over a plain n8n index of the build with the attempt, scored by the scorecard with D162 and D165 fixed. Before is `s10-namespace-imports/n8n-after.json` |
| `n8n-core-compare.out.txt`, `n8n-cli-compare.out.txt` | `compare` of the two baselines of `95788fa` with that index |

## s13 — a namespace another file exports, with a stored record (`spikes/s13-exported-namespace-row/`)

| File | What it is |
|---|---|
| `n8n-after.json` | `s1/run.mjs ... --workspace-src --skip .` over a plain n8n index of the build as committed. Before is `s10-namespace-imports/n8n-after.json` |
| `n8n-after-before-the-review.json` | The same over the index of the build before the review's changes |
| `n8n-core-compare.out.txt`, `n8n-cli-compare.out.txt` | `compare` of the two baselines of `26ee330` with that index |
| `shapes-compare.out.txt` | `compare` of the shapes baseline of `85eb507` with the one committed |
| `repair-fan-out.mjs`, `lib.mjs`, `repair-fan-out.out.txt` | The reviewer's script: 30 importers of a namespace whose module is missing, resolved, or a plain import, and how many are resolved again after an unrelated rename. As written, with this session's paths in `lib.mjs` (`MAST_DIST` overrides the build) |

## s14 — `ns.a.f()` and receivers typed `ns.T` (`spikes/s14-namespace-members/`)

| File | What it is |
|---|---|
| `members.mjs <corpus> <out.json> [--workspace-src] <tsconfig>...` | Every `ns.a.f()` by what `a` and `f` are, and every method call on a parameter, local or `this.f` whose written type is `ns.T`, by what `T` and the callee are. Sites, not pairs. Builds programs, reads no index |
| `vscode.json`, `n8n.json` | vscode `src/tsconfig.json`; n8n over the six projects of s9, `--workspace-src` |
| `fixture/`, `fixture.out.txt` | A module with a TypeScript namespace, a class and an interface, called through `import * as lib`: the symbol rows and call edges the build of `2dfc454` stores |


## s15 — every call by what its callee is (`spikes/s15-callee-kinds/`)

| File | What it is |
|---|---|
| `callee-kinds.mjs <corpus> <out.json> [--workspace-src] [--node-next] <tsconfig>...` | Every call expression by the declaration of the signature the compiler resolved: kind, how the call is written, distinct callees, and for a member of an interface how many classes name the interface in an `implements` clause. Sites, not pairs. Builds programs, reads no index. vscode needs `--max-old-space-size=12000`, n8n `14000` |
| `vscode.json`, `n8n.json`, `nest.json`, `mast.json`, `directus.json` | vscode `src/tsconfig.json`; n8n over the six projects of s9, `--workspace-src`; nest the root `tsconfig.json`; this repository `tsconfig.json` and `tsconfig.test.json`; directus `api/tsconfig.json`, `--workspace-src --node-next` |
| `directus-config-not-read.json` | directus without `--node-next`, kept to show the fallback is not what leaves 65% of its calls without a declaration |
| `summary.mjs <result.json>...`, `summary.txt` | The table of the proposal, derived from the five results |
| `fixture/`, `fixture.out.txt` | One callee of each kind and a call of each: the symbol rows and edges the build of `336cc6a` stores |

## s16 — a row for each method of an interface (`spikes/s16-interface-method-rows/`)

| File | What it is |
|---|---|
| `patch.diff` | The spike's change on a scratch copy of `8647855`: the extractor stores `Interface.method`, and the scorecard keys a method of a top-level interface. Not applied to this tree |
| `index-both.sh <base build> <patched build> <corpus> <state prefix>`, `index-<corpus>.out.txt` | One plain index by each build, one after the other: wall time, `graph.db` size, symbols by kind, chunks, edges by type and rule, and the call edges that end on a method of an interface |
| `mast-compare.out.txt`, `nest-compare.out.txt`, `vscode-compare.out.txt` | `graph-scorecard.mjs compare` of the patched scorecard's card over the base index and over the patched one (`run --tsconfig tsconfig.json`; vscode `--tsconfig src/tsconfig.json`, `--max-old-space-size=14000`). Exit 1 each: the new rows are `extra` to a symbol reference that was not widened |
| `n8n-base.json`, `n8n-patch.json` | `s1/run.mjs ... --workspace-src --skip .` from the scratch copy over the two n8n indexes |
| `analyse.mjs <base card> <patched card>`, `<corpus>-analysis.out.txt` | The call pairs that changed bucket, by how the call is written and the rule that stored the edge; for each newly wrong edge, the target the compiler has for the same caller and method name |
| `vscode-newly-wrong.txt` | The 180 keys |

## s17 — a row for each method of an interface, built (`spikes/s17-interface-method-rows-built/`)

| File | What it is |
|---|---|
| `run-all.sh <mast repo> <scratch dir> <n8n copy> <nest copy> <vscode copy>` | Indexes the shapes corpus, this repository, n8n, nest and vscode with the repo's `dist/` and scores each (`graph-scorecard.mjs run`; n8n also over 80 projects with `s1-cost-yield/run.mjs`). Writes to the scratch directory only |
| `index-and-score-<corpus>.out.txt` | The index line and the scorecard's printed card for each. Paths are written `$T` (the scratch directory) and `$R` (this repository) |
| `shapes-compare.out.txt`, `mast-compare.out.txt`, `n8n-core-compare.out.txt`, `n8n-cli-compare.out.txt` | `graph-scorecard.mjs compare` of each new card with the baseline it replaced. shapes exits 1 for the accepted edge on a narrowed receiver and for the fixture's merged class and interface, a key with two rows; this repository for an import of the s14 fixture that is newly `unjudged` |
| `n8n-80.json` | The 80-project union. Its base is `s16-interface-method-rows/n8n-base.json` |
| `nest-analysis.out.txt`, `vscode-analysis.out.txt` | `s16-interface-method-rows/analyse.mjs <s16 base card> <new card>`: the call pairs that changed bucket. The base cards were made by s16's patched scorecard over the index of `8647855` and are not kept |
