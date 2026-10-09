# resolver-shapes — the wrong edges of D115 to D124

**Status:** in progress. D115 and D116 are built (2026-10-08). The other rows are open.

Ten ledger rows (D115 to D124) came out of one review pass over the call resolver. Each is a
shape of code where a stored edge names the wrong declaration, or a tool answers wrongly over
right edges. Each has a directory under `eval-suite/fixtures/resolver-shapes/packages/` and
keys in `eval-suite/baselines/shapes.json`. This file records, row by row, what was decided,
on what evidence, and what was not checked. Numbers are in [`spikes/`](spikes/).

## Decisions already made that bind every row

Looked for in `adr/`, `MAST_SPEC.md`, `FINDINGS.md`, `.history/` and the ledger before D115:

1. **Better no edge than a wrong one** (`resolveCallTarget`'s contract; spec §9, "safe to act
   on"). A call that loses its verified edge is still listed under `potential_matches`.
2. **An edge is stored against the declaring symbol** (ADR 007), and a member is found along
   stored `EXTENDS` edges, in the declaring file, never by name across the graph
   (`inherited-call-edges`, M2).
3. **A class with two stored parents gets no walked edge** (`inherited-call-edges`, R2).
4. **A field has no symbol row.** A call in its initializer is stored from the class (D098).
   Nothing found decides that a field should have a row, or that it should not.
5. **Schema 1.4.0 is not released** (tags `v0.2.0` to `v0.4.1` are all 1.3.0), and an index
   of another version is rebuilt (ADR 019). A column added under 1.4.0 reaches every user
   through that rebuild.

## D115 — a field with the name of a method above it

**The defect.** `this.m()`, or `c.m()` on a receiver typed as the class, where the class
declares `m` as a field, a `declare`d property or a constructor parameter property. None of
those has a symbol row, so the class "does not declare `m`", and the walk goes up to the
parent's method.

**What had to be decided.** Where the knowledge "this class has a field `m`" lives. A call in
another file cannot get it from its own syntax tree.

| # | Mechanism | Verdict |
|---|---|---|
| F1 | A symbol row for every field (`kind` `field`) | **Reject.** n8n has 17,117 fields in 4,338 classes (measured, `spikes/d115/field-shadows.out.txt`). Every reader of `symbols` would have to learn to leave them out, and search, skeleton and exports would change for a defect that touches 3 of them |
| F2 | A `fields` column on the class's symbol row: the names, static and instance apart, as JSON | **Built.** Written and deleted with the row; no new write path |
| F3 | A table `class_fields` | **Reserve.** Same content as F2 with a delete path of its own. Worth it only if something needs to query by field name |
| F4 | Decide in the extractor, for `this.m()` only | **Reject.** Leaves `c.m()` in another file wrong: one of the four wrong edges of the fixture |

**The rule built.** The walk returns no edge when the receiver's class, or a class it passes
before finding the method, has a field of the name. A call written on the class (`X.m()`) is
stopped by a static field and every other call by an instance field.

**What an incremental run needed.** A field appearing changes no symbol row, so repair did
not see it: the scenario "the class at the bottom gains a field with the name of an inherited
method" failed until the fields were added to the surface repair compares
(`readExportSurface`). A field on a class between was already found, because re-writing that
class's file removes the `EXTENDS` edge into it.

**Measured** (`spikes/d115/`, build of the D115 commit against the build of `0156146`):

- Shapes corpus: the four wrong `POTENTIAL_CALL` keys of `property-override` are gone, and
  nothing else changed bucket. `compare` exits 0.
- n8n `9d9e9bf9`, 13,985 files: 71,091 edges before and 71,091 after, none gone and none
  added, compared as sets of (from, type, to). `n8n-core` and `n8n-cli` compare exit 0.
- This repository: compare exits 0; the seven added edges are calls in the new code.
- The shape exists outside the fixture: in n8n, 3 fields sit over a method of a class above
  (`getNodeParameter` on three node execution contexts, each assigned in its constructor). No
  stored edge went through any of them, which is why the three scored corpora showed nothing.
- n8n's full index took 86.4 s, one run. `schema-rebuild/spikes/RESULTS.md` has 95.9 s for
  an earlier build on another run, so no cost is visible and none is claimed.

**Judgment calls, open to being reversed:**

- A `declare`d property stops the walk like any field. `declare render: () => void` emits no
  code, so at run time the call may well reach the parent's method; the compiler names the
  child's property as the declaration, and the scorecard follows the compiler. Kept as no
  edge under decision 1.
- `this.m()` inside a static method is read as an instance call. That is part of D118.
- The column was added without a version bump (decision 5). An index built by an earlier
  commit of this branch has `NULL` there and keeps its wrong edges until it is rebuilt. No
  released mast wrote such an index.

**Not checked:** interfaces (a receiver typed as an interface stores no walked edge today, so
there is nothing to stop); a field declared in a class expression; a JavaScript file
(parsed with the same TypeScript grammar, `src/ast/parser.ts`, so inferred to behave the
same; not run); any corpus but n8n, this repository and the fixture.

**Tests.** `src/indexer/__tests__/inherited-method-edges.test.ts`, "a call of a name the class
redeclares as a field" (four cases); three rows in
`src/indexer/__tests__/equivalence-scenarios.ts` ("gains a field…", "gains a parameter
property…"); the column is in `dumpStoredRows`, so every incremental-equals-full comparison
includes it.

## D116 — the first `new` bound to a name types it for the whole function

**The defect.** `collectNewBindings` walked a whole function body and kept the first
`const x = new A()` for the name `x`. A second block that declares `x` again was read by the
first block's class.

**Prior decision.** The spec recorded scope as held per function and its cost as a lost edge
("cannot place one", in the extractor's own comment). For a name hidden from imports that
holds. For a receiver's class it does not: the binding carries a class, so the wrong block's
binding places a wrong edge. Nothing found decides against reading by block.

| # | Mechanism | Verdict |
|---|---|---|
| B1 | Keep a `new` binding only when the name is declared once in the function, as `dynamicImportBindings` does | **Reject.** Removes the wrong edges and the right ones with them; still wrong for a call written after the declaring block |
| B2 | Per call, find the declaration of the receiver in the smallest block, loop, `catch` or nested function around it. A `new` gives its class; anything else gives no edge | **Built** |
| B3 | The same lookup for bare names (`CallSite.locals`), so a call outside the declaring block keeps its import | **Reserve** at D116; **built** with D117, below |

**Measured** (`spikes/d116/`, against the D115 build):

- Shapes corpus: `twoBlocks` and `switchCases` go from a wrong edge to `A.run` to the right
  one to `B.run` (2 `wrong -> absent`, 2 `lacks -> agree`); `twoCallbacks -> Repo.save` goes
  from `unjudged` to absent. `compare` exits 0.
- n8n: 71,091 edges before, 71,092 after. None gone. The one added is
  `Code.execute -> PythonTaskRunnerSandbox.runUsingIncomingItems`
  (`packages/nodes-base/nodes/Code/Code.node.ts:230`). Read by me: two blocks each declare
  `const sandbox`, the first with `new JsTaskRunnerSandbox`, and the old rule read the second
  by the first, found no such method and stored nothing. `nodes-base` is not a scored
  package, so the compiler has not judged this edge.
- `n8n-core` and `n8n-cli`: compare exits 0, no key changed bucket. This repository:
  compare exits 0, and the keys that changed are the calls in the new code.
- The reviewer's unrun claim, that an annotated parameter wins over a later block-local
  `new`, reproduced as a failing test before the fix.

**Left as it was:** a parameter of the function itself is still read from its annotation
through the function-wide table, which is right unless a block declares the name again, and
that case now goes to the block's declaration. The order of statements inside one block is
not looked at: a call above `const x = new A()` in the same block is read as `A`, where the
language throws.

**Not checked:** a `using` declaration; a class or function declared in a block and then
called as a receiver from outside it (it stores no edge either way); cost, beyond n8n's full
index taking 81.9 s on one run against 86.4 s for D115's.

**Tests.** `src/ast/extractors/__tests__/call-edges.test.ts`, "a local bound to `new X()`,
by block (D116)": ten cases, seven of which failed before the change.

## D117 and D123 — a name is read by the declaration in sight of it

**The defects.** D117: a name destructured from `await import()` was recorded for the whole
function, so a call of that name after the block went to the dynamic module, where the
compiler has the static import. D123: the class of `const r = new Repo()` was taken from
the text `Repo`, with no check that a local or a parameter has that name.

**Prior decisions.** Checked `adr/`, `FINDINGS.md` and `.history/` by grep for "dynamic
import" and "await import"; the hits are about import rows, and none decides scope. The
rule in force was the one `e66e9ca` (D110) built and the spec recorded: a dynamic import's
names are read for the outer function only, not from a nested function, and not when the
function declares the name twice. D104 decided that a local hides the import of its name,
per function, at the cost of a lost edge. D101 decided that `new` of a local stores
nothing. None of the three is reversed in what it protects; the first two are narrowed
from the function to the block.

| # | Mechanism | Verdict |
|---|---|---|
| N1 | Keep the per-function table and drop a dynamic binding when a call of the name sits outside its block | **Reject.** Removes the wrong edge and leaves the call after the block with no edge, where the compiler has one |
| N2 | One lookup for every name: the declaration in the smallest block, loop, `catch` or nested function around the place the name is written (D116's `visibleDeclaration`). A declaration destructured from `await import()` carries its module; any other hides the file's imports; none in sight leaves the name to the function's own parameters, then the file | **Built.** `CallSite.locals`, `declaredLocals` and `dynamicImportBindings` are removed |
| N3 | For D123 only, ask the per-function locals whether the class name is one | **Reject.** A second table that disagrees with N2 in a function where another block declares the name |

**Measured** (`spikes/d117/`, against the D116 build):

- Shapes corpus: `main -> remote.ts:run` (wrong) is gone and `main -> local.ts:run` is
  stored (`lacks -> agree`); both `Repo.find` keys of `local-shadow` go from `unjudged` to
  absent. `compare` exits 0.
- n8n: 71,092 edges before, 71,112 after. None gone, 20 added: 11 `import`, 5
  `construction`, 3 `new_expression`, 1 `static_method`. All 20 are in
  `n8n-edges-vs-d116.json`.
- 17 of the 20 are in `packages/cli`, and the compiler has all 17 (`lacks -> agree` 16,
  `absent -> agree` 1). The other three are in `@n8n/agents` and `@n8n/mcp-browser`, which
  are not scored; read by me, each is a call of a name destructured from `await import()`
  one or two lines above it (`model-token-counter.ts:9-10`, `connection.ts:209-210`,
  `tabs.ts:98-99`).
- Where the 20 come from, by reading the sites: a dynamic import inside a nested function
  or callback, and a name two blocks of one function each take from a dynamic import
  (`connection.ts:209` and `:220`). Both were left out on purpose by the earlier rule.
  I did not class all 20 one by one.
- `n8n-core`: no key changed. This repository: the keys that changed are calls in the
  changed code.

**A defect in the instrument, found here (D143).** The first run had `compare` exit 1 for
`n8n-cli` with one edge newly `wrong`: `setupTestServer -> public-api/index.ts:
loadPublicApiVersions`. The source has the edge right. The scorecard's reference had no
key for a `const` arrow reached through a destructured name. Fixed in
`eval-suite/graph-scorecard.mjs` and reproduced in the shapes corpus (`held.ts`, `arrow.ts`)
before the fix. The first run's output is kept as
`scorecard-n8n-cli.before-d143.compare.txt`.

**Judgment calls.**

- A name the file neither imports nor declares is still kept as the class of
  `const r = new X()`, as before; whether `X.m` is a symbol is settled when the edge is
  stored. Only a local or a parameter of that name removes the class.
- Reading a dynamic import from a nested function reverses the earlier "not entered". It
  is what N2 does with no special case, and the 17 scored edges agree.

**Not checked:** statement order inside a block (a call above the `const { run } = await
import()` of its own block is read by it); a named function expression's own name; an
incremental run after an edit to a module that only a nested function imports dynamically
(inferred to work, since import rows are written for every such declarator in the file and
the existing incremental test covers the outer-function case); cost, beyond n8n's full
index taking 73.5 s and 72.9 s on two runs.

**Tests.** `call-edges.test.ts`, "a name declared in a block, read by block (D117, D123)":
nine cases, six of which failed before the change. `dynamic-import-edges.test.ts`: the case
that stored nothing for a name declared twice now expects the edge from the block that
imports it.

## D118 — a static and an instance member of one name

**The defect.** A member is stored as `Class.name` whether or not it is static, and every
lookup took the first row of that name. `K.make()` went to an instance `make` on `K` where
the compiler has the static on the class above; `k.save()` and `this.save()` went to a
static `save` on `K`.

**Prior decisions.** The inherited-member walk (`adr/proposals/inherited-call-edges/`, built in
`94d7566`; static calls on a class in `5497f3a`) stops at the first class with a member of
the name. D115 added the two sides for fields
(`symbols.fields`) and recorded that `this.m()` in a static method is read as an instance
call, "part of D118". Schema 1.4.0 is unreleased, and `symbols.fields` was added to it
without a version bump; the same is done here. Nothing found decides against a flag on the
row.

| # | Mechanism | Verdict |
|---|---|---|
| S1 | A second name form for statics (`Class.static.name` or the like) | **Reject.** The name is what `mast_search`, `mast_signature` and `mast_callers` are asked with |
| S2 | List a class's static method names on the class row, beside its fields | **Reject.** A class that declares a static and an instance method of one name has two rows of that name, and a list on the class cannot say which row is which (4 such names in n8n) |
| S3 | `symbols.is_static` on the method's row. Each lookup of `Class.member` for a call is kept to one side: statics for `X.m()` and for `this`/`super` in a static method, instance methods for everything else. The extractor marks a `this`/`super` call written in a static method (`EdgeRecord.inStaticMethod`) | **Built** |
| S4 | Add the flag to what incremental edge repair compares, as D115 did for fields | **Built, after first being held in reserve wrongly (D145).** The first scenario written for it passed without it, and I took that as showing repair needed nothing. It passed because its caller is typed as a subclass declared in another file: rewriting the class's file removes the subclass's `EXTENDS` edge, the subclass counts as one whose parents changed, and its importers are resolved again (with `classesWithChangedParents` made to return nothing the scenario fails). A caller on the class itself has no such path: three scenarios without a class between fail on `1260a97` and pass with the flag in the surface |

**Measured** (`spikes/d118/`, against the D117 build):

- Shapes corpus: the three wrong edges are gone and the three the compiler has are stored
  (3 `wrong -> absent`, 3 `lacks -> agree`). `compare` exits 0.
- n8n: 71,112 edges before and after, none gone, none added. The edge diff names a target
  by file and name, so a move between a static and an instance method of one name in one
  class would not show in it; n8n has 4 such names (`static-members.out.txt`), and I did
  not look at the calls of those four.
- n8n has 17,690 method rows, 317 of them static.
- `n8n-core`, `n8n-cli`: no key changed. This repository: the keys that changed are calls
  in the changed code.

**Cost: not established.** n8n's full index, old build against new, alternating, on a
machine with a load average between 7 and 12 from other work: old 83.1, 91.2, 84.4 and
111.2 s; new 92.9, 102.6, 99.4 and 92.5 s. The medians are 87.8 and 96.2 s and the ranges
overlap. The change adds one comparison to lookups that already ran and one column to
each symbol row; I know of no reason for a tenth more time, and these runs cannot rule it
out. To be run again on a quiet machine.

**Judgment calls.**

- A row written before the column existed has `NULL` and is read as an instance method, so
  an index built by an earlier commit of this branch keeps its answers for static calls
  wrong (no edge to a static) until it is rebuilt. Same position as `symbols.fields`.
  Measured on a one-file project with the column set to `NULL` and the call edges
  deleted: `mast index --incremental` skips the file and leaves both as they were;
  `mast index` rewrites the file and restores the flag and the edge. `mast_reindex`
  and the server's watcher run the incremental pass unless asked for a full one.
- `this.x.m()` in a static method is still read through the class's field types, static
  or not.
- An accessor (`static get x()`) is a method row with the flag like any other.

**Not checked:** an interface's or an abstract class's members; a static block; JS files;
`mast_callers` asked about `K.m` when `K` has both sides (it is asked by name and returns
the callers of both rows, which is D121's subject).

**Tests.** `src/indexer/__tests__/inherited-method-edges.test.ts`, "a static and an
instance member of one name": four cases, all failing before the change. One scenario in
`equivalence-scenarios.ts` (a static method between the receiver and the inherited one
becomes an instance method and back), which passes with or without S4, and three more
with no class between the changed one and the caller, which fail without it (D145).

## D119 — a subpath export resolved to the package's root entry

**The defect.** `@x/core` exports `./testing` as `./dist/testing/index.js`; its source is
`testing/index.ts`, outside `src/`. `sourceOf` replaces the first directory by `src` and
then drops leading directories until a file exists, so it tried `src/testing/index`,
then `src/index`, and took the root entry. The import and the call through it were stored
against `core/src/index.ts`, which has its own `setup`.

**Prior decisions.** D100 (`612f962`; `adr/proposals/graph-reference/spikes/RESULTS.md`)
introduced the mapping from build output to source and the dropping of directories, for
`dist/cjs/index.js` and `dist/esm/index.js` in n8n. It reads no `outDir` or `rootDir` on
purpose. Nothing recorded limits which directories may be dropped.

**Spike** (`spikes/d119/subpath-drops.mjs`, a replay of `sourceOf`'s search over every
`exports` subpath of every `package.json`; read-only). Ten repositories, 1,240 subpath
targets that are not already a TypeScript source and are not patterns:

| | Targets |
|---|---|
| No source found under `src/` | 343 |
| Found by replacing the first directory | 847 |
| Found after dropping more than one directory | 50 |
| ...of which the dropped directories are the directory of one of the package's root entries | 50 |
| ...of which the file found is the package's `src/index` | 0 |

The 50 are `dist/esm` (22) and `dist/cjs` (11) in n8n, and `build/src` (9), `build/esm`
(4) and `build/esnext` (4) in opentelemetry-js. backstage, directus, langchainjs and
strapi have subpaths and none that drops more than one directory; cdk8s, nest, pulumi and
vscode have no subpath of the kind. So no package in the ten shows the defect as a wrong
answer. One in n8n has its shape and is saved by having no `src/index.ts`:
`@n8n/n8n-nodes-langchain` `./mcp/core` to `./dist/nodes/mcp/McpTrigger/index.js`.

| # | Mechanism | Verdict |
|---|---|---|
| R1 | A subpath may not lose a directory its own key names (`./testing`) | **Reject.** Leaves `./testing` to `dist/test-utils/index.js` wrong |
| R2 | A subpath may not resolve to the root entry's source | **Reject.** Guards the one landing place; `./a` to `dist/x/y.js` with a `src/y.ts` is the same defect |
| R3 | A closed list of format directory names (`cjs`, `esm`, ...) | **Reject.** The list is what the ten repositories happen to use |
| R4 | For a subpath, more than the first directory is dropped only when what is dropped is the directory of one of the package's root entries | **Built.** Keeps all 897 targets the spike finds a source for |
| R5 | Read `outDir` and `rootDir` from the build's tsconfig | **Reserve.** D100 declined it; nothing measured here asks for it |

Root entries are resolved as before: the rule is for subpaths only, since a root entry's
directory is by definition one of the directories the rule allows.

**Measured** (`spikes/d119/`, against the D118 build):

- Shapes corpus: the wrong import row and the wrong edge are gone and the ones the
  reference has are stored (import: 1 `wrong -> absent`, 1 `lacks -> agree`; call edge the
  same). `compare` exits 0.
- n8n: 51,963 import rows before and after, 8,095 unresolved both times, no row differs
  (`n8n-import-diff.txt`). 71,112 edges before and after, none gone, none added.
- `mast`, `n8n-core`, `n8n-cli`: `compare` exits 0.

**Judgment calls.**

- A subpath whose target has no source now falls to `<packageDir>/<sub>` and
  `<packageDir>/src/<sub>`, and failing those the import is stored as external with no
  path, as any unresolved workspace import was before.
- The right file for the fixture is `testing/index.ts` because the fallback finds a
  directory of the subpath's name at the package root. A package whose `./testing` is
  built from somewhere else gets no path, not that one.

**Not checked:** `exports` patterns (`./*`), which are still not read; a package whose root
entry is built into a directory its subpaths are not (`dist/index.js` beside
`dist/esm/sub.js`): the subpath would lose its edge, and none of the ten repositories
has one; npm and yarn workspaces.

**Tests.** `src/indexer/__tests__/import-resolver.test.ts`, three cases under "a workspace
package whose entry points are build output": two failing before the change (both
resolved to `src/index.ts`), one pinning a subpath built into the root entry's format
directory.

## D120 — a private declaration taken for the name an import means

**The defect.** `barrel.ts` declares private `helper`, `format` and `Client` and has
`export * from './real'`. An import of those names from `./barrel` was placed on the
barrel's own declarations: the lookup in the imported file took any row of the name that
is not a re-export marker and did not read `is_exported`. The same held behind a star:
of two files a barrel stars, a private declaration in the first took the name from the
exported one in the second.

**Prior decisions.** The order of the lookup (a declaration in the file, then a named
re-export there, then the files its stars reach) is D086's and stays. D094 fixed which of
two files behind stars is chosen (lowest path) and stays. Nothing recorded says a private
declaration should be accepted; "the file the import resolves to declares the name" was
the whole rule before barrels were followed.

**Is `is_exported` fit to decide on?** Measured, from the committed baselines: the
scorecard's `symbol flag: is_exported` line agrees with the compiler on every symbol it
scores and is wrong on none: 823 in this repository, 95 in the shapes corpus, 888 in
n8n `packages/core`, 12,824 in n8n `packages/cli`.

| # | Mechanism | Verdict |
|---|---|---|
| P1 | The lookup of an imported name accepts a declaration only when its row is exported, in the imported file and in every file reached through `export *` | **Built** |
| P2 | Prefer an exported declaration and fall back to a private one when nothing exports the name | **Reject.** The fallback is an edge to something the import cannot mean; better no edge than a wrong one |
| P3 | The exported flag in what incremental edge repair compares | **Built.** A declaration that gains or loses `export` keeps its name and kind. The scenario for it fails without this, after P1 |

All four callers of the lookup go through the one function
(`resolveInFileOrReExportChain`): call edges placed by an import, `RE_EXPORTS` edges,
structural edges, and `mast_signature`'s type context.

**Measured** (`spikes/d120/`, against the D119 build):

- Shapes corpus: the four wrong edges into `barrel.ts` are gone and the four the
  reference has in `real.ts` are stored (4 `wrong -> absent`, 4 `lacks -> agree`).
  `compare` exits 0.
- n8n: 71,112 edges before and after, none gone, none added. So nothing in n8n relied on
  a private declaration, and nothing there has this defect either.
- `mast`, `n8n-core`, `n8n-cli`: `compare` exits 0.

**Not fixed here:** the fifth wrong key the ledger row counts,
`use2 > barrel2.ts:fmt2`, is `export { internalFmt as fmt2 }` with no `from`, which is
D124.

**Not checked:** a CommonJS file (`module.exports = { f }`), whose declarations are
whatever the extractor marks them; n8n losing no edge says its indexed files do not
depend on it, and no other corpus was indexed. `export =`. A `declare` in a `.d.ts`.

**Tests.** `src/indexer/__tests__/reexport-shapes.test.ts`, "a private declaration with
the name of an import": three cases, all failing before the change. One scenario in
`equivalence-scenarios.ts` ("a private function in a barrel, of a name its `export *`
supplies, is exported, and made private again"), which passes before P1, fails with P1
alone and passes with P3.


## D121 — two declarations of one name in a file

**The defect.** A symbol row was addressed by file and name everywhere, and a file can
declare one name more than once. A record's source row was the last row of its name the
query returned; a target was the first. So the calls in a static `make` were stored on
the instance `make` below it, a getter's on its setter, an interface's `extends` on the
class it merges with, and a call of `Handler` went to `type Handler` and not to
`const Handler`. `PARENT_OF` reached the first row of a member's name only.
`mast_callers` and `mast_rename_impact` answered for the first row of the name.

**Prior decisions.** None fixes one row per name. `adr/proposals/graph-reference/PROPOSAL.md`
lists declaration merging as an open judgment about the reference; its spike script
treated same-named rows as one symbol at the lowest line. The inherited-call work held
"a class and an interface of one name are one symbol with two parents" and gave no edge
(`inherited-method-edges.test.ts`); that test's premise is changed here and said so
below. D118 already told a static member from an instance one as a target.

**How common** (`spikes/d121/census-before.*.txt`, measured on the D120 indexes):

| Corpus | Declaration rows | Groups sharing a file and a name | What they are |
|---|---|---|---|
| this repository | 823 | 0 | |
| shapes corpus | 100 | 5 | 2 static + instance, 1 getter + setter, 1 class + interface, 1 function + type |
| n8n `9d9e9bf9` | 49,788 | 15 | 10 getter + setter, 4 static + instance, 1 interface + interface |

No function overload has a row of its own (no `function + function` group in any).

| # | Mechanism | Verdict |
|---|---|---|
| R1 | Every record carries the line of the declaration it comes from, and `PARENT_OF` the line of the member; the row is the one of that name on that line | **Built.** The extractor has the node, and the symbol's line is the same node's |
| R2 | When the line has no row of the name, the record is on the row of the name if there is one only, and on none if there are two | **Built, after first being rejected.** I had no fallback at all, on the measurement below that the lines never disagree on a full index. The review reproduced where they do: see "A file parsed again without being written" |
| R3 | A name lookup is told what the use means, a value (call, `new`, a class's `extends`) or a type (`implements`, an interface's `extends`, a parameter's type), and takes a row of that meaning first | **Built** |
| R4 | A call takes a value row or nothing | **Reject, measured.** 27 call edges on n8n end on a `type` row because the value beside it is `export const X = lazyClass(...)`, which has no row. The compiler's target for each is that constant, and the scorecard counts the edge as agreeing because the constant and the type share a file and a name; it compares no row there. R4 removes all 27 |
| R5 | A `RE_EXPORTS` record is on the marker of its name | **Built** (D146, found while testing R1) |
| R6 | A tool asked about a name answers for every row of it in the file of the first | **Built**, for verified callers and the re-exports `mast_rename_impact` lists |
| R7 | The scorecard names an end of an edge by row where the key has more than one | **Built** (D147). It had these edges `unjudged`, and a getter and setter pair as one key |

**Measured** (`spikes/d121/`, against the D120 build):

- Shapes corpus, every edge by row (`edge-rows-vs-d120.shapes.txt`): 80 edge rows
  before, 83 after. Five moved to the row they belong to (the interface's `extends`, two
  constructions and one call out of a static `make`, `top2 -> Handler` from the type to
  the function) and three `PARENT_OF` edges are new, to second rows that had none.
- n8n (`edge-rows-vs-d120.n8n.txt`): 71,112 edge rows before, 71,126 after. No edge is
  gone. Six call edges moved from a setter's row to the getter's, and I read all six
  call lines in the source: each is inside the getter. Fourteen `PARENT_OF` edges are
  new, one for the second row of each of the 14 method pairs.
- So over 71,112 edges of a full index the record's line and the symbol's line never
  disagreed.
- Scorecard, row-aware, on the shapes index from before the fix
  (`shapes-before-fix.row-aware-card.json`): it now reports the interface's `extends`
  `wrong`, three `PARENT_OF` and four call edges `lacks`, `top2 > Handler@6` `wrong`,
  and three call edges on the wrong row of `K.make` `unjudged`. On the fixed index none
  of those remain; what is left outside `agree` is D124's two wrong edges and the two it
  lacks, and two more `lacks` in `barrel-private` that predate this row.
- `compare` against the baselines of the D120 commit exits 1 for `shapes` and `n8n-cli`
  and 0 for `mast` and `n8n-core`. The failures are keys that gained a line:
  `renamed-keys.mjs` finds 2 and 11 keys that left `agree`, each agreeing under the same
  key with a line, and none without. The baselines are replaced in this commit.

`edge-rows-vs-d120.mast.txt` is not a clean comparison: this repository's own source
changed between the two indexes. It has no group of this kind.

**Judgment calls.**

- R4's rejection keeps an edge whose target row is a type when the value has no row.
  The row is the wrong one of the two declarations and the name is right.
- A class merged with an interface is two rows with their own parents. A call on a
  value of the name follows the class's parent only. `inherited-method-edges.test.ts`
  had a case expecting no edge there; it now expects the edge the class's parent gives,
  and the no-edge case is an interface that extends two.
- On the reference side the scorecard keeps the declarations of the meaning the use has
  (`declsOfMeaning`) and, for a called accessor, the getter. That mirrors mast's rule
  with the compiler's own distinction between the value and the type of a name.

**Not fixed here:** `mast index --checker` picks the first row of a name for the caller
of a call site (`src/graph/checker-resolver.ts`, `querySymbolByName(...)` destructured to
its first element), and potential matches and checker verdicts are still asked for one
row. Two declarations of a name on one line share a line, and the edge is on whichever
the map kept, as before.

**A file parsed again without being written.** Edge repair parses a holder for its
records and leaves its rows as they are. I had this down as inferred and harmless. The
review pass reproduced it as a regression, and I reproduced it again as a test: `z.ts`
calls `leaf` and `other`; a comment line is added at the top of `z.ts` on disk; `a.ts`
is edited and refreshed for a read (`jitRefreshFile`). With no fallback, `z.ts` lost
both edges, the one into `o.ts` included, until its own refresh. With R2 as built the
edges stay. A name with two rows in such a file gets no edge when the line matches
neither, and the wrong row when the shift puts one declaration on the line the other
had; the second is not fixed and lasts until the file's own write.

**From the review pass** (a subagent briefed to break the change; each item below I
either reproduced or mark as its reading):

- The regression above. Reproduced, fixed, two cases in `same-name-rows.test.ts`.
- Its reading, not run by either of us: `--checker` and the checker verdicts of a tool
  answer still take one row (listed under "Not fixed here").
- The scorecard's `lineOfDecl` differs from mast's line for `@D()` on the line above an
  unexported class, `export` on a line of its own above `@D() class`, and `export` on a
  line of its own above `const`. It reproduced these with a copy of the function. They
  matter only for a key with more than one row, and show as `lacks` beside `extra`, not
  as a false `agree`. Not fixed.
- It found no declaration form where the record's line and the row's differ on a full
  index (decorated classes and methods, default exports, abstract classes, overloads, a
  400-line function, `.js` and `.tsx`), no case where preferring a meaning gives a wrong
  edge the old code got right, and no incremental run that differs from a full one.
  `.mjs` and `.jsx` gave it no rows and are unchecked.
- A call on an accessor (`k.v()`) goes to the first of the getter and setter by line;
  the reference says the getter. Not changed.

**Tests.** `src/indexer/__tests__/same-name-rows.test.ts`: eleven cases on stored
edges, each end named by line (`expectEdgeRows`), ten failing before the change; four
on what a tool answers, three failing before; two on a file whose lines moved on disk,
both failing with R1 alone. Three cases in
`src/graph/__tests__/resolve-types.test.ts` for a parameter's type, all failing before.
Two scenarios in `equivalence-scenarios.ts`; both pass before and after, because a full
index was wrong in the same way, and they hold only that the two stay equal. The
comparison they use now names each end of an edge by line.

## D122 — transitive callers stop at a class that declares a constructor

**The defect.** `new X()` is stored on `X.constructor` when X declares one (decided
2026-10-07), and a call in a field initializer is stored from the class row. Asked
directly about a class, `queryVerifiedCallers` adds the constructor's callers. The
recursive step did not: it followed callers of the class row only, so a walk that
reached a class through its initializer ended there. On the shapes corpus
`mast_callers target` with `transitive: true` answered `WithCtor`, `NoCtor`, `makeNo`,
and not `makeWith`. Every stored edge is right; the answer was wrong.

**Prior decisions.** The construction decision above, which this keeps. I found nothing
in `adr/`, `FINDINGS.md` or `MAST_SPEC.md` that decides what a transitive walk does at a
class; the spec's example is the two-term walk.

| # | Mechanism | Verdict |
|---|---|---|
| R1 | A class in the walk adds its constructor to the walk as a row that is passed through and not reported; the existing step then finds the constructor's callers | **Built.** Each step stays one join on an indexed column |
| R2 | One step with `e.to_id = callers.id OR e.to_id = (the constructor of callers.id)` | **Reject.** Same answer; the `OR` across two tables takes the step off the `to_id` index. Not measured, chosen on the query's form |
| R3 | Store field-initializer calls from the constructor | **Reject.** A class with no constructor has no such row, and the stored edges agree with the reference as they are |
| R4 | Store `new X()` on the class as well as on the constructor | **Reject.** Undoes the 2026-10-07 decision and doubles every construction edge |

**Measured** (`spikes/d122/walk-through-constructor.py`, the two walks as SQL run
against the D121 indexes; it reads the database only):

| Corpus | Classes declaring a constructor | Of those, with a call stored from the class row | Symbols such a class calls | Transitive answers that change | Callers added | Callers removed |
|---|---|---|---|---|---|---|
| this repository | 11 | 0 | 0 | 0 | 0 | 0 |
| shapes corpus | 3 | 1 (1 edge) | 1 | 1 | 1 | 0 |
| n8n `9d9e9bf9` | 1,966 | 60 (121 edges) | 103 | 57 | 719 | 0 |

The count of answers that change is a lower bound: the script starts only at the
symbols such a class calls directly, and any symbol further down those call chains
changes too. Walk time over the 103 n8n starts: 40 ms before, 72 ms after, one run, on
a machine doing other work.

`spikes/d122/tool-answer.shapes.txt` is `mast query mast_callers` on the shapes corpus
with the built change: `["WithCtor","NoCtor","makeNo","makeWith"]`.

**What the added callers are.** I read one n8n case in source. `N8nMemoryImpl`
(`packages/cli/src/modules/agents/integrations/n8n-memory.ts:104`) declares a
constructor and has a field holding arrow functions, one of which calls
`this.acquireEpisodicMemoryTaskLock`. That call is stored from the class, and
`N8nMemory.getImplementation` constructs the class, so it and its callers are now
transitive callers of the method (81 added for that start). Constructing the class does
not run that arrow. This is the looseness a call inside any nested function already has
(it is stored from the enclosing declaration), and a class without a constructor gave
the same answer before this change. The other 56 changed answers I did not read.

**Not fixed, not checked.**

- A subclass that inherits its constructor: `new Sub()` is stored on `Sub`, and a walk
  that reaches the parent class through the parent's initializer does not go on to what
  constructs `Sub`. Inferred from the stored edges; no test.
- A static field's initializer is also stored from the class, and constructing the class
  does not run it. Same answer as a class without a constructor.
- `mast_rename_impact` has no transitive walk.

**Tests.** `src/indexer/__tests__/construction-edges.test.ts`, "a class with a
constructor in the middle of a walk": two cases, the first failing before the change
with `makeWith` and `outer` missing. The second (the constructor is not reported)
passed before and holds R1's pass-through.

## D124 — `export { a as b }` with no `from`

**The defect.** `function a() {}` and `export { a as b };` give the file two rows: `a`,
not exported, and `b`, exported, of `a`'s kind and on `a`'s line. An import of `b` was
placed on the row `b`. The reference has it on `a`, and `mast_callers a` answered with
no callers. The ledger row called `b` a marker; it is not one (corrected there).

**Prior decisions.**

- `MAST_SPEC.md` §10.1, "Implementation note — local aliases": the alias gets a chunk and
  a row of its own so that the exported name can be searched for, and the local name is
  not marked exported. Kept. The scorecard's reference is built to the same rule.
- `MAST_SPEC.md`, edge repair: "A name re-exported under another (`export { a as b }`,
  with or without `from`) is recorded in `reexport_aliases`" (D112). The code wrote the
  row for the `from` form only. This change makes the sentence true.
- D120: an import means a declaration only where it is exported. The row `b` is the
  exported one, so D120's filter finds it and not a private `b` beside it.

| # | Mechanism | Verdict |
|---|---|---|
| R1 | Record the alias in `reexport_aliases`; in the lookup of an imported name, go from the alias row to the row of the recorded name on the same line | **Built.** The alias row carries the declaration's line, which says which row when the name has two (D121) |
| R2 | Make `b` a marker with a `RE_EXPORTS` edge to `a`, as for the `from` form | **Reject.** Undoes §10.1: the row `b` would lose its kind, and `querySymbolByName` leaves markers out, so `mast_signature b` and `mast_callers b` would find no symbol |
| R3 | Keep the row `b` and store a `RE_EXPORTS` edge from it to `a` | **Reject for now.** It would give `mast_rename_impact a` the export line as a verified site. But the edge type means "marker to declaration" to the scorecard's reference and to repair, and each would need the exception |
| R4 | Recognise the alias row by its sharing a line and kind with another row, with no table | **Reject.** A class and its constructor, or two declarations on one line, share a line too |

**How common** (`spikes/d124/local-alias-census.sh`: an exported row sharing file, line
and kind with an unexported row of another name; measured on the D122 indexes):

| Corpus | Alias rows | Edges on them before | After |
|---|---|---|---|
| this repository | 0 | 0 | 0 |
| shapes corpus | 2 | 2 | 0 |
| n8n `9d9e9bf9` | 0 | 0 | 0 |

n8n has 35 one-line `export { … as … }` statements with no `from` (grep over
`packages/**/*.ts`; multi-line ones not counted). The four I read alias an imported name
or a name with no row; none produced an alias row, so the census is 0 and the fix
changes nothing there. The second corpus therefore says only that the change does no
harm: the shape itself is measured on the shapes corpus and the unit tests alone.

**Measured** (`spikes/d124/`):

- Shapes corpus: 83 edge rows before and after, two moved, `h -> loc.ts:b` to
  `loc.ts:a` and `use2 -> barrel2.ts:fmt2` to `barrel2.ts:internalFmt`. Scorecard call
  edges: `wrong` 2 to 0, `lacks` 3 to 1, `agree` 44 to 46.
- n8n: 71,126 edge rows before and after, none different. `reexport_aliases` 391 rows
  before and after.
- `compare` against the D121 baselines exits 0 on all four.
- Index time on n8n, one run each on a machine doing other work: 188 s for the D121
  build, 141 s for this one. The lookup makes one more query per resolved import; these
  two runs do not show a cost and are not a timing of it.
- The built tool on the shapes corpus: `mast_callers a` and `mast_callers b` both answer
  `useloc.ts:h`; `mast_callers internalFmt` answers `user.ts:use2`.

**Not fixed, not checked.**

- `mast_rename_impact a` lists `h` as a verified caller, whose text is `b()` and needs
  no edit, and lists the `export { a as b }` statement only as an unverified match at
  the declaration's line. Seen on the shapes corpus, not changed.
- The last `lacks` on the shapes corpus is another defect, filed as D148:
  `export { default as tool } from './x'`.
- An alias of a name with two rows takes the first row of the name the extractor finds
  (`symbolsFromChunks`). Read in the code, no test.
- A file with a `from` re-export of `b`, and unrelated local rows named `b` and the
  re-export's source name on one line, would be redirected wrongly. Not constructed.

**Tests.** `src/indexer/__tests__/local-export-alias.test.ts`: eight cases, seven
failing before (the eighth, callers asked under the exported name, passed before and
would have failed with the redirect alone). Two scenarios in
`equivalence-scenarios.ts`, run by both equivalence suites; I did not run them against
the code before the change.

**Review.** No separate adversarial pass was run for D122 or D124. I attacked three
claims myself: that no n8n edge moved (the row diff), that the redirect cannot fire for
a `from` alias (it needs a non-marker row and a second row on its line), and that an
incremental run matches a full one (the two scenarios).

