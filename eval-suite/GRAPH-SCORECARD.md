# Graph scorecard

`graph-scorecard.mjs` scores every kind of thing mast stores about TypeScript against the
TypeScript compiler, one line item per kind. It is run after each change to the graph, and
`compare` shows what the change did to every line item, key by key.

The reference is the compiler API. The script imports no mast code and does not use
`mast index --checker`, which resolves through mast's own symbol and import rows.

## Use

```
# 1. Build the change, then index the corpus with it, into a state directory of its own.
pnpm build
MAST_STATE_DIR=<state> node dist/cli/index.js index          # run from the corpus root

# 2. Score that index.
node eval-suite/graph-scorecard.mjs run --root <corpus> --tsconfig <tsconfig.json> \
     --db <state>/graph.db [--prefix <dir/>] [--workspace-src] --label "<build and corpus>" \
     --out eval-suite/out/<name>.json

# 3. Compare with the committed baseline. Exit 1 if anything that agreed was lost, or
#    anything is newly wrong, unjudged or extra, or the two are not of the same corpus.
node eval-suite/graph-scorecard.mjs compare eval-suite/baselines/<name>.json eval-suite/out/<name>.json
```

When a change is accepted, its scorecard replaces the baseline in the same commit, so the
baseline is always the graph of the commit it sits in.

The baselines are plain JSON with one key per line, not compressed, so that git stores each
new version as a difference from the last. A compressed file shares nothing with the one
before it. The cost is in the checkout, where `n8n-cli.json` is 20 MB. `run` and `compare` still read and write `.json.gz` when a path ends
that way.

| Baseline | Corpus | `run` arguments |
|---|---|---|
| `baselines/mast.json` | this repository | `--root . --tsconfig tsconfig.json` |
| `baselines/n8n-core.json` | n8n `9d9e9bf9`, whole monorepo indexed, `packages/core` scored | `--tsconfig packages/core/tsconfig.json --prefix packages/core/ --workspace-src` |
| `baselines/n8n-cli.json` | the same index, `packages/cli` scored | `--tsconfig packages/cli/tsconfig.json --prefix packages/cli/ --workspace-src` |
| `baselines/shapes.json` | `fixtures/resolver-shapes/`, indexed from that directory | `--root eval-suite/fixtures/resolver-shapes --tsconfig tsconfig.json --workspace-src` |

`fixtures/resolver-shapes/` is a corpus of shapes the call resolver gets wrong, one
directory under `packages/` for each. The three real corpora had none of them stored as a
wrong edge, which is how they went unseen: a wrong edge is only counted where the corpus
has the shape. Its baseline is therefore not clean, and is not meant to be. It holds the
edges known to be wrong, so that a fix shows as `wrong -> agree` and a new wrong edge
fails. A shape found by review or in use is added here, with the defect's ledger id, in the
commit that files it. The directory is left out of this repository's own index
(`mast.config.json`) and of lint.

| Directory under `packages/` | Ledger row |
|---|---|
| `property-override` | D115 |
| `new-binding` | D116 |
| `dynamic-import-block` | D117 (`user.ts`); D143, a scorecard defect, and D144 (`held.ts`, `arrow.ts`) |
| `static-instance` | D118 |
| `app`, `core`, `ui` | D119 |
| `barrel-private` | D120 |
| `merged-class`, `same-name-rows` | D121 |
| `constructor-callers` | D122 (the stored edges agree; the defect is in `mast_callers`) |
| `local-shadow` | D123 (`use.ts`), D124 (`loc.ts`) |
| `default-beside-star` | D167 |
| `namespace-import` | none: the calls rule 11 of MAST_SPEC §10.3.1 reads, and the ones it must leave (a local, a parameter or a callback parameter with the namespace's name) |
| `js-beside-dts` | D162, a scorecard defect, fixed: an edge to a `.js` file that has a `.d.ts` beside it was counted as wrong |
| `namespace-export` | none: calls through a namespace another file exports, imported and then exported or in the `export * as` form (rule 12), and a member of a member, which is not read and is in the baseline as `lacks` |
| `tagged-template` | D165, a scorecard defect, fixed: a tagged template, bare, through a namespace import and with a tag a constant holds, was `unjudged` |
| `interface-method` | none: calls on a parameter and a field typed as an interface, on an interface above it, and on a class merged with an interface (MAST_SPEC §10.1, the methods of an interface). A receiver narrowed to an interface that declares the method again has its edge on the declared type's method: that is in the baseline as `wrong`, and was accepted (`adr/proposals/checker-widening/PROPOSAL.md`, "A row for each method of an interface, built") |

The n8n copy has to have its workspace packages built, as for the graph-reference spike
(`adr/proposals/graph-reference/spikes/RESULTS.md`). `packages/cli` takes about 15 s and
1.7 GB (measured 2026-10-08: 20.9 s, 1,653 MB peak).

## Buckets

Every key of a line item is in one bucket. A key is a path and a name, never a line or a
row id, so the same thing has the same key in two runs.

| Bucket | Meaning |
|---|---|
| agree | the compiler and mast both have it |
| wrong | mast has it and the compiler puts it somewhere else |
| lacks | the compiler has it and mast does not |
| extra | mast has it and the compiler has nothing there |
| unjudged | mast has it and the compiler cannot say |

`compare` fails on:

- a key that leaves `agree` for another bucket;
- a key that arrives in `wrong`, `unjudged` or `extra`: something mast stores that the
  compiler does not confirm;
- a key gone from both sides (`agree -> absent`) when the two runs scored the same files.
  `meta.corpus_hash` is a hash of every file the tsconfig names under the prefix, so on a
  fixed corpus such as n8n a key cannot leave unless mast lost the file or the symbol it
  was judged by. When the files changed, as this repository's do with every change, the
  move is listed and does not fail;
- two scorecards whose `meta.root`, `tsconfig` or `prefix` differ, or a second scorecard
  that scored no file. `run` itself exits 2 when it scored no file.

Every other move is listed and does not fail: a `lacks` that becomes `agree` is the gain a
change was made for.

## Line items

What mast stores, which tool reads it, and what the scorecard compares. The "read by" column
is from reading `src/graph/queries.ts` and `src/mcp/tools/`, on 2026-10-07.

| Line item | Stored as | Read by | Compared with |
|---|---|---|---|
| `file: indexed` | `files` | every tool | each TypeScript file the tsconfig names under the prefix. A file mast indexes and the tsconfig does not name is not counted |
| `symbol: function` | `symbols`, kind `function` | `mast_signature`, `mast_project_skeleton`, `mast_callers` | top-level function declarations, and top-level variables initialized with an arrow function |
| `symbol: class` | kind `class` | the same | top-level class declarations |
| `symbol: method` | kind `method`, named `Class.member` or `Interface.member` | the same | methods, constructors, getters and setters of a top-level class, and the methods of a top-level interface (since 2026-10-10). A method an interface shares with a class of its name in the file, or with an earlier declaration of the interface, is counted once |
| `symbol: interface` | kind `interface` | the same, and `mast_implementors` | top-level interface declarations |
| `symbol: type` | kind `type` | the same | top-level type aliases |
| `symbol: export` | kind `export`, a marker | `mast_rename_impact` (barrel rows) | each name in `export { ... } from '...'`, and each named import exported by a clause with no `from` |
| `symbol: one key, more than one row` | two declaration rows of one `path:name` | whichever tool looks the name up | nothing: every such key is `unjudged`, and so is every edge with one at either end. A getter and setter of one property are not counted |
| `symbol flag: is_exported` | `symbols.is_exported` | `mast_project_skeleton` | the `export` modifier, or a later `export { name }`; a member is exported when its class is and it is not private |
| `edge: PARENT_OF` | class or interface to member | `mast_callers` (a class's callers include its constructor's), `mast_implementors` | one per member above |
| `edge: EXTENDS` | class or interface to its parent | no tool directly; the resolver follows it for a call of an inherited member (since 2026-10-08), and repair reads it | each `extends` type the compiler resolves to an indexed declaration |
| `edge: IMPLEMENTS` | class to interface | `mast_implementors` | each `implements` type, the same way |
| `edge: RE_EXPORTS (to the declaration)` | marker to the next marker or the declaration | `mast_rename_impact`, and the resolver's chain walk | the declaration the compiler reaches from the exported name; mast's chain is followed to its end first |
| `export * (file to file)` | `re_export_files` | the same | the file each `export * from` resolves to |
| `import: the file it resolves to` | `imports.resolved_path` | `mast_dependencies`, `mast_signature` (parameter types), incremental repair | the file the compiler resolves the specifier to, for each `import` and each `export * as ns from` that is not type-only (mast gives the second an import row, to record what `ns` stands for) |
| `import: named binding` | `imports.symbols` | the same | each name in `import { ... }`, under the name the module exports, and each name destructured from `await import('...')` |
| `edge: POTENTIAL_CALL` | caller to callee, one row per pair | `mast_callers`, `mast_rename_impact` | each call or `new` the compiler resolves to an indexed declaration, per caller |

Two breakdowns of `edge: POTENTIAL_CALL` are printed and kept in the file. They are not
part of the verdict, since they hold the same keys:

- by the label mast stored the edge with (`import`, `same_file`, `field_type`,
  `parameter_type`, `new_expression`, `this_method`, `super_method`, `construction`,
  `static_method`, `checker`);
- by how the call is written (`f()`, `ident.m()`, `this.m()`, `this.field.m()`,
  `super.m()`, `new X()`, `expr.m()`), in the caller's file or another. This is where a
  lacking edge is counted, since an edge mast did not store has no label.

`mast_exports` and the `only_exported` filter of search read `chunks`, not `symbols`
(`src/mcp/tools/exports.ts`, `src/search/fused.ts`). Nothing here scores `chunks`.

## How a call edge is judged

- The caller is the nearest enclosing declaration mast has a symbol for.
- `new X()` reaches `X`'s constructor when the class declares one, and the class otherwise
  (decided 2026-10-07).
- When the name called is a variable, a parameter or a field, the target is the declaration
  of the signature the compiler picked. For `new` with a constructor's signature it is the
  class constructed, by the rule above: `const { X } = await import('./x'); new X()` reaches
  `X.constructor` when `X` declares one and `X` otherwise, not the constructor `X` inherits.
  A variable typed `{ new (): T }` keeps the signature, which is no indexed declaration.
- A tagged template is a call of its tag (D165).
- A declaration in a `.d.ts` (`.d.mts`, `.d.cts`) that has an indexed `.js` or `.jsx`
  (`.mjs`, `.cjs`) beside it stands for the declaration of the same name in that script,
  when mast has one: the script holds the code, and it is the file mast resolves the import
  to. The same for the file an import resolves to (D162). A declaration file with no such
  script, or whose script has no symbol of the name, is kept.
- A stored edge the compiler does not have is `wrong` when every call of that name in the
  caller resolved, and `unjudged` when one did not.

## What has no line item

Counted under "Seen by the compiler and given no line item" in each run, and in `notes` in
the file. mast stores no row for these, so there is nothing to compare:

- enums, namespaces and what a `declare module` or `declare global` block holds,
  `export default <expression>`, top-level variables that are not arrow
  functions, top-level destructuring;
- the name a default or namespace import binds, and imports for side effects (the
  statement's file is scored under `import: the file it resolves to`);
- calls outside any declaration mast has a symbol for, and calls whose callee is not a name
  or a property (`a[b]()`, `f()()`).

Not scored at all: JavaScript and Markdown files, search ranking, chunk contents, line
numbers, and the parameter types `mast_signature` resolves when asked.

## Limits

- The reference is the compiler's, but three of its inputs are mast's rows: a call target
  counts only when mast has a symbol at that `path:name`, the caller is the nearest
  declaration mast has a symbol for, and outside `--prefix` no symbol is scored. A symbol
  mast loses takes its edges out of both sides. On a fixed corpus that now fails as
  `agree -> absent`; on a corpus that changed it does not.
- A key is a path and a name. Two rows of one key cannot be told apart, so they are
  `unjudged` (above) and not scored further.
- `unjudged` holds a stored edge when any call of that name in the caller has no compiler
  symbol (a receiver typed `any`), and also correct edges from syntax the script does not
  visit: decorators that are not calls.
- No tool's answer is scored. `mast_callers` returning nothing for a class merged with an
  interface, and its transitive walk stopping at a class with a constructor, are both
  `agree` here, since the stored edges are right.
- Only `scorecard-lib.mjs` has tests. Nothing pins what `run` reports for a given graph.

- An import the compiler resolves outside the index is `agree` if mast names the same file
  and `unjudged` otherwise. Only an indexed file can be lacking.
- `--workspace-src` maps a workspace package to its source only when the package is under
  `<root>/packages` (at any depth, D152) and has a `src/` directory. A call into a package
  it does not map resolves to build output, and a right edge into its source is then
  scored as wrong. One import on n8n is unjudged for this reason.
- A named import with an alias is compared under the exported name, which is what
  `imports.symbols` holds. The local name is in `imports.aliases` since schema 1.4.0 and is
  not scored.
- The `checker` label does not appear in the baselines: they are indexes built without
  `--checker`.
- Members of a class that is not at the top level of its file are not symbols on either
  side.
