# Proposal — a reference graph built by the TypeScript checker, to compare mast's graph against

Opened 2026-10-07. Status: **proposal; spike S1 run on this repository and on n8n `packages/core`**
(`spikes/RESULTS.md`). The numbers in this page are quoted from a committed artifact or were
read from this repository's index before the spike; the spike's own numbers are in its results.

## The problem

Every check we have on the graph compares mast with mast. The equivalence oracle and the
replay check (`eval-suite/replay-check.mjs`) say the incremental path and the full path agree.
They cannot say either is right, and D087 and D096 are both gaps the two paths share.

The public claim is stronger than what is checked. `README.md:907` says verified callers are
"definitive, no false positives from name collisions". D096 is a counterexample found by
hand: an edge to the wrong declaration, stored as verified.

So two numbers do not exist for any repository:

- **Wrong edges.** Of the edges mast stores, how many point at a declaration the call does not
  reach?
- **Missing edges.** Of the calls the compiler can resolve to an indexed declaration, how many
  did mast store no edge for?

## Prior decisions this touches

Sweep on 2026-10-07 over `adr/`, `FINDINGS.md`, `MAST_SPEC.md`, `.history/`, `eval/` and
`docs/defects/`.

1. **mast already ships a checker pass.** `mast index --checker`
   (`src/graph/checker-resolver.ts`, `MAST_SPEC.md` §10.3.2). It takes the candidate call sites
   mast could *not* link and asks the checker about each. It does not look at the edges mast
   already stores and does not count calls mast missed. It is opt-in; this repository's index
   holds 0 edges with resolution `checker`.
2. **The July spike that led to it**, `eval/spikes/checker-edges/REPORT.md` (run 2026-07-15,
   in the kluster monorepo, TypeScript 5.9.3). What it settled, and this proposal reuses:
   - One program per tsconfig, released before the next. Holding 25 programs peaked at
     2.45 GB (Q2).
   - Import aliases must be followed with `getAliasedSymbol`. Without it the share resolving
     to the queried declaration read 2%, with it 38% (Q3, n = 50).
   - 11 of 50 sampled sites were in files no tsconfig covered (Q3).
   - Its agreement check (Q4) covered one resolution kind, `import`, on one fixture. The
     report's own limits say the other kinds "were not cross-checked against the checker".
     Q4b found a wrong verified edge by reading code, not by the comparison.
3. **`--checker` is listed as untested**, ADR 013 §3 row E5. ADR 018 adds that its tsconfig
   discovery does not enter dot directories.
4. **The shipped pass matches a declaration by file and a three-line tolerance**
   (`src/graph/checker-resolver.ts:298`). A reviewer raised this during the incremental work;
   it was not re-run (`incremental-graph-correctness/PROPOSAL.md`, "Not known").
5. **`POTENTIAL_CALL` is a resolved call**, ADR 007: an unresolved call stores no row. So a
   missing edge leaves no trace in `graph.db`, and only an outside reference can count it.
6. **The spec limits what the resolver claims.** `MAST_SPEC.md` §10.3.1 lists six cases it
   catches and a list it does not. A "missing edge" outside the six is a known limit, not a
   defect, and the comparison has to report the two apart.
7. **GitNexus comparison**, `eval/GITNEXUS_COMPARISON.md` §6: accuracy was judged against
   `grep` counts on a handful of symbols. No compiler was used.

Nothing found decides against building a reference. Nothing found already is one.

## The requirement

A script that, for a repository, builds the set of edges the TypeScript checker supports, in
the line format the replay check already dumps
(`edge|type|resolution|file:name@line|file:name@line`), and reports against mast's graph:

- edges mast has that the reference contradicts (**wrong**),
- edges the reference has that mast lacks (**missing**), split by whether the spec says mast
  should catch them,
- edges neither can judge (file outside every tsconfig, receiver typed `any`), counted and
  never folded into "agrees".

It must not import `src/graph/checker-resolver.ts` or any resolver code from `dist/`. Reading
`graph.db` for mast's side is the comparison, not a dependency.

## Questions the spike answers

Throwaway code under `spikes/`, raw output kept beside it, on two corpora: this repository
(one tsconfig, dependencies installed) and one n8n package from a copy of the checkout.

- **Q1. Join key.** Does "declaration file and line" match a mast `symbols` row exactly for
  every edge kind, or is a tolerance needed? Measure the miss rate at exact match first. This
  repository's index, as the MCP server had kept it, held 640 `POTENTIAL_CALL` edges (a full
  index then gave 705; a server left running on an older build explains it, see S2 in the
  results) (395 `same_file`, 224 `import`,
  8 `this_method`, 7 `new_expression`, 5 `parameter_type`, 1 `super_method`), 49 `PARENT_OF`,
  11 `RE_EXPORTS`, 9 `IMPLEMENTS`, 4 `EXTENDS`.
- **Q2. Caller side.** mast attributes a call to its enclosing indexed symbol. Can the
  reference reproduce that attribution from the syntax tree alone, without copying mast's
  chunking rules? Count the calls whose enclosing symbol the two disagree on.
- **Q3. Wrong edges.** On each corpus, how many stored `POTENTIAL_CALL` edges does the checker
  resolve to a different declaration, per resolution kind? Read every one by hand on this
  repository; sample on n8n.
- **Q4. Missing edges.** How many checker-resolved calls to an indexed declaration have no
  mast edge, split into the six cases of §10.3.1 and the rest?
- **Q5. What n8n needs.** The n8n checkout has no `node_modules` at any level (checked
  2026-10-07). With packages unresolved, which edges can still be judged? Count the calls
  whose receiver type is `any` or `error` for that reason. If that share makes the
  comparison useless, the next step is an install in the copy, and that is a decision for the
  user (network, disk, time).
- **Q6. Cost.** Wall time and peak memory per corpus, one program at a time.

This repository has no `field_type` edges, so that kind can only be judged on n8n.

## Design reserve

Thought through, not to be built unless a spike result asks for it.

| Mechanism | Would be promoted by |
|---|---|
| A tolerance on the declaration line | Q1 showing exact match fails for a reason that is not a mast defect |
| Structural edges (`EXTENDS`, `IMPLEMENTS`, `PARENT_OF`, `RE_EXPORTS`) in the comparison | Q3 and Q4 working for calls; these are cheaper and come second |
| A standing check in `eval-suite/` with a committed baseline | The spike producing a comparison stable across two runs |
| Using the reference to re-judge `--checker` (ADR 013 E5) | The user asking; it is a different question |
| JavaScript files | A corpus where they matter; `allowJs` changes what the checker infers |

## Decisions that are the user's

1. ~~Whether to install n8n's dependencies in the copy.~~ **Decided 2026-10-07 (user): install
   them in the copy.** n8n is also the only corpus for `field_type` edges, so it is required,
   not optional. Q5 changes accordingly: measure the unjudgeable share *with* dependencies
   installed, and record what the install needed (workspace packages point their types at
   build output, which a plain install does not produce).
2. What to do with what Q3 finds. Each wrong edge is a ledger row; whether to fix them before
   the two ADR 010 re-measurements is the order already agreed, but the size is unknown.
3. Whether the `README.md:907` claim is reworded now, on D096 alone, or after Q3.

4. Whether to judge edges between n8n packages. That needs either a build of the workspace
   packages in the copy, or a reference that maps each package name to its source. Neither
   is done; `packages/core` alone left 878 of 3,419 calls untyped for this reason.
5. What to do with D097, D098 and D099, and with the gaps the spec does not claim
   (construction, inherited `this.m()`, static calls, classes reached through a directory
   index).

## Method

This is exploratory spike work, the same class as `incremental-graph-correctness/spikes/`.
It is not a registered experiment and settles no `FINDINGS.md` claim. If its numbers are to
be quoted as settled, that needs a registration under ADR 010 first.

## Not known

- Whether the checker's answer is always the right reference. Overloads, declaration merging
  and re-exported namespaces give one symbol several declarations; which one counts is a
  choice the spike has to make and record.
- Whether a second corpus that is not a monorepo behaves like either of these two.
- How the reference should treat test files, which mast does not index.
