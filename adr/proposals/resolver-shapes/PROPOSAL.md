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
