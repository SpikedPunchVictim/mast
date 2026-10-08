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

### After the fixes (2026-10-07, same day)

D104 and D105 were fixed ahead of the walk. Files: `reproduce.fixed.out.txt`,
`n8n-fixed-vs-head.edges.json` (written by `edge-diff.py` from the index of `563ecaf` and
the index of the fixed build), `n8n-cli.fixed.summary.json`.

```
src/alias.ts:make|construction|lib/column.ts:Column.constructor (method)|3
src/alias.ts:use|parameter_type|lib/column.ts:Column.build (method)|4
src/shadow.ts:other|import|lib/helpers.ts:fail (function)|9
```

Whole n8n copy: 69,414 edges before, 69,412 after. 10 gone, 8 new.

| Edges | Change | Why |
|---|---|---|
| 1 gone | `execute -> unsupportedAction [import]` | D104 |
| 2 gone, 2 new | `new DslColumn()` moves from `Column` to `Column.constructor` | D105 |
| 1 new | `name.timestampTimezone()` on a local bound to `new DslColumn()` | D105 |
| 7 gone | `new X()` (6) and `X.m()` (1) where `X` is `const { X } = await import('...')` | A local now hides the file's static import of the name. All 7 were on the right declaration, read in the source. Listed in `MAST_SPEC.md` §10.3.1 as not caught |
| 5 new | `state.markEnvAsNeeded()` and four like it, in `visitIdentifier = (node, state: BuiltInsParserState) => ...` | The parameters of an arrow that initializes a field were not read before. Read in the source; outside the two packages the checker judged |

Checker on `packages/cli`, before and after: edges on another declaration 30 to 27 (`import`
1 to 0, `construction` 29 to 27; the 27 left are the `lazyClass` pairs above). `static_method`
agreeing 64 to 63 and `construction` not judged 27 to 21 are the 7 dynamic-import edges.
Pairs mast lacks: 4,736 both times. The checker's program held 9,412 source files in the
second run and 9,524 in the first, on the same copy and the same 1,758 indexed files; why
is not known.

The first version of the D104 fix removed 24 edges, not 10. Reading them found two faults
in it, both then pinned by tests: a default value in a destructured pattern
(`{ telemetry = useTelemetry() }`) was taken for a bound name (3 edges), and an arrow whose
whole body is a class was no longer read (11).

Reading the 7 also found D106: `import { Agent as RuntimeAgent }` is recorded as an import
of `Agent`, so two of the 7 had linked through a name the file never binds. Open.

### After D106 (2026-10-07)

Fixed by the record carrying the import that binds its name; no schema change. Files:
`s2-found-on-cli/n8n-d106-vs-4ca9a71.gone.txt` and `.new.txt` (every edge of the whole n8n
index, before and after), and `scorecard-d106-*.compare.txt` (`eval-suite/graph-scorecard.mjs
compare` against the baselines of `4ca9a71`).

Whole n8n copy: 69,412 edges before, 69,542 after. 22 gone, 152 new.

| Edges | Change | Why |
|---|---|---|
| 8 gone, 8 new | From the import's declaration to the file's own (5 calls, 3 `new`) | `import { toDateTime as stringToDateTime }` beside the file's own `toDateTime`. The old edges were wrong |
| 2 gone | `hasErrorOutput(node)` where the file has `export const hasErrorOutput = checkHasErrorOutput` | The call is of the file's `const`, which has no symbol |
| 12 gone | `agent.model()` and eleven like it in `from-json-config.ts` | Right edges. `Agent` there is `const { Agent } = await import(...)`; they had linked through `import type { Agent as RuntimeAgent }` |
| 144 new | 25 `EXTENDS`, 3 `IMPLEMENTS`, 116 calls, through an alias | 18 are in the two judged packages and all 18 agree with the compiler. The rest are not judged |

Scorecard verdicts: this repository PASS, `packages/core` PASS, `packages/cli` FAIL for the
12. The baselines were replaced with this build's scorecards knowing that.

A local taken from a dynamic import now costs 19 right edges on `packages/cli` (7 from D104,
12 here). Binding such a local to its module would get them back; done in the next section.

### After binding a local taken from a dynamic import (2026-10-07)

`const { X, Y: Z } = await import('m')` now binds `X` and `Z` to `m` for the function it
is in, and the file gets an import row for `m`. Files: `s2-found-on-cli/n8n-dyn-vs-eca3f88.gone.txt`
and `.new.txt` (every edge of the whole n8n index, build of `eca3f88` against this one),
and `scorecard-dynamic-import-*.compare.txt`.

| | `eca3f88` | this build |
|---|---|---|
| Edges, whole n8n | 69,951 | 70,022 (0 gone, 71 new) |
| Call edges | 44,671 | 44,742 |
| Import rows | 51,617 | 51,963 |
| Import rows with a resolved file | 43,599 | 43,868 |
| `packages/cli` calls that agree with the compiler | 17,856 | 17,917 |
| `packages/cli` calls mast lacks | 5,973 | 5,912 |

- Of the 71 new edges, 61 are in `packages/cli` and all 61 agree with the compiler. 22 of
  them are in `from-json-config.ts`, which holds the 12 lost with D106. The other 10 are in
  five packages that are not judged.
- Scorecard: PASS on all three. `packages/core` has no new edge; this repository has 12.
- The first scoring of this build failed on `packages/cli` for two reasons, neither in the
  change:
  - **D110**, in mast: 68 of the 247 new import rows had no file, all of them a path alias
    written with a `.js` extension (`@/security-audit/security-audit.service.js`). No static
    import in `packages/cli` is written that way, which is why the baseline had none
    lacking. Fixed in the same commit. Across the whole n8n index it resolved no static
    import that was unresolved before (0 rows).
  - In the scorecard: one `new PineconeVectorStore()` through a destructured local was
    marked wrong. The class declares no constructor, and the reference followed the
    compiler's signature to the constructor of the class it extends, where the rule decided
    on 2026-10-07 is the class itself. `heldBy` now applies that rule. A first correction
    applied it to every `new` through a variable and added six calls of a variable typed
    `{ new (): SecretsProvider }` as lacking; it now applies only when the signature is a
    constructor's or the implicit one.

## The walk as built (2026-10-08)

M1, M2 and M3a, with R2 (no edge for a class with two stored parents). R1 is not built.
Files: `s2-found-on-cli/scorecard-walk-*.compare.txt` (each corpus against the baseline of
`9698465`), `s2-found-on-cli/n8n-walk-vs-9698465.gone.txt` and `.new.txt` (every edge of
the whole n8n index), `t6-replay/replay-check-*.json`.

### Full index (T7)

| | `9698465` | this build |
|---|---|---|
| Edges, whole n8n | 70,022 | 71,091 (0 gone, 1,069 new) |
| `packages/cli` calls that agree with the compiler | 17,917 | 18,858 |
| `packages/cli` calls mast lacks | 5,912 | 4,971 |
| `packages/cli` calls wrong / unjudged | 0 / 4 | 0 / 4 |
| `packages/core` calls that agree | 921 | 930 |
| `packages/core` calls mast lacks | 204 | 195 |

- Scorecard: PASS on all three. `packages/cli` has 941 calls move from `lacks` to `agree`
  and `packages/core` 9, the numbers S1 predicted. No other line item moves on n8n.
- 119 of the 1,069 new edges are outside the two judged packages and are not judged.
- This repository gains 35 agreeing call edges. That is its own source growing with the
  change, not the walk: the build of M1 and M2 alone, before the repair was written,
  gained 3.
- The D111 fix (below) changes no edge on n8n: the edge list of this build equals that of
  the build of M1 and M2 alone.

### Incremental runs (T5, T6)

M1 and M2 alone made every edit to a class hierarchy leave an incremental run or a
query-time refresh different from a full index: nine scenario rows written for T5 failed in
both equivalence tables (18 failures). With M3a all pass, with a tenth row for a caller
written in the same run as the class at the top.

M3a is not built as the proposal's "Order inside repair" has it. It does not put the files
that hold an `EXTENDS` edge in the first group. It reads the `EXTENDS` edges before the
first write and after each group resolved, and for every class whose members or parent
changed it resolves again the files that declare or import that class or one below it,
until a reading shows no change. The first-group rule was written and then taken out: with
it removed no scenario and no generated seed failed, since a file resolved too early is
resolved again when its parent's edge comes back. What that costs in files resolved twice
is not measured.

Each part was removed in turn to see what fails:

| Removed | Fails |
|---|---|
| Classes whose members changed | 4 of the 9 rows, in both tables |
| The reading after each batch | 2 of the 9 rows, in both tables |
| Resolving a written file again | the tenth row, incremental table |
| The reading from before the write, for finding classes below | nothing: a class that lost an edge to a write is itself one whose parent changed. Taken out |

Generated edit sequences (`generated-edits.ts`) now build classes `H0` to `H2` that extend
one another across files, and add and remove their methods, parents and importers:

| Build | Seeds 1 to 200 |
|---|---|
| M1 and M2, repair as in `9698465` | 10 fail (19, 29, 32, 48, 113, 122, 144, 148, 167, 194) |
| With M3a | 0 fail; 0 of seeds 1 to 900 |

Before those edits were added, the same 200 seeds caught the missing repair in none: the
one failure was seed 22, which is D111 and fails without the walk as well. Seeds 19 and 29
are now among the fixed seeds the gate runs.

**D111**, found on the way: a file that re-exports one name by name from two files has two
`RE_EXPORTS` edges on one marker, and the one followed was the first written. Ordered by
path now, as D094 did for two stars.

### A review that tried to break it

A separate pass was briefed to write scenarios where an incremental run differs from a full
index, and ran 64 through three loops (incremental; budget 0 then unlimited; query-time
refresh then incremental). 56 passed, among them chains of four and six files with 40
importers, cycles, a parent switched between two files with a class of the same name, a
class with two stored parents, and two levels edited in one round. 8 failed, all one case:
the caller reaches the class through `export { Leaf as Blatt } from`. That is **D112**,
which fails without any class as well and on the build of `9698465` (two of the eight run
again here, one on that build). It is open; the walk widens it from "the re-exported
declaration changed" to "any class above it changed".

From its reading, not reproduced: the list of waiting files was cleared for a group before
the files that group put out of date were recorded, so a process stopping between the two
lost them. The order is now the other way round. Not tried by it: a budget running out
part-way, concurrent writers, mixins.

### Replay of real commits

`eval-suite/replay-check.mjs`, with the build of this change (the tree was not yet
committed, so the files say `mast_tree_dirty: true` on `9698465`):

| | This repository | n8n |
|---|---|---|
| Commits replayed, one incremental run each | 100 (`f815a3b` to `9698465`) | 200 (`f8941b1` to `9d9e9bf`) |
| Runs that wrote a file | 98 | 144 |
| Files written, total / most in one run | 571 / 39 | 1,119 / 93 |
| Lines of the graph after the replay / in a full index | 1,324 / 1,324 | 124,110 / 124,110 |
| Missing / extra after the replay | 0 / 0 | 0 / 0 |
| Files stale / waiting for repair | 0 / 0 | 0 / 0 |
| Verdict | PASS | PASS |

A pass means the incremental path and the full path agree on this history. It does not
mean an edit to a class hierarchy was among the 200 commits; that was not counted.

## Limits

- One real corpus shows any gain. This repository has no call that needs the walk.
- The walk follows the first stored `extends` edge of a class. Six n8n classes have two.
- Interfaces, mixins and classes whose parent is an expression were not looked at.
- A constructor inherited from a parent was not walked: `new X()` where `X` declares none
  still lands on `X`.
