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
     --out eval-suite/out/<name>.json.gz

# 3. Compare with the committed baseline. Exit 1 if anything that agreed was lost or
#    anything is newly wrong.
node eval-suite/graph-scorecard.mjs compare eval-suite/baselines/<name>.json.gz eval-suite/out/<name>.json.gz
```

When a change is accepted, its scorecard replaces the baseline in the same commit, so the
baseline is always the graph of the commit it sits in.

| Baseline | Corpus | `run` arguments |
|---|---|---|
| `baselines/mast.json.gz` | this repository | `--root . --tsconfig tsconfig.json` |
| `baselines/n8n-core.json.gz` | n8n `9d9e9bf9`, whole monorepo indexed, `packages/core` scored | `--tsconfig packages/core/tsconfig.json --prefix packages/core/ --workspace-src` |
| `baselines/n8n-cli.json.gz` | the same index, `packages/cli` scored | `--tsconfig packages/cli/tsconfig.json --prefix packages/cli/ --workspace-src` |

The n8n copy has to have its workspace packages built, as for the graph-reference spike
(`adr/proposals/graph-reference/spikes/RESULTS.md`). `packages/cli` takes about 15 s and
1.4 GB.

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

`compare` fails on a key that leaves `agree` for another bucket, and on a key that arrives
in `wrong`. Every other move is listed and does not fail: a `lacks` that becomes `agree` is
the gain a change was made for, and a key gone from both sides (`agree -> absent`) is the
corpus changing, which this repository's own source does with every change.

## Line items

What mast stores, which tool reads it, and what the scorecard compares. The "read by" column
is from reading `src/graph/queries.ts` and `src/mcp/tools/`, on 2026-10-07.

| Line item | Stored as | Read by | Compared with |
|---|---|---|---|
| `symbol: function` | `symbols`, kind `function` | `mast_signature`, `mast_exports`, `mast_project_skeleton`, `mast_callers` | top-level function declarations, and top-level variables initialized with an arrow function |
| `symbol: class` | kind `class` | the same | top-level class declarations |
| `symbol: method` | kind `method`, named `Class.member` | the same | methods, constructors, getters and setters of a top-level class |
| `symbol: interface` | kind `interface` | the same, and `mast_implementors` | top-level interface declarations |
| `symbol: type` | kind `type` | the same | top-level type aliases |
| `symbol: export` | kind `export`, a marker | `mast_rename_impact` (barrel rows) | each name in `export { ... } from '...'` |
| `symbol flag: is_exported` | `symbols.is_exported` | `mast_exports`, `mast_project_skeleton`, search ranking | the `export` modifier, or a later `export { name }`; a member is exported when its class is and it is not private |
| `edge: PARENT_OF` | class to member | `mast_callers` (a class's callers include its constructor's), `mast_implementors` | one per member above |
| `edge: EXTENDS` | class or interface to its parent | no tool; no query reads a stored row | each `extends` type the compiler resolves to an indexed declaration |
| `edge: IMPLEMENTS` | class to interface | `mast_implementors` | each `implements` type, the same way |
| `edge: RE_EXPORTS (to the declaration)` | marker to the next marker or the declaration | `mast_rename_impact`, and the resolver's chain walk | the declaration the compiler reaches from the exported name; mast's chain is followed to its end first |
| `export * (file to file)` | `re_export_files` | the same | the file each `export * from` resolves to |
| `import: the file it resolves to` | `imports.resolved_path` | `mast_dependencies`, `mast_signature` (parameter types), incremental repair | the file the compiler resolves the specifier to |
| `import: named binding` | `imports.symbols` | the same | each name in `import { ... }`, under the name the module exports |
| `edge: POTENTIAL_CALL` | caller to callee, one row per pair | `mast_callers`, `mast_rename_impact` | each call or `new` the compiler resolves to an indexed declaration, per caller |

Two breakdowns of `edge: POTENTIAL_CALL` are printed and kept in the file. They are not
part of the verdict, since they hold the same keys:

- by the label mast stored the edge with (`import`, `same_file`, `field_type`,
  `parameter_type`, `new_expression`, `this_method`, `super_method`, `construction`,
  `static_method`, `checker`);
- by how the call is written (`f()`, `ident.m()`, `this.m()`, `this.field.m()`,
  `super.m()`, `new X()`, `expr.m()`), in the caller's file or another. This is where a
  lacking edge is counted, since an edge mast did not store has no label.

## How a call edge is judged

- The caller is the nearest enclosing declaration mast has a symbol for.
- `new X()` reaches `X`'s constructor when the class declares one, and the class otherwise
  (decided 2026-10-07).
- When the name called is a variable, a parameter or a field, the target is the declaration
  of the signature the compiler picked: `const { X } = await import('./x'); new X()` reaches
  `X`.
- A stored edge the compiler does not have is `wrong` when every call of that name in the
  caller resolved, and `unjudged` when one did not.

## What has no line item

Counted under "Seen by the compiler and given no line item" in each run, and in `notes` in
the file. mast stores no row for these, so there is nothing to compare:

- enums, namespaces, `export default <expression>`, top-level variables that are not arrow
  functions, top-level destructuring;
- default imports, namespace imports, imports for side effects;
- calls outside any declaration mast has a symbol for, and calls whose callee is not a name
  or a property (`a[b]()`, `f()()`).

Not scored at all: JavaScript and Markdown files, search ranking, chunk contents, line
numbers, and the parameter types `mast_signature` resolves when asked.

## Limits

- An import the compiler resolves outside the index is `agree` if mast names the same file
  and `unjudged` otherwise. Only an indexed file can be lacking.
- `--workspace-src` maps a workspace package to its source only when the package has a
  `src/` directory. One import on n8n is unjudged for this reason.
- A named import with an alias is compared under the exported name, which is what mast
  records. That record is D106; when it is fixed this line item changes with it.
- The `checker` label does not appear in the baselines: they are indexes built without
  `--checker`.
- Members of a class that is not at the top level of its file are not symbols on either
  side.
