# Proposal — link a call to a method the receiver's class inherits

Opened 2026-10-07. Status: **proposal; spike S1 run on this repository and on n8n
(`spikes/RESULTS.md`). Decisions taken 2026-10-07; no code written.** No ADR number taken. Numbers on this page are
quoted from the spike's results or its raw files.

## The problem

A call gets an edge only when the class the resolver lands on declares the method itself.
`581b681` added one exception: `this.m()` is looked for on the class named in the file's own
`extends` clause. Everything else that inherits is unlinked:

- `this.repo.find()` where `repo`'s class extends the class that declares `find`,
- the same through a parameter or a local,
- `this.m()` declared two or more classes up.

`MAST_SPEC.md` §10.3.1 lists these as not caught. `mast_callers Repository.find` on n8n
returns none of the 170 callers that reach it through a subclass.

## Prior decisions this touches

Sweep on 2026-10-07 over `adr/`, `FINDINGS.md`, `MAST_SPEC.md`, `.history/` and
`docs/defects/` for inheritance, ancestors and `EXTENDS`.

1. **No earlier decision on walking a class hierarchy.** The only text is the one written
   this week: §10.3.1's list of what is not caught, and the comment in
   `src/graph/populate.ts` that one step up is all a file's own records can support.
2. **A stored call edge is a resolved call** (ADR 007). An unresolved call stores no row.
   Alternative C below would reverse this.
3. **Structural edges resolve by the file's own evidence, never by a name match across the
   graph** (D085; `incremental-graph-correctness/spikes/s6-structural-fallback`, 27 of 27
   name matches wrong on n8n). The walk reads stored edges, which were placed by that
   evidence. It adds no name match.
4. **Pass 2 is staged so the result does not depend on file order** (D083, M1 of
   `incremental-graph-correctness/PROPOSAL.md`: star rows, then named re-exports, then all
   other edges; 1,939 edges were lost on n8n before it). This proposal adds a stage.
5. **The graph after an incremental run must equal the graph after a full index**
   (`incremental-graph-correctness/PROPOSAL.md`, the requirement). Repair finds the files to
   resolve again by the edges into a re-written file and by the names it gained or lost
   (M3, M3b). Storing unresolved records in a table was held (M4), and a table to protect 7
   guessed edges was rejected (promotion log, 2026-10-07).
6. **Repair of files that only import is bounded by time and reports what is left**
   (decided by the user 2026-10-06: about 2 s, cap and report).
7. **Better no edge than a wrong one** (`resolveCallTarget`'s contract, §9 "safe to act on").

Nothing found decides against the walk. Decisions 4 and 5 are what make it more than a
lookup.

## The requirement

- A call on a receiver whose class is known links to the nearest class above it that
  declares the method, however many steps up, when every class on the way is indexed and its
  `extends` is one the resolver can place.
- No edge when the chain leaves the index (a parent in `node_modules`), is ambiguous, or
  loops.
- The result does not depend on the order files are written in.
- After any incremental run the edges equal those of a full index.

## What the spike found

1. **The gain is real and it is mostly one step, not depth.** n8n gains 1,064 edges (69,414
   to 70,478) and loses none. 930 are field receivers. Of the linked records, most go one
   class up; none goes three.
2. **Every judged new edge is right.** 941 of 941 on `packages/cli`, 9 of 9 on
   `packages/core`. 114 in other packages were not judged.
3. **Written in one stage, 287 of the 1,064 are silently missing.** Structural edges have to
   be in place before any call is resolved.
4. **The stored edge reproduces the present one-step rule exactly**: all 1,072 edges that
   rule writes on n8n come back from the walk. One mechanism can replace it.
5. **An edit can put out of date callers that repair cannot find today.** Finding them by
   name reaches at most 1,620 files for one edited file (median 0, p99 821, only when a
   class's members or parent change). Finding them from a stored record reaches at most 116
   (median 1, p99 32) and needs 4,905 rows and a write on every file write.
6. **Cost is not measured.** The machine was too loaded for the three timings to mean
   anything.
7. **Two unrelated defects in the committed build**, found because `packages/cli` had not
   been judged before: D104 and D105.

## Design reserve and what the evidence promotes

| # | Mechanism | Verdict |
|---|---|---|
| M1 | A stage in pass 2 for `EXTENDS`, `IMPLEMENTS` and `PARENT_OF`, before call edges | **Promote.** Finding 3 |
| M2 | When `T.m` finds no symbol, follow the stored `EXTENDS` edge from `T` and look for the member in each class's own file. Applies to every resolution that names a class: `this_method`, `super_method`, `field_type`, `parameter_type`, `new_expression`, `static_method`. Replaces the by-name step from `581b681`. The edge keeps the resolution it has today; no new value | **Promote.** Findings 1, 2, 4. `static_method` linked nothing on n8n; it is included because leaving it out is the special case |
| M3a | Repair by name: when a class's members or its `extends` edge change, resolve again the files that declare or import a class below it | **Promote, as the recommendation.** No new table; reuses `findImportersOfNames`. Over the time bound it reports what is left, as M3b does |
| M3b | Repair by record: a table of (file, class its walk passed through), read before a file's rows go | **Hold.** A tenth of the reach, at the price of a table and a write path, which is what M4 was held for |
| C | Store the call against the receiver's class with the member's name, and find the declaring class when a tool asks | **Reject.** Reverses ADR 007, needs the member in the key of `edges`, and every reader of edges has to learn the new row |
| R1 | A constructor inherited from a parent: `new X()` where `X` declares none | **Reserve.** Not walked in the spike. `packages/core` lacks 2 construction pairs; whether these are them was not checked |
| R2 | A class with two stored `extends` edges (6 on n8n) | **Reserve.** The spike took the first. Proposed: no edge when there are two |
| R3 | Interfaces and receivers annotated with a union | **Reserve.** Not looked at |

### What M3a has to get right

This is the part with a history (D080 to D095), so it is stated in full.

- **Order inside repair.** Re-writing a file deletes the `extends` edges into it. A file
  below it that is resolved before those are back loses its walked edges. So every candidate
  that holds an `extends` edge is resolved in the first group, with the written files and
  the re-exporters, outside the time bound; and M1's stage runs there too.
- **What counts as a change.** A member appearing or disappearing is already seen
  (`changedExports`). A class's `extends` edge changing is not: the surface does not hold it.
  It has to be read before the rows go and compared afterwards.
- **A change made by repair itself.** A file resolved again may gain or lose its own
  `extends` edge (its parent's file was added or deleted). That is a change of the same kind,
  for the files below it.
- **Which files.** The classes below the changed class along stored edges, read before the
  write for the edges that the write deletes; then the files that declare them and the files
  that import them.

## Decisions that are the user's

1. **How repair finds the callers**: by name (M3a, recommended) or by a stored record (M3b).
   M3a can leave up to 1,620 files to resolve after one edit on n8n, and past the time bound
   they wait and are reported. M3b keeps that to 116 and adds a table.
2. **R1, inherited constructors**: fold into the same walk, or leave. Recommended: fold in,
   after checking the two `packages/core` pairs.
3. **D104 and D105**: fix now, ahead of this work. Recommended; they are wrong edges in what
   ships today and neither depends on anything here.

**Decided 2026-10-07 (user): yes to all three.** Repair finds the callers by name (M3a);
inherited constructors are folded into the walk (R1 promoted, the two `packages/core` pairs
still to be checked first); D104 and D105 are fixed ahead of this work.

## Test work list

Each seen failing first.

- T1. `inherited-method-edges.test.ts`: a field, a parameter and a local typed as a subclass,
  calling a method one, two and three classes up; `this.m()` and `super.m()` two up; a
  static two up.
- T2. No edge: the parent is not indexed; the parent is a default import; a class extends
  itself through two files; a class with two stored parents.
- T3. Order: the same project indexed with files in path order and reversed gives the same
  edges (the D083 test, with a three-class chain across three files).
- T4. `reexport-shapes.test.ts`: the parent reached through each of the ten chain shapes.
- T5. Incremental equals full, as scenario rows: add and remove the method on the parent and
  on the grandparent; add an override in the middle class; change `extends` in the middle
  class; delete and add the middle file; rename the parent class.
- T6. The generated edit sequences (T10 of the incremental work) gain edits to a class
  hierarchy, so the replay check covers what T5 did not think of.
- T7. The checker comparison on `packages/core` and `packages/cli`: no edge on another
  declaration that was not there before.

## Order of work

1. D104 and D105 (decision 3). **Done 2026-10-07**; `spikes/RESULTS.md`, "After the fixes". D106 was found on the way and is open.
2. M1 and M2 with T1 to T4 and T7. Full index only is correct at this point.
3. M3a with T5 and T6. Not shipped until the replay check is clean.
4. `MAST_SPEC.md` §10.3.1, and a measurement of the cost on a quiet machine.

## Method

Exploratory spike work, the same class as `graph-reference/spikes/`. Not a registered
experiment; it settles no `FINDINGS.md` claim.

## Not known

- What the walk and the extra stage cost in index time.
- Whether a second real corpus with deep hierarchies behaves like n8n. This repository shows
  nothing either way.
- Whether M3a's four rules are complete. Only T5 and T6 can show that.
- Whether the 114 unjudged edges are right.
