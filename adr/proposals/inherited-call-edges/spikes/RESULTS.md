# inherited-call-edges — spike results

Exploratory, run 2026-10-07 on the build of `563ecaf`. Nothing here is a settled
`FINDINGS.md` claim. Raw output sits beside each script; if this page and a raw file
disagree, the raw file wins. Every number below is measured unless it says otherwise.

Corpora: this repository (199 files), and the copy of n8n used by the graph-reference spike
(13,985 files). The checker comparison is `graph-reference/spikes/s1-call-edges/reference.mjs`,
TypeScript 5.9.3, on two n8n packages inside the whole-monorepo index: `packages/core` and
`packages/cli`.

## S1 — a throwaway walk up the stored `EXTENDS` edges (`s1-ancestor-walk/`)

`prototype.patch` is the whole change, against `src/graph/populate.ts` at `563ecaf`. It does
two things:

- When a call record names `T.m` and the present rules find no symbol, it places `T` as they
  do, then follows the stored `EXTENDS` edge from that class, looking for `<parent>.m` in the
  parent's own file, and repeats from the parent. It stops at a class with no stored edge or
  one already seen.
- It writes every file's `EXTENDS`, `IMPLEMENTS` and `PARENT_OF` edges before any call edge.
  An environment variable puts the two back in one stage, to measure what the order is worth.

Arms on n8n (`n8n-arms.sh`, output `n8n-arms.out.txt`): `off` (no walk), `walk`, `single`
(walk, one stage). Compared with `arms.py`; "committed" is the index the build of `563ecaf`
wrote.

### What the walk adds

| | This repository | n8n |
|---|---|---|
| Edges, committed build | 826 | 69,414 |
| Edges, walk | 826 | 70,478 |
| Edges the walk adds | 0 | **1,064** |
| Edges the committed build has and the walk lacks | 0 | 0 |

This repository has four `extends` in all, and no call reaches past one of them.

The 1,064 by kind (`n8n-head-vs-walk.json`): `field_type` 930, `this_method` 112,
`parameter_type` 20, `super_method` 1, `new_expression` 1. By target file: 818 land in
typeorm's `Repository.ts` (`this.userRepository.find(...)` where the field's class extends
`Repository`), 192 in `typed-emitter.ts`.

How far up each linked record went (`n8n-off-vs-walk.json`, counted per record, not per edge;
this arm's one-step `this.m()` records are ones the committed build already links by name):

| Kind | One class up | Two up | Three or more |
|---|---|---|---|
| `this_method` | 683 | 48 | 0 |
| `field_type` | 529 | 144 | 0 |
| `parameter_type` | 17 | 2 | 0 |
| `super_method`, `new_expression` | 1 each | 0 | 0 |

So most of the gain is not depth. It is a receiver typed as a class whose *direct* parent
declares the method, which the committed build links only for `this`. Stored chains on n8n
are 1 to 4 classes long (925, 309, 39 and 4 classes; `n8n-reach.json`), and no call needed
the third step.

Walks that linked nothing: 6,211 where the receiver's type has no file evidence, 5,475 where
its class has no stored `extends` edge, 173 where the chain ran out. No cycle.

The `off` arm holds 68,342 edges, 1,072 fewer than the committed build. That is the
prototype's doing, not a finding: splitting the stages takes the `extends` records away from
the one-step rule the committed build uses for `this.m()`. The walk puts all 1,072 back from
the stored edge.

### Are they right

| | Edges judged | On another declaration | New edges judged | New edges that agree |
|---|---|---|---|---|
| `packages/core`, committed | 921 | 0 | | |
| `packages/core`, walk | 930 | 0 | 9 | 9 |
| `packages/cli`, committed | 17,812 | 30 (see S2) | | |
| `packages/cli`, walk | 18,753 | the same 30 | 941 | **941** |

Summaries: `n8n-core.walk.summary.json`, `n8n-cli.head.summary.json`,
`n8n-cli.walk.summary.json`. On `packages/cli` the pairs mast lacks of shape
`this.field.m()` in another file go from 1,280 to 354; on `packages/core` the pairs lacked
go from 150 to 141.

Not judged: the 114 new edges in other packages (87 in `@n8n/db`, 24 in `testing`, 3
elsewhere). Not read by hand: any of them.

### What the order is worth

With one stage, as the committed build writes edges, the walk reaches 70,191 edges: **287 of
the 1,064 are missing** (`field_type` 166, `this_method` 112, `parameter_type` 9;
`n8n-walk-vs-single.json`), with nothing reported. A file's call is resolved before the file
that declares its class's parent has written its `extends` edge. All 112 two-step
`this.m()` edges are among them. This is D083 again for a new kind of dependency.

### Cost

Not measured. Wall time of the three arms was 157, 140 and 199 s with the machine's load
average between 16 and 23, and the arm doing the least work was not the fastest.

### What an edit would have to reach (`reach.py`, `visits.py`)

Today, after a file is re-written, repair resolves again the files that held an edge into it
and the files that import a name it gained or lost. A walked edge depends on files the caller
may hold no edge into and import nothing from: the classes between the receiver's class and
the one that declares the method.

Two ways to find those callers, measured on n8n:

| | Files reached | Per edited file: median | p99 | Largest |
|---|---|---|---|---|
| By name: every file below a class of the edited file, and every file holding an edge into one of those (274 files declare an extended class) | not already held | 0 | 821 | 1,620 (`workflow/src/errors/base/base.error.ts`) |
| By record: the files whose walk passed through a class of the edited file (717 such files; 4,905 file-and-class pairs to store) | not already held | 1 | 32 | 116 (`workflow/src/interfaces.ts`) |

The first is an upper bound on what a by-name rule would resolve again, and it would run
only when a class's set of members or its parent changes, not on an edit to a body. At
3.8 ms a file (`incremental-graph-correctness/spikes/s5-reresolve-cost`), 1,620 files is
about 6 s; that figure is arithmetic, not a run. The second needs a table written on every
file write.

Checked in passing, because the design leans on it: the committed build already links a call
once the receiver's class gains the method on an incremental run (two files, `r.added()`
with `added` written afterwards: no edge, then `f -> X.added [parameter_type]`). The repair
treats `X.added` appearing as a change to `X` and resolves the files that import `X`.

## S2 — two defects in the committed build, found on `packages/cli` (`s2-found-on-cli/`)

`packages/cli` had not been judged before. Of its 17,812 stored call edges the checker puts
30 on another declaration and could not judge 41 (`n8n-cli.head.disagreements.json`). Read
by hand, by cause:

| Edges | What it is | Verdict |
|---|---|---|
| 1 | `const unsupportedAction = () => ...` in a method, then `unsupportedAction()`; the file also imports a function of that name. The edge goes to the import | **Wrong edge.** D104 |
| 2 | `new DslColumn(...)`, where an index file has `export { Column as DslColumn }`. The edge goes to the class though it declares a constructor | **Wrong target by the rule agreed for construction.** D105. Method calls through the same alias get no edge |
| 27 | `new X()` where the package index declares `export type X = ...` and `export const X: typeof Mod.X = lazyClass(...)` on the next line. mast has one symbol for the name, the type. The checker names both declarations | Not filed. The edge is on the name the call uses; the class behind the lazy loader is not reachable without running it |
| 27 + 5 + 9 | "no call of that name on the line" and "checker has no symbol": calls through a renamed re-export (`isValidNonDefaultMode` is `isStoredMode`), and `new Agent()` where `Agent` is both a type import and a local taken from `await import(...)` | Limits of the comparison script. Two read, both edges right |

Both defects reproduce on five files with the build of `563ecaf` (`reproduce.sh`, output
`reproduce.out.txt`):

```
src/alias.ts:make|construction|lib/column.ts:Column (class)|3
src/shadow.ts:other|import|lib/helpers.ts:fail (function)|9
src/shadow.ts:run|import|lib/helpers.ts:fail (function)|5
```

`run` calls its own local `fail`, not the import. `make` constructs a class that has a
constructor. `use(c: DslColumn) { c.build() }` has no row at all.

## Limits

- One real corpus shows any gain. This repository has no call that needs the walk.
- The walk follows the first stored `extends` edge of a class. Six n8n classes have two.
- Interfaces, mixins and classes whose parent is an expression were not looked at.
- A constructor inherited from a parent was not walked: `new X()` where `X` declares none
  still lands on `X`.
