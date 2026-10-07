# Proposal — the graph after an incremental run should equal the graph after a full index

**Status**: draft, 2026-10-06. Spikes S0 to S5 are done. No code written. No ADR number taken;
this becomes ADR 019 once the design below is agreed. **Mode**: exploratory. Nothing here is
registered under ADR 010. Every number is in `spikes/` with the script that produced it.

## The problem

Six open defects, found on 2026-10-06, say the same thing from different sides: `mast_callers`
and the other graph tools answer from a graph that is missing edges or holds wrong ones, while
`mast status` reads fresh and every command exits 0.

| Defect | What happens | Measured size |
|---|---|---|
| D081 | Re-writing a file deletes rows owned by *other* files that point at it: call edges, `IMPLEMENTS`/`EXTENDS` edges, star re-export rows. Nothing restores them. Same on the query-time re-parse. | Replaying 200 n8n commits: 2,541 of 53,681 edges lost against a full index (4.7%), about 95% of them this defect. 100 mast commits: 54 of 669 (8.1%). This repository's own index after one working session: 17 of 669. (S2) |
| D083 | A full index misses edges through a barrel when the caller is walked before the barrel. | n8n: 1,939 of 55,620 edges missing from a fresh full index, including 1,263 of 8,844 import-resolved calls (14.3%). mast: 0. (S1) |
| D084 | A change that alters what an unchanged file's calls resolve to is not applied: a new name, a new file, a barrel re-pointed. | 37% of file changes in the n8n replay and 39% in mast's alter names or re-exports, or add or delete the file. At most 126 of the 2,541 lost edges are of this kind. (S2, S4) |
| D085 | `IMPLEMENTS`, `EXTENDS` and `PARENT_OF` targets are matched by name alone across the whole graph, first row wins. New, found by S2. | n8n full index: 239 of 17,650 `PARENT_OF` edges join a class to a member in another file; 435 of 3,154 `EXTENDS`/`IMPLEMENTS` edges target a name declared in more than one file. (S2) |
| D080 | A query-time re-parse also drops the file's own outgoing edges and star re-exports. The next incremental run repairs it only if the file has a star re-export. | scratch projects (S0) |
| D082 | Re-indexing a markdown file or a file with no chunks scans a whole FTS table. Cost only. | about 25 to 45 ms per file warm (S0) |

None was caught by the test suite. Of the test files that run an incremental index, one reads
an edge or star re-export row (`stability.test.ts`, the D079 tests, which read the edited
file's own rows). Of the four that call the query-time refresh, none reads an edge row. No test
compares an incremental result with a full index of the same tree. (Counted by grep.)

## Prior decisions this touches

Each was opened and read on 2026-10-06.

1. **Keeping symbol ids across a re-write was rejected in June, with the user.**
   `.history/003-2026-06-02-bug-fixes.md:327-330`; `MAST_SPEC.md` §7.1. The spikes found no
   need to reopen it (see M2 below).
2. **Delete-and-replace is the documented model.** `MAST_SPEC.md:2158-2160`. Kept.
3. **Checker verdicts rely on the cascade.** `src/graph/db.ts:156-166`. Re-run in S0: the
   verdict an edit deleted was one that had become wrong. Kept: the design below never keeps a
   row across a re-write, so the cascade still clears verdicts.
4. **Walk order was made repeatable, not irrelevant.** `eval/GITNEXUS_COMPARISON.md:1035-1039`;
   D003; `MAST_SPEC.md:2198-2200` lists re-exports not resolved at edge time as a resolver gap.
   S1 puts a size on it.
5. **Expanding the write set to importers has a measured bad case.**
   `eval/GITNEXUS_COMPARISON.md:129-144`: GitNexus pulled 1,028 of 2,030 files into one edit,
   23.4 s against mast's 379 ms. S3 reproduces the shape: following barrels by file reaches
   more than 1,000 files for 334 n8n files. The design must not do that.
6. **Pass 2 is batched under short locks** (F1; `src/indexer/index.ts:555-573`).
7. **The NULL FTS block was deliberate and is test-pinned** (`src/graph/db.ts:18-20`,
   `src/graph/__tests__/fts-rowid-block.test.ts:130` and `:161`).
8. **A new table needs no schema-version bump** (`MAST_SPEC.md:642-653`, `src/graph/db.ts:145-147`).

Items 3, 7 and 8 and ADR 007 were reported by a sweep and not all opened by the author; they
are to be re-read before the code that depends on them is written.

## The requirement

For any sequence of edits, the graph after incremental runs — and after query-time re-parses —
equals the graph after a full index of the final tree: same edges by name, same star re-export
rows, same imports, and no checker verdict a full run would not record. A full index gives the
same graph whatever order the files are walked in, and whatever ids the rows happen to have.

## What the spikes found

Full results: `spikes/sN-*/RESULTS.md`.

- **S1.** A full index of n8n misses 3.5% of its edges through walk order, and nothing reports
  it. Writing star rows first recovers 822 of the 1,939; named re-export edges must also be in
  place first, and they chain three deep, so they need a fixed point or dependency order. A
  missing barrel row never produced an edge to the wrong place, only a missing edge.
- **S2.** Incremental use loses 5 to 8% of edges within a hundred or two commits, almost all by
  D081. It also found D085, which makes the full index itself depend on row order.
- **S3.** Files holding an edge into a given file: median 0, p99 7, maximum 1,115 on n8n.
  Files importing a name it declares, directly or through barrels: median 1, p99 37, and five
  files between 1,181 and 5,011. Following barrels by file instead of by name: 1,057 files over
  100 and 334 over 1,000.
- **S4.** 72 to 74% of modifications leave a file's names and re-exports unchanged; about 24%
  change its declared names (15% its exported names); 5% on n8n change its re-exports.
- **S5.** Resolving one file's edges again costs about 3 to 4 ms with a re-parse and 0.3 to
  0.8 ms from records already extracted. The worst n8n file by edges into it (1,115 holders):
  3.3 s by re-parse, 0.36 s from records. The worst by name through barrels (5,011 importers),
  extrapolated: 15 to 19 s by re-parse, 1.6 to 3.8 s from records.

## Design reserve and what the evidence promotes

| | Mechanism | Fixes | Outcome |
|---|---|---|---|
| M1 | Pass 2 in three stages: every file's star rows; then `RE_EXPORTS` edges, repeated until none is added (or in dependency order); then all other edges | D083 | **Promote.** The only ordering that reaches 0 short on n8n (S1). The first form of M1, star rows only, is rejected: 1,117 short. |
| M8 | Resolve structural edges with the file evidence that exists: `PARENT_OF` in the class's own file; `IMPLEMENTS`/`EXTENDS` through the class's imports, then its own file | D085 | **Promote for `PARENT_OF`.** For the other two, one question is open: what to do when neither an import nor the same file names the target (see Decisions). |
| M3a | Before a file X is re-written, note which other files hold an edge or star row into it; after the write, resolve those files' edges again by re-parsing them, without re-writing them | D081 | **Promote.** p99 7 files, worst case 3.3 s (S3, S5). No new table, no kept ids. |
| M3b | When X's declared names or re-exports changed, or X was added or deleted, also resolve again the files that import one of the affected names from X or from a barrel that re-exports X | D084 | **Promote, with a bound to settle.** Fires on about 37% of file changes; p99 37 files; five n8n files reach thousands (S3, S4). |
| M4 | Store each file's unresolved edge records in a table and resolve from it instead of re-parsing | D081, D084, cheaper | **Hold.** Five to ten times cheaper per file (S5), but it adds a table, a write on every file write, and a second copy to keep in step. Promote only if M3b's worst case is not acceptable. |
| M2 | Keep file and symbol ids across a re-write | D081 for body edits | **Reject.** Not needed once M3a exists, covers only the 72 to 74% of modifications that keep their names, and reverses prior decision 1. |
| M5 | The query-time path uses the same routine as an incremental run for edges and star rows, including M3a | D080 | **Promote.** Otherwise M3a fixes the CLI and leaves the server path broken. |
| M6 | Record "no rows" as an empty FTS block, distinct from NULL | D082 | Not yet promoted. A reviewer's hand simulation cut 20 markdown files from a median of 741 ms to 5 to 8 ms; not re-run by the author. |

## Decisions that are the user's

1. **D085 fallback. Decided by the user 2026-10-06: record no edge (option B), and the D086
   fix joins this work.** D087 and recording aliased imports under their local name are
   deferred until this round is committed. On n8n, 152 of
   3,424 `implements` / `extends` records have no file evidence. Today's whole-graph guess
   links 27 of them and all 27 are wrong; guessing only unique names links 21, all wrong. The
   three options differ by one `mast_implementors` answer, a wrong one. What B appears to
   lose is lost to two resolver gaps S6 found, not to the fallback: D086 (37 right answers)
   and D087 (24). So M8 for `IMPLEMENTS` / `EXTENDS` lands together with the D086 fix.
   Open, and the user's: whether D087 and recording aliased imports under their local name
   (29 records, 20 wrong edges made right) join this work or get their own.
2. **The bound for M3b. Decided 2026-10-06: cap and report (option B). The cap's size is
   open.** S7 estimates, per replayed n8n commit, p90 103 files to resolve again, 9 of 143
   runs over 500 and 2 over 5,000; mast's largest is 56. Proposed: count the cap in elapsed
   time, not files, so one setting means the same wait on any machine; about 2 s for an
   incremental run and the watcher, about 250 ms on the query-time path; files left over are
   recorded as pending, `mast status` reports them, and the next run continues. At 3.3 to
   3.8 ms per file (S5, this machine) 2 s is 520 to 600 files, which 9 of 143 n8n runs would
   exceed. Both figures are proposals to be set by T2 and T12, not measurements.
   Decided by the user 2026-10-06: start at 2 s and 250 ms and let the tests tune them; no
   further spike first. Also asked for: a signal to the caller when work is left pending.
   Proposed shape, to be pinned by a test (T13): the count of pending files is stored with
   the index; `mast status` and `mast_status` report it, with `index_fresh: false` and a
   `freshness_cause` that names it; `mast_callers`, `mast_implementors` and
   `mast_rename_impact` carry the count and a "run `mast_reindex`" hint on any response given
   while it is above zero; `mast_reindex`, the next incremental run and the watcher drain it.
3. **Published numbers.** M1 changes n8n's edge count by 1,939, and M3 adds work to an
   incremental run. Any `FINDINGS.md` figure that depends on either (edge counts, the
   "O(changed file)" claim, the 379 ms comparison) needs an ADR 010 registration before it is
   re-measured. Which figures are affected has not been enumerated yet.
4. **Severity.** D081, D083, D084 and D085 are filed S1. By the ledger's own definition (a
   confident answer that is silently incomplete, which the caller cannot tell) they read as S0.

## Test work list

Written before any fix, each seen failing against current code. This is the list to work
through; items are ticked here as they land.

- [x] **T1. Equivalence helper.** `expectGraphEqualsFullIndex(projectDir)`: dumps edges, star
      rows and imports by name, builds a fresh full index of the same tree in a second state
      directory, and compares. One helper, used by every test below.
- [x] **T2. Equivalence table, incremental run.** One row per scenario: build, index, edit,
      incremental run, T1. First rows are every scenario in `spikes/s0-reproductions`: body edit
      of a called file; new name already imported elsewhere; file created after its caller;
      rename; barrel re-pointed; re-export replaced by a declaration; `type` to `interface`;
      body edit of a star-re-exported file; file deleted and recreated; function moved behind a
      barrel. Each later edge defect adds a row.
- [x] **T3. The same table through the query-time path.** The edit is followed by a read-tool
      refresh of the edited file, then T1; then an incremental run, then T1 again.
- [x] **T4. Order independence.** The same project under file names that sort the caller before
      and after the barrel; named re-exports chained three deep in the adverse order; a star and
      a named re-export mixed. Edges equal in every ordering.
- [x] **T5. Same name in two files (D085).** Two classes with one name each keep their own
      members; `implements` follows the import; the answer is the same after either file is
      re-written.
- [x] **T6. Checker verdicts.** A verdict about a re-written file's symbols does not survive
      the re-write, including when other files' edges into it are resolved again.
- [x] **T7. Tool answers.** `mast_callers`, `mast_implementors` and `mast_rename_impact` give
      the same answer before and after a body edit of the target file. One test per tool: this
      is the layer a user sees.
- [x] **T8. Watcher path.** With the server's watcher running, an edit to a called file leaves
      its callers in place. The one-session finding in S2 came through this path and no test
      covers it.
- [ ] **T9. Existing incremental tests call T1.** `stability`, `chunks-removed`,
      `failed-file-retry`, `chunk-store-growth` and the staleness tests each end with the
      helper where they have a multi-file project, so future incremental work is checked
      against a full index without anyone remembering to.
- [ ] **T10. Generated edit sequences.** A seeded generator builds a small project with
      imports, barrels and classes, applies a random sequence of edits (body, rename, add,
      delete, move, re-point), and runs T1 after each. Fixed seeds in the suite; the seed is
      printed on failure.
- [ ] **T11. D082.** A row planted outside a file's FTS block survives a re-write of that file
      (fails while the code scans); an empty, non-empty, empty sequence.
- [ ] **T12. Replay as a standing check.** The S2 replay, moved to `eval/` with a results
      writer entry, run against this repository's own history with the pass condition "nothing
      missing against a full index". Not part of `pnpm gate`; run before a release.

Added 2026-10-06 after S6, at the user's request. T1 to T12 compare against a full index, so
they cannot see an edge the full index itself gets wrong or never creates. D083, D085 and D086
are all of that kind. These tests compare a full index against edges written out by hand.

- [x] **T13. Pending signal.** A run that stops at the cap leaves a pending count; `mast
      status` and `mast_status` report it and say the index is not fresh; `mast_callers`,
      `mast_implementors` and `mast_rename_impact` carry it on the response; the next run
      drains it and the signal clears. A run under the cap leaves none.
- [x] **T14. Expected-edge helper.** `expectEdges(projectDir, expected)`: the full index's
      edges by name must equal a hand-written list, both ways, so a missing edge and an extra
      one both fail. Used by T15 to T17.
- [x] **T15. Re-export shapes, full index.** One row per shape, each with a call, an
      `extends` and an `implements` through it: direct import; named re-export; `export *`;
      a named re-export behind a star (D086); a star behind a named re-export; three deep in
      each mix; `export type { X } from`; a package entry point laid out as n8n's
      (`index.ts` stars `errors/index.ts`, which names `base/user.error.ts`).
- [x] **T16. Structural edges without evidence, full index (D085, decision 1).** Each row
      expects no edge: `interface X extends Record<string, unknown>` beside a local
      `class Record`; `extends Error` beside a local `class Error`; a base class imported from
      a package beside a local class of that name; `import { A as B }` then `extends B` beside
      an unrelated `B`. And rows that expect the right edge: a class implementing an interface
      whose name a `type` elsewhere also has, listed by `mast_implementors`; two same-named
      classes each keeping their own members.
- [x] **T17. A fixture monorepo with a written edge list.** One small committed fixture in
      the shape that hid these defects: two packages, entry-point barrels, an error hierarchy,
      one interface with several implementors, same names in both packages. Its full expected
      edge list is committed beside it and checked by T14 after a full index, after an
      incremental run over an edit (with T1), and for `mast_callers` and `mast_implementors`.
      A later resolver defect adds its shape here.
- [ ] **T12, second condition.** The replay also reports, for the final tree, import call
      records and structural records whose imported name is not found, so a resolver gap
      shows as a number that moves instead of as silence.

Landed 2026-10-06 (step 2 of the order of work), each seen failing first:
`src/indexer/__tests__/graph-fixture.ts` (T1, T14), `walk-order.test.ts` (T4),
`structural-evidence.test.ts` (T5, T16), `reexport-shapes.test.ts` (T15),
`fixture-monorepo.test.ts` and `fixtures/edge-monorepo/` (T17; its incremental half landed
with M3a in step 3). Red counts
before the fixes: T4 5 of 8, T15 15 of 22, T5 and T16 10 of 13, T17 2 of 4. Writing T16 found
D088 (`mast_implementors` gave two same-named classes the first one's methods), fixed with it.

Step 3, first half, landed 2026-10-07: M3a (`findFilesWithEdgesInto`, `clearOutgoingEdges`,
and the holder step in `runIndex`), with T2 (`incremental-equivalence.test.ts`, 10 of 11 rows
red before, 5 after), T6 (`incremental-checker-rows.test.ts`) and T7
(`mcp/tools/__tests__/answers-after-edit.test.ts`, 3 of 3 red before). T2 is not ticked: its
five remaining rows are the D084 cases and run under `it.fails` until M3b lands. T13 is not
started.

Step 3, second half, landed 2026-10-07: M3b (`src/graph/importer-repair.ts` and the
re-resolve step in `runIndex`), the budget and the pending signal. T2 now has 18 rows, all
green without markers; 9 of them fail with the importer lookup switched off. T13 is
`indexer/__tests__/edge-repair-pending.test.ts` (both barrel kinds) and
`mcp/tools/__tests__/pending-signal.test.ts`. Adding a T2 row found D089 (a re-pointed named
re-export passed the stability skip), fixed with it. S8 checked the result on n8n.

What was built differs from the proposal in three places:

- **Who is capped.** `runIndex` has no budget unless given one. The watcher and the startup
  run pass 2,000 ms; `mast index`, `mast index --incremental` and `mast_reindex` pass none.
  The hint on a tool response says to run `mast_reindex`, so that run has to finish the
  work. The proposal had every incremental run capped.
- **What the budget covers.** Files that re-export are always resolved, outside the budget.
  An importer resolved against a barrel that is itself waiting would get a wrong edge and
  nothing would bring it back. The clock starts when the importing files start.
- **The waiting list is written before the work, not after.** Holders and importers are
  recorded as waiting as soon as they are known and removed as each batch finishes, so a run
  that dies part-way leaves the list. A run that dies between pass 1 and pass 2 still loses
  the holders' edges unrecorded; that window is older than this work.

Step 4 landed 2026-10-07: M5. The re-resolve step moved out of `runIndex` into
`src/indexer/edge-repair.ts`, and the query-time refresh (`checkAndRefreshIfStale`) calls it
with a 250 ms budget. T3 is `mcp/__tests__/query-time-equivalence.test.ts`: the T2 scenarios,
now in `indexer/__tests__/equivalence-scenarios.ts`, 13 of 18 red before. T8 is
`mcp/__tests__/watch-batch-edges.test.ts`, a real watcher with the server's batch handler; it
was green when written, because M3a had already fixed that path, and fails with the holder
step removed. Two things the proposal did not have:

- **The waiting list commits with the file's write on this path.** The query-time refresh
  takes no structure lock, so another process can hold the database between the write and
  the repair. The file and its holders are recorded inside `populateFile`'s transaction.
- **The repair's writes wait 200 ms for another writer, not 5 s.** SQLite's wait blocks the
  server process. A repair that loses the wait stops, and the files stay recorded.

Cost on n8n: 7 ms for a file nothing depends on, 376 to 712 ms for three hub files
(`spikes/s8-importer-repair-validation/RESULTS.md`, added section).

`mast index --incremental` stays without a budget (user, 2026-10-07).

Not covered by M3b as it landed, each because the index stored nothing to find the importer
by: an `export *` of a file that did not exist when the barrel was indexed; a call resolved
with no file evidence (`legacyGlobalFirstMatch`); a new file that takes over a specifier
another file already answered; `import { a as b }` and `export { a as b } from`.

2026-10-07, at the user's direction, the first three were written as scenario rows instead of
being left for T10, and each failed: D090, D092 and D091 in that order. D090 and D091 are
fixed (a `star_reexport_unresolved` table; `findFilesShadowedBy`). D092 was left open until the name match was measured.

2026-10-07, S9 (`spikes/s9-call-fallback/RESULTS.md`): the name match ran for 3,312 call
records on n8n and stored an edge for 7 of them, out of 30,740 stored call edges; 0 of 616 on
mast. All 7 were right, each a class destructured from `await import('<workspace package>')`,
which the extractor does not record as an import. The user chose to drop the match for calls
(2026-10-07), the rule already in force for `implements` / `extends`: no edge without file
evidence. `legacyGlobalFirstMatch` is deleted, D092 is fixed by that, and its scenario row
runs as an ordinary row. Not done, and the way to get the 7 edges back with evidence: record a
destructured dynamic import as an import. Aliases stay deferred with D087.

Not in this round: the D087 case (a path alias in a package's own `tsconfig.json`) and
aliased imports resolving to the right target. Their tests are written with their fixes.

T10 was held in reserve in the first draft. S2 promotes it: the 63 lost edges the cause rule
could not explain, and D085 itself, came from combinations no hand-written scenario had.

## Order of work

1. Agree the decisions above.
2. T1 and T14, then T4, T5, T15, T16 and T17 red; M1, M8 and the D086 fix green. After this
   a full index is a fixed and correct reference.
3. T2, T6, T7 and T13 red; M3a green; then M3b with its bound and the pending signal.
4. T3 and T8 red; M5 green.
5. T9, T10. Whatever they find gets a ledger row and a row in T2.
6. T11 red; M6 green.
7. T12, and the ADR 010 registrations for any published number that moves.

Each step ends with `pnpm gate`.

## Promotion log

| Date | Mechanism | Outcome | Evidence |
|---|---|---|---|
| 2026-10-06 | M6 | Not yet promoted | reviewer's simulation, not re-run; `spikes/s0-timings/RESULTS.md` |
| 2026-10-06 | M1, star rows first only | Rejected: 1,117 of 1,939 edges still missing on n8n | `spikes/s1-walk-order/RESULTS.md` |
| 2026-10-06 | M1, three stages with a fixed point | Promoted: 0 missing | same |
| 2026-10-06 | M2, keep ids | Rejected: not needed, partial, reverses a prior decision | S3 `edge` distribution, S4, S5 |
| 2026-10-06 | M3a, re-resolve holders by re-parse | Promoted: p99 7 files, worst 3.3 s | `spikes/s3-importers`, `spikes/s5-reresolve-cost` |
| 2026-10-06 | M3b, re-resolve importers by name | Promoted with an open bound: p99 37 files, worst 5,011 | same, and `spikes/s2-commit-replay` for how often |
| 2026-10-06 | Following barrels by file | Rejected: 334 files over 1,000 | `spikes/s3-importers/RESULTS.md` |
| 2026-10-06 | M4, stored records | Held: 5 to 10 times cheaper per file, extra table and write | `spikes/s5-reresolve-cost/RESULTS.md` |
| 2026-10-06 | M8 for `PARENT_OF` | Promoted | D085; `spikes/s2-commit-replay/RESULTS.md` |
| 2026-10-06 | M8 for `IMPLEMENTS` / `EXTENDS`, no edge without evidence | Promoted, with the D086 fix (user, 2026-10-06): guess wrong 27 of 27 on n8n | `spikes/s6-structural-fallback/RESULTS.md` |
| 2026-10-06 | Guess when the name is unique in the graph | Rejected: wrong 21 of 21 on n8n | same |
| 2026-10-07 | M8 for calls (`field_type`, `parameter_type`, `new_expression`), no edge without evidence | Promoted (user, 2026-10-07): the guess gave 7 of 30,740 call edges on n8n, 0 of 616 on mast; fixes D092 | `spikes/s9-call-fallback/RESULTS.md` |
| 2026-10-07 | Keeping the call guess and repairing it (M4 records or a new lookup) | Rejected: a table and a write path to protect 7 edges | same |
| 2026-10-07 | Recording `const { X } = await import('m')` as an import | Held: it would give the 7 edges back with evidence; an extractor change | same |
| 2026-10-06 | M3b bound: cap and report, counted in time | Promoted; size open | `spikes/s7-cap-sizing/RESULTS.md` |
| 2026-10-07 | M3b as built: importers by changed name, reached through star rows and same-named markers | Landed: 0 of 108,288 rows differ from a full index after six incremental runs on n8n | `spikes/s8-importer-repair-validation/RESULTS.md` |
| 2026-10-07 | Budget of 2,000 ms on background runs only | Landed as a starting value: about 310 to 530 files on n8n | same |
| 2026-10-07 | Narrowing named re-exports to the ones that changed | Not built: the marker row does not record its source, so a comment added to n8n's package barrel resolves 565 files again | same |

## Not known

- Whether M3a plus M3b reach zero difference on the replays. S8 reached zero on one
  hand-made sequence of six edits; T10 and T12 are still the proof.
- How narrow M3b can be made. Counting only importers of the names that actually changed,
  rather than of any name the file declares, was not measured.
- Whether S6's result holds on a second corpus. mast has 13 such records and does not
  separate the options.
- The size of the cap. S7 is an estimate from summed per-file sets, not a run.
- 344 of n8n's 428 unfound import call records are unexplained.
- Per-save behaviour. A commit is coarser than a save.
- Lock behaviour of M3a on the query-time path, where there is no run-wide ordering.
- A third corpus. mast has two star rows and hid D083 completely; n8n is the only corpus with
  barrels.
- Three reviewer findings were not re-run: the checker's three-line tolerance
  (`checker-resolver.ts:299`), and two scenarios now listed as rows of T2.
