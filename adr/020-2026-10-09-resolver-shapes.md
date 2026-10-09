# ADR 020 — What a name, a member and an import mean to the call resolver

**Date of decision:** 2026-10-08 to 2026-10-09, one ledger row at a time.
**Record:** [`proposals/resolver-shapes/PROPOSAL.md`](proposals/resolver-shapes/PROPOSAL.md)
holds, for each row, the prior decisions looked for, the mechanisms weighed, the
measurements and what was not checked. Instruments:
[`proposals/resolver-shapes/EVAL.md`](proposals/resolver-shapes/EVAL.md). Raw data:
`proposals/resolver-shapes/spikes/`. This file states the decisions only; where it and
the proposal disagree, the proposal and the scored baselines win.

## Context

A review pass over the heuristic call resolver on 2026-10-08 filed ten ledger rows, D115
to D124. Most are a stored edge naming the wrong declaration. D122, and part of D121, are
a tool answering wrongly over right edges. The ledger rows record that the scorecard, on
the three corpora it then had, showed none of them. A fourth corpus was built from the
rows (`eval-suite/fixtures/resolver-shapes/`, baseline `eval-suite/baselines/shapes.json`).

Each rule the resolver had was right for the code its author had in mind and was applied
to more than that (`docs/defects/SHAPES.md`, S-02). The decisions below are the narrower
rules.

Decisions made earlier bound every row and are kept: better no edge than a wrong one; an
edge is stored against the declaring symbol (ADR 007); the heuristic resolver stays the
default and `--checker` is widened by a separate proposal; schema 1.4.0 is unreleased, and
an index of another version is rebuilt (ADR 019), so a column added under it needs no
version of its own.

## Decision

| Row | The rule now |
|---|---|
| D115 | A class's fields are kept on its row (`symbols.fields`). A walk to an inherited method stops at a class that has a field of the name |
| D116 | A receiver is typed by the declaration its own block, loop, `catch` or nested function sees. A `new` gives its class; anything else gives no edge |
| D117, D123 | Every name is read the same way: by the declaration in the smallest scope around where it is written. A local declaration hides an import of the name |
| D118 | A static and an instance member of one name are two members (`symbols.is_static`). A call is looked up on one side only. Edge repair compares the flag (D145) |
| D119 | A package subpath keeps the directory that names it. More is dropped only when what is dropped is the directory of one of the package's root entries |
| D120 | An import means a declaration only where its row is exported, in the imported file and behind every `export *`. Edge repair compares the flag |
| D121 | Two declarations of one name in a file are two rows. An edge record carries its declaration's line and goes on that row, or on the only row of the name. A lookup says whether a value or a type is meant. A tool asked about a name answers for every row of it in the file |
| D122 | A transitive caller walk that reaches a class goes on from the callers of its constructor |
| D124 | `export { a as b }` with no `from` keeps its row `b`, and an import of `b` is placed on `a` through `reexport_aliases` |

In every row the alternative of resolving by name across the graph was rejected, and a
case the narrower rule cannot place gets no edge.

## Consequences

Measured, from the four committed baselines as of the D124 commit (`db87e39`), edges as
agree / wrong / lacks / extra / unjudged:

| Corpus | `POTENTIAL_CALL` | Every other edge type |
|---|---|---|
| this repository | 902 / 0 / 28 / 0 / 0 | 0 wrong, 0 lacks |
| shapes corpus | 46 / 0 / 1 / 0 / 0 | 0 wrong, 1 lacks (`RE_EXPORTS`) |
| n8n-core | 930 / 0 / 195 / 0 / 0 | 0 wrong, 0 lacks |
| n8n-cli | 18,875 / 0 / 4,955 / 0 / 4 | 0 wrong, 0 lacks |

- No stored edge on any of the four is one the compiler places elsewhere. The cost is in
  `lacks`: a call the resolver will not place is listed under `potential_matches` and not
  as a verified caller.
- The scorecard changed with D121 (D147): an end of an edge on a name with more than one
  row is named by line. Baselines from before that commit are not comparable key for key
  on those names; `spikes/d121/renamed-keys.*.txt` accounts for each.
- Two columns were added to `symbols` under schema 1.4.0 (`fields`, `is_static`), and
  `reexport_aliases` gained rows for local aliases. No version changed.
- Each row has unit tests that failed before its change, and most have a scenario in the
  incremental equivalence suites. The counts are in the ledger rows.

## What it does not claim

- That the resolver is right on code outside the four corpora. The shapes corpus was
  written from the review's findings, and the same review style would likely find more.
- That `lacks` is small. On n8n-cli 4,955 of the 23,830 call edges the reference has (21%) have
  no stored edge.
- Anything about `--checker`. By the D121 review's reading of
  `src/graph/checker-resolver.ts`, not run, it still takes one row of a name, as do the
  checker verdicts of a tool answer.
- A separate adversarial pass for every row. D121 had one, and it found a regression
  before the commit. D122 and D124 did not have one.
- Timing. The index runs on n8n were single runs on a busy machine and are not a
  measurement of what any row costs.

## Open, with a ledger row

- D148: `export { default as x } from` was not followed. Fixed after this record was
  written (proposal, "D148"); the shapes corpus then has no `lacks`. `import x from` was
  D130, fixed the same way (proposal, "D130").
- D146 and D147 were found and fixed inside D121; D145 inside D118.
- D144, D131 and D139 were fixed after this record (proposal, under each id), and D149
  was found and is open: `mast_signature` asks for type context only for names that
  begin with a capital. D131 carries
  one decision of its own: an import names a declaration file only when no file that
  holds code answers to the specifier, so `x.js` beside `x.d.ts` stays on `x.js`. The
  compiler has the other order. In ten repositories 152 relative specifiers gain a file
  this way and 209 are such a pair and do not move.
- Each row's "Not fixed" list in the proposal: among them a shifted line landing a record
  on its sibling row (D121), a subclass that inherits its constructor in a transitive
  walk (D122), and `mast_rename_impact` listing an alias's export line only as an
  unverified match (D124).

## Held in reserve

- Widening `--checker`, by its own proposal and spike.
- A row for a field, and a `RE_EXPORTS` edge from a local alias to its declaration (D124,
  R3): each waits for a case that needs it.
