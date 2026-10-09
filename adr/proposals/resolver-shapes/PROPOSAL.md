# resolver-shapes — the wrong edges of D115 to D124

**Status:** in progress. D115 is built (2026-10-08). The other rows are open.

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
