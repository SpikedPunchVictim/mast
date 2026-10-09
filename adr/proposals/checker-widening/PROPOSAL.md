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
| The pass | 216 s, 1,992 MB maximum resident size, on a loaded machine |

The pass adds 474 pairs to the 52,857 the resolver has. The first scored run of the pass
after P2 had 475 `checker` edges and one unjudged. That one was not a decorator: an ordinary
call in a setter, stored from the getter of its name (D159). With that fixed the setter's
call is the edge the resolver already stores, so the pass writes 474.

### Left open after P2

Found and not fixed:

- **D156**, open: `mast_callers` and `mast_rename_impact` list a verified caller a second
  time as a potential match. More decorator edges make more verified callers, so P2 makes
  it more visible; it did not cause it.
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

- What the change costs an index (no number for the build before it under the same load).
- Any corpus with `node_modules` installed. Neither copy has it, so every pair counted here
  is a decorator declared in the repository. What the reference and the resolver do with a
  decorator imported from an installed package was not run.
- A third repository. The directus and vscode copies were not scored for P2.
- JavaScript. Both corpora are TypeScript; a decorator in a `.js` file goes through the same
  code and is covered by no test or measurement.
