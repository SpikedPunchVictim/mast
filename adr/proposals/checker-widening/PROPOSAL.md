# checker-widening — should `mast index --checker` add every call the compiler can resolve?

**Status:** proposal, 2026-10-09. No product code is changed. Four spikes are run and kept
under [`spikes/`](spikes/); what each file is, is in [`EVAL.md`](EVAL.md). Three decisions
are asked for at the end. No ADR yet.

ADR 020 held this in reserve: "Widening `--checker`, by its own proposal and spike". The idea
was to change the pass from "look again at the potential matches the resolver could not
link" to "store every call pair the TypeScript compiler has", as an opt-in full pass.

**The short answer.** The spikes do not support building the wide pass next. They found that
the pass as shipped writes wrong callers and does not finish on n8n, and that about half of
the gap it was meant to close on n8n is decorators, which the resolver can read without the
compiler.

Terms used below. A **call pair** is "declaration A calls declaration B", written
`path:A > path:B`. The **reference** is the compiler's own set of call pairs for the same
files, as `eval-suite/graph-scorecard.mjs` computes it. A pair **agrees** when mast stores it
and the reference has it, is **wrong** when mast stores it and the reference puts the call
somewhere else, and is **lacking** when the reference has it and mast does not.

## What was looked for first

- `eval/spikes/checker-edges/REPORT.md` (2026-07-15), the spike the shipped pass came from.
  It measured 25 projects and 762 files, 21.8 s and 2.45 GB with every program held at once,
  and a payoff of 19 of 50 sampled potential matches. Its sample counted a call "nearest the
  original range" within five lines of a chunk as a hit for that chunk. That rule is D154
  below.
- `MAST_SPEC.md` §10.3.2, what the pass guarantees today.
- ADR 020 and `resolver-shapes/PROPOSAL.md`: better no edge than a wrong one; the heuristic
  resolver stays the default; the D121 review read that the pass "takes one row of a name"
  and did not run it.
- `FINDINGS.md` §1, §3 and §4: nothing there is about the checker, call pairs or the
  compiler. Nothing in §3 (dead hypotheses) is re-proposed here.
- `.history/004` (the archived plan the pass was built from) was not re-read beyond the
  report above.

## What was measured

All on n8n `9d9e9bf9` (13,985 files indexed, 13,422 of them TypeScript, 45,834 stored call
edges, index built by `14a67bf`), TypeScript 5.9.3, single runs on a machine doing other
work. Times are not a benchmark.

### 1. What a pass over every project costs (`spikes/s1-cost-yield/`)

The scorecard was run once per tsconfig project the shipped pass would visit, one process
per project. It builds one compiler program and scores everything mast stores, so its time
is an upper bound for a pass that only resolves calls.

| | |
|---|---|
| Projects found | 81, and 4 base configs skipped |
| Projects scored | 80 |
| Time, summed over the 80 | 239.5 s (median project 2.1 s; `packages/cli` 19.0 s) |
| Largest peak memory of one project | 1,568 MB resident; 6 projects over 1,000 MB |
| The 81st project | the root `tsconfig.json`, 19,018 files: out of memory after 66.6 s (94.5 s in the first run) |

### 2. How much the stored graph lacks (`spikes/s1-cost-yield/n8n.json`)

Over the 80 projects, counted over the union of keys:

| | Call pairs |
|---|---|
| Stored, and the compiler agrees | 45,789 |
| Stored, and the compiler has the call elsewhere (wrong) | 0 |
| Stored, not judged | 4 |
| Lacking | 14,509 |

So mast stores 45,789 of the 60,298 pairs the reference has (76%), and none of what it
stores is wrong. The lacking pairs are concentrated: `packages/@n8n/typeorm` 5,585,
`packages/cli` 4,955 and `packages/@n8n/db` 1,699 are 12,239 of the 14,542 counted per
project.

By how the call is written:

| Written as | Agree | Lacking |
|---|---|---|
| `f()`, callee in another file | 11,377 | 7,188 |
| `expr.m()`, another file | 8 | 3,637 |
| `ident.m()`, another file | 1,593 | 2,871 |
| `this.field.m()`, another file | 7,725 | 612 |
| everything in the same file | 18,986 | 182 |
| `new X()`, `this.m()`, `super.m()`, another file | 6,100 | 19 |

On this repository the same scorecard has 926 agreeing and 28 lacking (3%), so the size of
the gap is a property of the code base and not a constant.

### 3. What the lacking pairs are (`spikes/s4-what-the-lacking-pairs-are/`)

7,188 lacking `f()` calls of a name from another file was not expected: that is the
resolver's first rule. The calling file's import rows say why.

| What the caller's imports say about the callee | Lacking pairs |
|---|---|
| A row lists the name and resolves to another file (a re-export on the way) | 5,377 |
| A row lists the name and resolves to the callee's file | 5,155 |
| No row resolves to the callee's file or lists the name | 2,881 |
| A row resolves to the callee's file and does not list the name (namespace or default import) | 914 |
| Caller and callee are one file | 182 |

In 10,532 of the 14,509 the name is imported and the import is resolved. Of the 7,548
lacking pairs whose callee is a top-level name, **7,047 have that name written as a decorator
(`@name`) in the calling file**: 6,289 from a class, 752 from a method, 6 from a function.
`@Entity`, `@Column`, `@PrimaryGeneratedColumn` and `@Service` are 3,957 of them. The
compiler counts `@Service()` on a class as a call from the class to `Service`. The resolver
does not read a decorator as a call.

This count is a text match on the calling file (the file contains `@name`), not a parse. It
says the file uses the name as a decorator, not that each pair is that decorator.

What is left after decorators is about 7,462 pairs (12% of the reference), nearly all calls
of a member on an expression or a variable whose type the resolver does not know. Those are
what a compiler is needed for.

### 4. What the shipped pass does on n8n (`spikes/s3-existing-pass-on-n8n/`)

`mast index --incremental --checker` on a copy of the index:

- It did not finish. `JavaScript heap out of memory` after 319.5 s, exit 134, 2,495 MB
  resident (D153). My reading is that it died in the root project; it prints no project
  name without `--show-progress`.
- Before it died it wrote 5,591 `checker` edges and 417,089 verdict rows.

The scorecard was then run over the index it left (`n8n-after-the-existing-pass.json`):

| The 5,591 `checker` edges | |
|---|---|
| The compiler agrees | 756 |
| To a class, where the compiler has the class's constructor from the same caller (D155) | 1,814 |
| Not judged | 3,021 |

The 3,021 were read against the source. The pass looks for a call of the name from five
lines above a chunk to five lines below it and writes the edge from the chunk's own symbol.
`cleanup > touchFile` is stored with the call on line 32; `cleanup` is lines 35 to 37, and
the call is in `init` (D154). Counted from the stored call line:

| Corpus | `checker` edges | Call line outside the caller's own lines | From a symbol to itself |
|---|---|---|---|
| n8n (run did not finish) | 5,591 | 2,637 (47%) | 1,196 |
| directus `9dca3724a6` (14.4 s, 724 MB, exit 0) | 779 | 347 (45%) | 128 |
| this repository (7.1 s, 534 MB, exit 0) | 56 | 39 (70%) | 16 |

So the pass closed 756 of n8n's 14,509 lacking pairs (5%) and wrote at least 2,637 verified
callers that do not call.

### 5. How long a `checker` edge lives (`spikes/s2-checker-edge-lifetime/`)

On a four-file fixture:

- A third file changes what a call resolves to. `index --incremental` keeps the old edge,
  and `index --incremental --checker` then stores the new one beside it (D150).
- A full `mast index` without `--checker` removes every `checker` edge and prints nothing
  about it (D151).
- `make().persist()` is never a candidate: the pass searches for the method by its
  qualified name, `Bravo.persist`, which the call does not contain. Zero edges upgraded.
  This is the largest class of lacking pairs in section 2 (`expr.m()`, 3,637), and the
  shipped pass cannot reach it. Measured on this one fixture; the reason is read from
  `runCheckerPass`.

### A defect in the instrument, fixed here

The first run of spike 1 had 70 wrong pairs. All were right edges into packages three
directories deep (`packages/testing/test-impact`), which the scorecard did not map to source
(D152). Fixed with a test; the four baselines keep every key. The numbers above are from the
run after the fix.

## Defects filed from this work

| Row | Sev | What |
|---|---|---|
| D150 | S0 | A `checker` edge outlives a change in a third file, and is not removed by running the pass again |
| D154 | S0 | The pass names as caller a declaration within five lines of the call |
| D155 | S1 | The pass stores the caller of `new X()` on the class when the class declares a constructor |
| D151 | S2 | A full index without `--checker` silently removes every `checker` edge |
| D153 | S2 | The pass runs out of memory on n8n |
| D152 | S1 | The scorecard scored right edges as wrong for packages three directories deep. Fixed |

## What is proposed

In this order. Each step is its own change with its own tests and scorecard run.

**P1. Stop the shipped pass writing wrong callers (D154), and make its edges removable
(D150).** Both are severity zero in a pass a user can turn on today. For D154 the smallest
change is to accept a call only on a line inside the candidate chunk's own lines; a call in
the padding belongs to a neighbour, which has its own candidate. For D150 see decision 2.
D155 (store against the constructor, as rule 9 does) and D153 (do not build a program for a
project every file of which another project already covers, or say which project failed and
go on) belong with it.

**P2. Read a decorator as a call, in the heuristic resolver.** The name is imported and the
import row is resolved, so rule 1 places it with no compiler. On n8n this is up to 7,047
pairs, about half the gap. It needs its own short spike first: count by a parse instead of a
text match, decide whether `@Injectable` with no parentheses counts (the compiler's
reference decides for the scorecard), and find a second repository that uses decorators.

**P3. Only then, the wide pass, for member calls.** What remains is about 7,462 pairs on n8n.
If built, the spikes say it should not reuse the candidate search: it should walk every call
expression of a project's files, take the caller from the syntax tree, take the callee from
the compiler's resolved signature, and map both ends to symbol rows by file, name and line,
as the scorecard's reference does. Cost on n8n is in section 1: about 4 minutes summed, 1.6
GB for the largest project, and a rule for the root project. Kept in reserve until P1 and P2
are done and the remaining gap is measured again.

## Decisions asked for

1. **Is the order P1, P2, P3 right?** The alternative that was asked for is to build the wide
   pass now. I recommend against it: it would be built on a pass that has two severity-zero
   defects, and half of what it would add on n8n does not need it.

2. **How long does a `checker` edge live (D150, D151)?**

   | # | Rule | For | Against |
   |---|---|---|---|
   | L1 | Any index run that rewrites a file removes every `checker` edge and verdict, and says how many; the pass is a snapshot of one tree | Always right. A few lines. Makes D151 the documented behaviour | In a served session the edges are gone at the first edit, until the pass is run again |
   | L2 | Remove the `checker` edges of the files that import the changed file, directly or through others | Keeps most edges through an edit | A type can also change through a global or ambient declaration, which no import row records. Needs the import closure at index time; cost not measured |
   | L3 | Keep the edge and mark it stale in the answer | Nothing is lost | A new signal in every caller-reading tool, and a stale edge is still listed as verified |

   I recommend L1. It is the only one that cannot leave a wrong edge, and it can be relaxed
   to L2 later with a measurement.

3. **Fix the shipped pass, or withdraw its edges?** Fixing D154 as in P1 is small. The
   alternative is to stop the pass writing edges at all until P3, and keep only its verdicts,
   which remove matches that are not calls. On n8n 756 of its 5,591 edges were right. I
   recommend fixing it: the right edges are real, and P3 would replace the mechanism anyway.

## Not measured

- A second repository for sections 1 to 3. The directus copy has no `node_modules`, every
  tsconfig there fails to resolve `@directus/tsconfig`, and the scorecard refuses such a
  reference. The vscode copy has none either. Only this repository gives a second number,
  and it has no decorators.
- The exact number of decorator pairs (section 3 is a text match).
- The time of a pass that only resolves calls, and any timing on a quiet machine.
- Peak memory of one process visiting the 80 projects in turn. Each project had its own
  process here, so 1,568 MB is the largest single program, not a pass.
- Which project the shipped pass died in on n8n.
- D150 under `mast serve` (the watcher and the reparse on read).
- How many of the 3,021 unjudged `checker` edges on n8n are wrong beyond the 2,637 whose
  call line is outside the caller. The count is a lower bound: a chunk's lines are the
  declaration's own.
- Whether verdicts (not edges) are ever wrong because of the same five-line window.

## Decisions taken, 2026-10-09

All three recommendations were accepted: the order P1, P2, P3; lifetime rule L1; fix the
shipped pass.

## P1, done

One change, because the four defects meet in `runCheckerPass`. Measured on n8n `9d9e9bf9`
with the index of `14a67bf` and the pass of this commit
(`spikes/s3-existing-pass-on-n8n/after-the-fix/`, `spikes/s1-cost-yield/n8n-after-the-fixed-pass.json`):

| | Shipped pass | After P1 |
|---|---|---|
| Finishes | No: heap out of memory at 319.5 s, exit 134 | Yes: exit 0, 375.7 s |
| Maximum resident memory (`time -l`, bytes / 10^6) | 2,495 MB at the crash | 1,571 MB |
| `checker` edges | 5,591 | 754 |
| Call written outside the caller's own lines | 2,637 | 0 |
| Agree with the compiler | 756 | 734 |
| Wrong by the compiler | 1,814 | 0 |
| Not judged | 3,021 | 20 |
| Call pairs the graph has, of the compiler's 60,298 | 45,789 before the pass | 46,523 |

The times are not comparable with each other or with a quiet machine: the load average was
14 to 40 during the second. A second run of `s1` for timing (`n8n-second-run.json`, 248.4 s
summed against 239.5 s) reproduced every count and was also taken under load.

What changed, by defect:

- **D154.** A call is looked for on the candidate's own lines, and the edge is written from
  the innermost declaration around it. The second half was not in the proposal: 387 of the
  shipped pass's edges on n8n were from a class for a call inside one of its methods.
- **D155.** A constructed class's edge goes to its constructor, as rule 9 does.
- **D153.** `spikes/s5-root-project/`: n8n's root project names 19,018 files and is given 110.
  A program is built from the files its project is given, and a file goes to the deeper of
  two projects that name it.
- **D150, D151 (L1).** Every write of a file removes all `checker` edges and verdicts, and
  `mast index` and `mast_reindex` report the counts. This reverses the second half of T6 of
  `adr/proposals/incremental-graph-correctness/`, which kept a caller's rows about files
  that did not change; its log has the entry.

A review of the change before commit found four gaps, each reproduced with a failing test
and fixed: a second pass kept the first's edges; a file written while a pass is classifying;
a one-line class; and file ownership following discovery order.

Left open:

- 19 of the 20 unjudged edges are a decorator on a method, stored from the class. P2's spike
  has to say whose call that is.
- A re-parse on read between the pass's check and its inserts in one batch is not seen.
- The watcher and the re-parse on read remove the results without saying so; `mast_status`
  does not show whether any exist.
- Not measured: the pass on a second repository after the fix, what L1's delete costs a full
  index, and timing on a quiet machine.


## P2, done (2026-10-09)

The resolver reads a decorator written as a call. Spike first (`spikes/s6-decorators/`),
then the change.

### The spike: three questions, two repositories

Prior decisions checked: `FINDINGS.md`, the ADRs and the other proposals do not mention
decorators. The only earlier statement is the boundary D098 left in the extractor ("does
not descend into ... decorators"), which records that they were not read and gives no
reason.

`decorators-by-parse.mjs` parses every file that is the caller of some call pair and matches
each decorator to its pair by file, caller name and callee name. It replaces section 3's
text match. The second repository is nest `c3bc75c97`, which declares its decorators in the
repository and maps its packages with `paths`, so the scorecard builds a reference for it
without `node_modules`.

| Measured, before the change | n8n `9d9e9bf9` | nest `c3bc75c97` |
|---|---|---|
| Lacking call pairs | 13,775 (after the fixed pass) | 1,359 |
| Of them, a decorator written as a call | 6,806 | 961 |
| Of them, a call inside a decorator's arguments | 54 | 44 |
| Decorators with no parentheses, in the calling files | 432 | 12 |
| Of those, with a call pair in the reference | 0 | 0 |

The text match had 7,047 on n8n; the parse has 6,806.

1. **How many.** 6,806 of 13,775 on n8n (49%), 961 of 1,359 on nest (71%).
2. **Whose call.** The nearest declaration with a symbol, as for every other call. On a
   class or a field (a field has no symbol) it is the class: 2,396 and 3,658 pairs on n8n,
   515 and 20 on nest. On a method, an accessor or a parameter it is the member: 599, 3 and
   150 on n8n, 201, 0 and 225 on nest. No lacking pair has a member decorator's call from
   the class.
3. **`@Injectable` with no parentheses.** Not a call for the reference: none of the 444
   sites has a pair. The compiler does treat a decorator as call-like, but the scorecard
   counts call and `new` expressions only, so an edge for a bare decorator would be one
   nothing judges. Not stored. It is in reserve until the reference counts them.

The script matches by name, so `@X()` would claim a lacking pair to any `*.X` from the same
caller; no key held more than one pair on either corpus. An aliased import
(`import { Body as B }`) is never matched, which weakens the zero in the last row.

### The change

`emitDecoratorEdges` in `src/ast/extractors/typescript.ts`: a decorator whose expression is
a call is read as a scope of its own, with the calls in its arguments, from the class (class
and field decorators) or the member (method, accessor, constructor and parameter
decorators). It is given no class bindings, so `this` in the arguments is not the instance.
No schema change, no new resolution label: the edge is placed by the rules a bare call is.

| Measured, final build | Before | After |
|---|---|---|
| n8n: call pairs that agree, of the compiler's 60,298 | 45,789 | 52,857 |
| n8n: wrong, extra | 0, 0 | 0, 0 |
| n8n: unjudged | 4 | 4 |
| n8n: stored call edges | 45,834 | 52,902 |
| nest: call pairs that agree, of 4,022 | 2,663 | 3,664 |
| nest: wrong, extra | 0, 0 | 0, 0 |
| nest: unjudged | 11 | 11 |

n8n is 80 tsconfig projects scored one at a time with the root project skipped, as in `s1`.
The four committed baselines pass `compare`; `mast`, `n8n-core` and `n8n-cli` are replaced
(`n8n-cli`: 1,862 pairs from lacking to agreeing; `shapes` is unchanged).

Decorator pairs still lacking on n8n: 19, all through a namespace import
(`@TypeOrm.Entity()`), which the resolver does not read. On nest: none. A full index of n8n
took 92.6 s and 494 MB with the change, on a loaded machine; there is no number for the
build before it under the same load, so what the change costs an index is not measured.

### The pass and decorators (D157)

The 19 unjudged `checker` edges P1 left were a method decorator's call stored from the
class: `@BeforeInsert()` above `beforeInsert()`. The method's chunk starts at its name, so
the decorator is on the class's lines only, and the class is a potential match because the
identifier index holds its member name and does not tell `beforeInsert` from
`BeforeInsert`. `classify` now reports the line of the member a decorator is on, and the
pass writes the edge from the candidate's member on that line, or none.

A review before commit found the first form of that fix, which looked the member up by
name, wrong in four shapes, each reproduced with the real compiler and now a test: a getter
and a setter of one name, a static and an instance method of one name, a private or
computed name, and a class nested in the candidate. It also found a comment between a
decorator and its method losing the decorators above the comment in the resolver (two pairs
on n8n), fixed the same way.


The pass on the final build (`spikes/s6-decorators/pass-after-p2/`,
`n8n-after-with-the-pass.json`), measured:

| n8n, with the pass | |
|---|---|
| Call pairs that agree, of 60,298 | 53,331 |
| Wrong, extra | 0, 0 |
| Unjudged | 4 |
| `checker` edges | 474 |
| Of them agreeing, wrong, unjudged | 474, 0, 0 |
| Each with its call line inside a chunk of its caller | 474 |
| The pass | 286 s, 1,909 MB maximum resident size, on a loaded machine (216 s in the run before) |

The pass adds 474 pairs to the 52,857 the resolver has. The first scored run of the pass
after P2 had 475 `checker` edges and one unjudged. That one was not a decorator: an ordinary
call in a setter, stored from the getter of its name (D159). With that fixed the setter's
call is the edge the resolver already stores, so the pass writes 474.

### Left open after P2

Found and not fixed:

- **D156**, fixed 2026-10-10 (below): `mast_callers` and `mast_rename_impact` listed a
  verified caller a second time as a potential match. More decorator edges make more
  verified callers, so P2 made it more visible; it did not cause it.
- **D158**, fixed in part in its own commit (`adr/proposals/watcher-descriptors/`): a `mast serve` holds one open file per watched file. Found because it
  stopped this work's tests; it is not part of the resolver.
- A decorator with no parentheses has no edge (reserve, above).
- A decorator factory held in a constant (`const Get = RouteFactory('get')`) has no symbol,
  so `@Get()` has no edge to it, and a type of the same name declared beside it takes the
  lookup (`MAST_SPEC.md` §10.3.1).
- `@(expr)()` and a decorator through a namespace import (`@TypeOrm.Entity()`, the 19 pairs
  above) are not read.
- The pass reads one call per candidate, and reaches a member's decorator only when the
  class is a potential match for the queried name, which happens when a member is named
  like the decorator without regard to case. A decorator on a member of a class nested in
  the candidate gives no edge.

Not measured:

- What the change costs an index, on a quiet machine. A direction was measured later
  ("What P2 costs an index", below).
- A monorepo with `node_modules` installed. One small app was run later ("A corpus with its
  packages installed", below).
- A third repository. The directus and vscode copies were not scored for P2.
- JavaScript. Both corpora are TypeScript; a decorator in a `.js` file goes through the same
  code and is covered by no test or measurement.


## The forms P2 does not read, measured (2026-10-09)

Three forms were left as "not read" with no number beside them. `spikes/s9-decorators-not-read/`
resolves every decorator and call with the compiler and records what the callee's declaration
is. It counts **sites**, not call pairs, and it is not the scorecard: nothing here says an
edge would agree. nest is its one root project (971 files). n8n is six of its 80 projects
(`cli`, `db`, `core`, `decorators`, `api-types`, `config`; 5,936 files, 127,469 calls and
`new`s that resolve into the corpus), with a cruder package mapping than the scorecard's.

| Sites, by what the callee is | n8n, six projects | nest |
|---|---|---|
| `@name(...)` and `@a.name(...)`, all | 4,446 | 1,042 |
| of them, to a constant that holds the result of a call | 587 | 189 (and 12 to a constant that holds another name) |
| `@name` with no parentheses, all | 455 | 12 (each `@a.name`, a property) |
| of them, to a function | 14 | 0 |
| of them, to a constant holding a function | 199 | 0 |
| of them, to a constant that holds the result of a call | 240 | 0 |
| A call or `new` of a top-level constant that holds the result of a call | 365 | 2 |
| A call or `new` through a namespace import, of something declared in the corpus | 309 | 0 |
| A decorator through a namespace import | 0 | 0 |

What it says about each:

1. **A decorator factory held in a constant** (`export const Get = createMappingDecorator(...)`)
   is the largest of the three: 587 called decorators and 240 bare ones on n8n, 201 on nest.
   A top-level constant that is not a function has a chunk and no symbol row, so no edge can
   end on it, and the scorecard's reference has no pair for it either: the gap is invisible
   to the instrument. Reading these needs a symbol for such a constant, which changes what
   `mast_search`, `mast_signature` and `mast_exports` return. That is a decision about the
   symbol set and is not taken here.
2. **A decorator with no parentheses** names something that has a symbol at 213 sites on
   n8n and none on nest. An edge for one needs the scorecard's reference to count a
   decorator as a call first. 240 more are blocked on item 1. It stays in reserve: one
   corpus, and it changes what the instrument counts.
3. **A namespace import** carries no decorator in these projects (the 19 pairs found earlier
   are in projects not read here), and 309 ordinary calls on n8n. It is not a decorator
   question; it is the namespace-import work already next in the order.

## A corpus with its packages installed (2026-10-09)

`spikes/s8-installed-packages/`: nest's `sample/01-cats-app` (19 files indexed), copied, with
`npm install --ignore-scripts` (793 packages). Scored with `node_modules` in place and again
with it moved aside:

| | Program source files | Call pairs: agree, wrong, lacks, extra, unjudged |
|---|---|---|
| With `node_modules` | 828 | 4, 0, 0, 0, 0 |
| Without | 189 | 4, 0, 0, 0, 0 |

The app's 24 decorators are all imported from `@nestjs/common` or `class-validator`, except
`@Roles(...)`, which the app declares as a constant holding the result of a call. None has
an edge and none has a pair in the reference, with the packages or without: the index holds
no symbol under `node_modules`, and the reference counts a pair only when both ends have
one. Installing the packages changes what the compiler resolves and nothing that is scored.
One small app; a monorepo with its packages installed was not run.

## What P2 costs an index (2026-10-09)

`spikes/s7-index-cost/`: n8n indexed from nothing by the build of `0cfcfcd` and by the build
after P2, in turn, three rounds, so both meet the same load. The machine was not quiet: the
load average was between 16 and 94 when the runs began.

| Round | Before: wall, max resident | After: wall, max resident | Load at start, before / after |
|---|---|---|---|
| 1 | 169.5 s, 519 MB | 223.7 s, 388 MB | 16.1 / 24.9 |
| 2 | 112.7 s, 583 MB | 135.5 s, 483 MB | 22.3 / 22.3 |
| 3 | 138.3 s, 485 MB | 181.7 s, 455 MB | 17.8 / 93.7 |

The build after P2 was slower in each round, by 32%, 20% and 31%. Round 2 is the only one
where both runs began under the same load, and it has 20%. Memory did not rise in any
round. Both builds index 13,985 files into 73,385 chunks; the call edges are 45,834 and
52,902.

This is a direction and not a figure. Three rounds on a loaded machine do not separate a
20% cost from a 30% one, and where the time goes was not profiled: 7,068 more edges is 15%
more edges, and every decorator is one more scope walked. A run on a quiet machine, and a
profile, are owed before the number is quoted anywhere.

## Calls through a namespace import (2026-10-10)

Next in the agreed order after P2. Before it, `import * as ns from './x'; ns.f()` stored no
edge: the import row has no names, so nothing placed `f`.

### The spike (`spikes/s10-namespace-imports/`)

`sites.mjs` asks the compiler, for every call and `new` whose callee is a chain of names
rooted in a module namespace, what is called. Sites, not pairs. Callees declared in the
corpus only.

| | n8n, six projects | vscode | directus `api` | nest | this repository |
|---|---|---|---|---|---|
| Calls and `new`s read | 391,673 | 803,996 | 63,561 | 8,277 | 4,729 |
| `ns.f()` through `import * as ns`, to a function or a constant holding one | 303 | 14,227 | 2 | 0 | 0 |
| `ns.f()` through `import * as ns`, to another kind of constant or binding | 5 | 1,067 | 12 | 0 | 0 |
| `new ns.C()` through `import * as ns` | 1 | 1,037 | 0 | 0 | 0 |
| `ns.a.f()` and deeper through `import * as ns` | 0 | 1,087 | 0 | 0 | 0 |
| `ns.f()` where `ns` is a named import of a namespace another file exports | 746 | 0 | 0 | 0 | 0 |
| Type references written `ns.T` | 67 | 6,678 | 0 | 0 | 0 |

Three things the first count (309 on n8n, in s9) did not show:

1. **It is a vscode-sized gap, not an n8n-sized one.** n8n writes named imports. vscode
   writes `import * as dom` throughout: 15,264 sites of the two simple forms.
2. **n8n's larger namespace form is another one.** 746 sites go through
   `import { NodeHelpers } from 'n8n-workflow'`, where the package's index file has
   `export * as NodeHelpers from './node-helpers'`. mast stores nothing for that line
   (D096), so the rule below cannot place these. Not built here.
3. **Nearly all of it is declared in the imported file** (vscode: 14,137 of 14,138 calls
   to a function). The re-export chain matters on n8n only (73 of 303).

### The change

Rule 11 of MAST_SPEC §10.3.1. The extractor collects the file's namespace imports by local
name. A call `ns.f()` or `new ns.C()` whose `ns` is one of them, and is not a local, a
parameter or a nested function's parameter at that point, is recorded as a call of `f`
(`resolution` `import`) or a construction of `C`, with the import's module. From there it
is placed as a named import of the same name is: the import row gives the file, and the
lookup follows re-exports. Nothing new is stored and the schema is unchanged.

`new a.B()` was not parsed at all before. It is now parsed, and read through a namespace
only.

Tests, each seen failing first: nine in `call-edges.test.ts` (the two forms, a method
scope, an import with a default beside the namespace, three kinds of shadowing, the member
of a member, `new a.B()` on a named import) and four in `reexport-shapes.test.ts` (the
imported file with a decoy beside it, a star re-export, an incremental run after the
imported file is edited, an external module). The P2 test that pinned `@orm.Entity()` as
not read now pins it as read. Two checker test files used a namespace import as their
example of a call the heuristic resolver does not read; they now use a namespace another
file exports, which it still does not.

### Measured

| Corpus | Call pairs that agree, before | after | Wrong | Extra |
|---|---|---|---|---|
| n8n, 80 projects (`s1/run.mjs`) | 52,857 | 52,982 (+125) | 0 | 0 |
| vscode `src/tsconfig.json` (scorecard) | 139,715 | 143,957 (+4,242) | 47 → 53 | 0 |
| shapes corpus, `namespace-import` | 1 | 6 | 0 | 0 |
| this repository | no pair moved | | | |

On vscode 4,242 pairs went from `lacks` to `agree` and none that agreed was lost
(`vscode-cards-summary.json`). `compare` still fails there, on 6 newly wrong and 4 newly
unjudged edges. Both were run down on a fixture scored by the build before and the build
after (`js-beside-dts.sh`):

- **The 6 wrong** all end in `src/vs/base/common/marked/marked.js`, which has
  `marked.d.ts` beside it. The compiler names the declaration file and mast names the
  file the code is in. The build before gives the same verdict for a named import of such
  a module. It is the scorecard's, filed as D162, open; the edges are to the right
  functions.
- **The 4 unjudged** are tagged templates, `css.inline\`...\``. tree-sitter reads a tagged
  template as a call, so mast stores an edge, and the reference does not count one. The
  build before does the same for a bare `inline\`...\``. A tagged template does call its
  tag; this is a gap in the reference, noted with the other scorecard gaps.

vscode was indexed and scored with nothing installed. Its 9,643 pairs still lacking under
`ident.m()`, other file, were not broken down.

### The review, before the commit

A reviewer was given the diff and asked to find where the rule is wrong. Each finding was
reproduced as a failing test before anything was changed.

- **An incremental run left the importer's edges out of date.** An incremental run finds
  the files to resolve again by the names their import rows list, and the row of a
  namespace import lists none. In 10 of the reviewer's 28 edits the stored graph differed
  from a full index: two kept an edge to the wrong file (a named re-export pointed at
  another file; the imported file gaining a name its star also supplies), eight lacked
  edges (the imported file, or one behind it, gaining the name). The same edits with a
  named import were equal. Fixed in `findImportersOfNames`: a row that lists no name is
  taken to import every name. Such a row is also what `import './x'` leaves, so a file
  that imports another for its effect is resolved again when that one's exports change;
  this costs time and stores nothing wrong. Nine tests in `reexport-shapes.test.ts`, all
  failing without the fix. This was caught before it was committed, so it has no ledger
  row.
- **Two shadows the scope walk did not know** (D163, older than the rule): a function
  expression's own name, and an `enum` declared in the function. Fixed, four tests.
- **A default export behind a star** (D164, older than the rule, in the placing of every
  imported name): fixed for code that compiles, one test.

Reported and not acted on: wrong edges in code with two declarations of one local name,
which does not compile; a `using` declaration as a shadow, not reproduced here.

### Left open

- **A namespace another file exports** (`export * as ns from`, then `import { ns }`): 746
  sites on n8n, none on the other four. It needs a stored record of what a namespace
  export stands for, which D096 removed because the record it had was wrong. That is a
  new stored row and a decision of its own.
- **`ns.C.m()`**: 1,087 sites on vscode of `ns.a.f()` and deeper, 362 to a function (a
  TypeScript `namespace` inside the module) and 380 to a method. Not read.
- **A type written `ns.T`**: 6,678 references on vscode. A parameter annotated so gives
  its method calls no edge. Not measured as pairs.
- **Not measured:** what the rule costs an index. It adds one map per file and one lookup
  per member call.

## A caller listed twice (D156, 2026-10-10)

`mast_callers` and `mast_rename_impact` left a chunk out of the potential matches only
when it started on the line of a verified caller, and a verified caller's line is its call
line. So the two matched only when the call was on the declaration's first line.

**The spike** (`spikes/d156/overlap.mjs`): the 200 top-level names with the most stored
calls into them and one declaration each, asked of the real tool, on nest and n8n.

| | nest, before | after | n8n, before | after |
|---|---|---|---|---|
| Potential entries | 2,457 | 1,675 | 5,409 | 2,189 |
| ...whose chunk holds a verified call | 692 | 96 | 2,980 | 16 |
| ...naming the file and symbol of a verified caller, not covered | 186 | 0 | 357 | 101 |

Of the chunks holding a verified call before the fix, 39 on nest and 128 on n8n also
mention the name on a line that is not a call of it (an import, a type, a comment, the
name as a value).

**The rule.** A chunk is left out when a direct verified caller's symbol starts on the
chunk's first line, or when the chunk is a later piece of that same symbol and holds the
call line. The first version of the rule, a call line anywhere inside the chunk, would
have dropped a class's chunk for a call in one of its methods; a test pins that it is
kept. A transitive caller covers nothing.

**Given up:** a chunk that is left out and also mentions the name without calling it has
no entry of its own any more. The verified entry names the same symbol.

**Not done:** the 50-row cap is applied to the search hits before this filter, so the
list can be shorter than 50 while `potential_truncated` says more exist. The 101 entries
on n8n and the 96 and 16 chunks still holding a verified call were not examined; a class
chunk around a calling method is one kind that is kept on purpose.

## Two gaps in the scorecard (D162, D165, 2026-10-10)

Both were found by the vscode `compare` of the namespace rule, where right edges stopped
the change.

- **A `.js` with a `.d.ts` beside it** (D162). The reference named the declaration file,
  mast the script. Now a declaration in such a file stands for the script's declaration of
  the same name, when mast has one, and an import of it resolves to the script.
- **A tagged template** (D165). The reference did not visit one, so mast's edge had nothing
  to be compared with. It is now a call of its tag.

Measured, the same index scored by the scorecard before and after
(`spikes/s11-scorecard-gaps/`):

| Corpus | Call edges wrong | Unjudged | Imports wrong |
|---|---|---|---|
| shapes corpus | 4 → 0 | 3 → 0 (the new `tagged-template` fixture) | 1 → 0 |
| vscode `src/tsconfig.json` | 53 → 47 | 5,625 → 5,619 | 43 → 0 |
| n8n `packages/cli` | 0 | 4 → 0 | 0 |
| n8n `packages/core`, this repository | no key moved | | |

Nothing that agreed was lost on any of them. On vscode the 15 pairs the reference had to
`marked.d.ts` became 6 that agree and 9 mast lacks, now named in `marked.js`.

Not examined: the 47 edges still wrong on vscode, and its 5,619 unjudged. Not looked at:
what the checker pass writes for a call into a `.js` with a `.d.ts` beside it.

## A namespace another file exports (2026-10-10): tried, withdrawn

Left open by the namespace rule as "needs a stored record of what a namespace export
stands for". An attempt to do it with no such record was written, measured, reviewed and
taken out before any commit. The patch is `spikes/s12-exported-namespace/first-attempt.patch`.

**What the 746 sites on n8n are.** The spike counted them as "a named import of a
namespace". `packages/workflow/src/index.ts` has `import * as NodeHelpers from
'./node-helpers';` and, further down, `export { LoggerProxy, NodeHelpers, ObservableObject,
TelemetryHelpers };`. The form is an import that is then exported, not `export * as ns
from`. n8n has 139 lines of the `from` form (text search); how many of the 746 sites go
through one was not counted.

**What is already there.** For `import { NodeHelpers } from 'n8n-workflow';
NodeHelpers.getContext()` the extractor records a static call of `NodeHelpers.getContext`
on that import, as for `Class.method()`. It finds nothing because `index.ts` has no symbol
`NodeHelpers`.

**The attempt.** The import row of a namespace import keeps its local name (`aliases`,
`{ "NodeHelpers": "*" }`). When the owner of `Owner.member` did not resolve in the file
the import names, and that file had no symbol called `Owner` and bound `Owner` with a
namespace import, the member was looked up in that import's module.

**Measured, with the attempt.** n8n, 80 projects: 52,982 call pairs that agree to 53,109,
of which 4 are the tagged templates the scorecard now counts, so 123 from the rule; 0
wrong (`spikes/s12-exported-namespace/n8n-after.json`). `packages/core` +17, `packages/cli`
+42. No other corpus has such a site.

**Why it was withdrawn.** A reviewer was asked to find where it is wrong and did; two of
the findings were reproduced here as failing tests before anything was decided.

- *Wrong edges in code that compiles.* The lookup never knew that the file exports the
  namespace. Its guard, "no symbol of that name in the file", is blind to everything mast
  has no symbol for: a `const` object, an `enum`, a TypeScript `namespace`, a name that
  arrives by `export *`. Reproduced: `c-index.ts` is `import * as dom from
  './a-unrelated'; export * from './b-ns';` and `b-ns.ts` exports the real `dom`; the edge
  went to `a-unrelated.ts`. Reported and not reproduced here: the same with `export *`
  of a package, with `export * as dom from`, with `export { other as dom }` where `other`
  is a namespace, and for a typed receiver (`c: Client`, `c.send()`), since the lookup
  serves every `Type.member`.
- *Repair reached unrelated files* (reported, read in the code, not reproduced): a
  namespace's local name joined the changed names, and markers and aliases are looked up
  by name over the whole index, so a common name (`utils`, `path`) pulled in every file
  with a marker of that name and their importers. A file with a namespace import reported
  a changed name on every edit.
- *Incremental unlike full* (reported): when the namespace's module is created after the
  index, and for `import d, * as ns` then `export { ns }`.

n8n scored 0 wrong because it has none of these shapes, not because the rule was right.

**What a rule needs.** A stored fact "this file exports name N, and N is all of module M",
written by the extractor from `export { ns }` of a namespace import and from `export * as
ns from`, which it can both see. Then the lookup asks that fact and nothing else, an
`export *` passes it on as it passes a marker on, and repair follows it from M to the
files that import N from that file. That is a new row and so a decision; it is not taken
here.

**Kept from the attempt.** The local name on the import row. It fixes D166: the row of
`import d, * as ns` lists `default`, so repair did not know it for a namespace import and
did not resolve its file again. One test, seen failing. An index built before has no local
name on its rows; a row that lists no name is still resolved again, as before.

## A namespace another file exports, with a stored record (2026-10-10)

Decision taken (the user, 2026-10-10): the record asked for above is stored, in the
unreleased schema 1.4.0 with no bump.

**The record.** A column on the import row, `imports.exported_as`: a JSON array of the
names under which the file exports all of the row's module. Written by the extractor for
`import * as ns from './m'` followed by `export { ns }` or `export { ns as other }`, and
for `export * as ns from './m'`, which gets an import row though it binds nothing in the
file. A column and not a table, because the row already has what the record needs: the
file the specifier resolves to, kept current by repair, and the lifetime of its file.
Type-only forms record nothing (`export type { ns }`, `export { type ns }`, `export type
* as`, `import type * as`).

**The rule (MAST_SPEC §10.3.1, rule 12).** For `Owner.member` called on an imported name,
the file the import names is asked whether it exports all of a module as `Owner`. If it
does, `member` is resolved in that module as an import of it would be, and nothing else is
tried. The answer comes from `exported_as` alone. Only when the import names the file that
holds the row: a further `export *` or `export { ns } from` hop is not followed.

**Repair.** A change in module M is a change of name N in every file that exports M as N,
so that file joins the sources and N the changed names, to a fixpoint. The exported name is
part of the import row's signature, since `export { ns }` can sit outside every chunk.

**Measured** (`spikes/s13-exported-namespace-row/`, scorecard reference, final build):

| Corpus | Call pairs that agree, before | After | Wrong after |
|---|---|---|---|
| n8n, 80 projects | 52,982, and 4 the scorecard now counts | 53,122 | 0 |
| n8n `packages/core` | baseline of `26ee330` | +17 | 0 |
| n8n `packages/cli` | baseline of `26ee330` | +53 | 0 |
| shapes | 3 pairs `lacks` | 3 pairs `agree` | 0 |

136 pairs on n8n come from the rule (edges stored as `static_method`, 547 to 683); the
attempt above gave 123. The n8n index holds 628 import rows with the record, in 183
files, 137 of them the `export * as` form, none unresolved. The 80-project score was run
before and after the changes the review led to and is the same.

**Review.** A reviewer was asked to break it, with the list of what broke the first
attempt. All of those hold now (re-run by the reviewer: a private namespace import beside
a star that supplies the name, `export { other as dom }`, a namespace exported under
another name only, `export *` of a package, a typed receiver, the module created after
the index, `import d, * as ns`). Incremental equalled full in every sequence it ran, in
both file orders. What it found, each reproduced here or read in the code before anything was
changed:

- **A wrong edge the rule reaches but did not make (D167).** A default export in the file
  an import names was reached by its declared name though a star in that file supplies
  the name. Older than the rule; fixed in the same commit, with a shapes fixture.
- **Four forms the extractor misread**, each losing an edge and none adding one: a comment
  inside `export * /* c */ as ns`, a string name kept with its quotes, and `import type *
  as ns; export { ns }` recorded as a namespace. Fixed, each with a test seen failing.
  The fourth, `export * as ns from './m' with { ... }`, is not the rule's: the grammar
  (tree-sitter-typescript 0.23.2) parses no `export ... from` with import attributes, so
  `export * from './m' with { ... }` is lost the same way. Not fixed.
- **Repair does needless work when the module matches no file.** With `export * as data
  from './generated'` unresolved and 30 files importing `data`, a rename in an unrelated
  file re-resolved 31 files (`repair-fan-out.out.txt`); 0 with the module resolved. The
  clause that causes it is needed for a module created later that holds only `export *`
  (a test, seen failing without it). Left as it is: n8n has no unresolved row.
- **Parts no test held.** Six mutants survived the reviewer's run. Tests now kill the
  exported name in the import signature, the unresolved rows in repair, the `from` check,
  and the type-only import. One survivor was a stop for `ns.C.m()` that nothing can
  reach, since the extractor emits no such name; the stop is removed and the form pinned
  as not read. `findReExporters` reading the record is still held by no test; the
  reviewer could not make it matter and neither was it tried here.
- **The test dumps could not see the column.** `dumpGraph` in the test fixture and
  `eval-suite/replay-check.mjs` now carry it.

Reported and not reproduced here: on n8n, changing one name of a module exported whole
re-resolves a median of 2 more files, at most 60 (`packages/workflow/src/node-helpers.ts`),
by a replay of the loop over stored rows and not by an incremental run.

**Not done, not measured.**

- An index written by an earlier build of 1.4.0 has the column empty and is not rebuilt;
  each file is filled in when it is next extracted. No such build was released.
- What the rule costs an index run was not measured: the machine was too loaded for an
  A/B. One more indexed lookup per `Owner.member` call that reaches the import's file.
- `mast_dependencies` now lists the module of an `export * as`, with no names. The other
  re-export forms still have no import row.
- `exported_as` is also a field of `mast_rename_impact` output with another meaning (the
  name a barrel exports a symbol under). The column was not renamed.
- Not read: `new ns.C()`, `ns.C.m()`, a type written `ns.T`, a namespace reaching the
  importer through a further hop, `export default`, `export =`, `export import`,
  `export { type as ns }` of a namespace import called `type`.
- `.mjs` holders get no import rows and `.jsx` consumers no call edges, both before this
  rule (the reviewer's run), so the rule was not judged there. Not filed, not reproduced.

## `ns.C.m()` and a type written `ns.T`, measured (2026-10-10): spike only, nothing built

The two forms the namespace rules leave. Before any design, what the sites are
(`spikes/s14-namespace-members/members.mjs`, the compiler, sites and not pairs).

| | vscode `65f2c060`, 8,063 files | n8n `9d9e9bf9`, six projects, 5,936 files |
|---|---|---|
| `ns.a.f()` sites | 1,255 | 95 |
| of them: `a` a class, `f` a static method, in the corpus | 112 | 0 |
| of them: `a` a TypeScript `namespace`, `f` in the corpus | 359 | 0 |
| of them: `a` a constant holding an object literal | 317 | 0 |
| of them: nothing resolved (a package that is not installed) | 226 | 0 |
| `x.m()` where `x` is a parameter, local or `this.f` annotated `ns.T` | 1,161 | 68 |
| of them: callee in the corpus | 677 | 1 |
| of them: `T` a class, `m` a method, in the corpus | 278 | 1 |
| of them: `T` an interface, callee in the corpus | 387 | 0 |

The rest of n8n's sites have a callee outside the corpus. Directus, nest and this
repository had no such site in s10 and were not run again.

**The 6,678 type references are 677 calls.** s10 counted references to a type written
`ns.T`. What a rule would gain is the method calls on a receiver annotated so, and on
vscode those with a callee in the corpus are 677 sites.

**What mast stores today** (`fixture/`, `fixture.out.txt`, the build of `2dfc454`): a
function declared inside `export namespace X { ... }` has no symbol row, and neither has
a method of an interface. So of the sites above, an edge has something to point at for
the 112 static methods and the 278 methods of a class: 390 sites, on one corpus, of the
803,996 calls s10 read there. The 359 namespace functions and the 387 interface sites
need symbol rows that do not exist, for every way of reaching them and not only through
a namespace import. That is a larger change with its own measurement.

**Not decided.** Whether 390 sites on one corpus, and 1 on the second, is worth two more
extractor forms. By the rule this proposal has followed (a second corpus before a rule),
it is not yet. The larger gap this spike points at is the missing rows, which was not
sized: how many calls in each corpus go to a function in a TypeScript namespace or to a
method of an interface, by any route.

s10's table gives 1,087 for "`ns.a.f()` and deeper"; its own counts sum to 1,255 `ns.a.f()`
sites, 1,021 of them in the corpus, and 65 deeper. The 1,087 was not re-derived.

