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

1. **D085 fallback.** When a class's `implements` or `extends` target is named by no import and
   no declaration in the same file (a global or ambient type), keep today's whole-graph name
   match or record no edge. Call edges already record no edge in that case for `super`, and
   guess for three other kinds. Recording no edge removes results `mast_implementors` gives
   today; how many of n8n's 435 ambiguous edges that is has not been measured.
2. **The bound for M3b.** Changing an export of a package entry point would re-resolve up to
   5,011 files on n8n, 15 to 19 s by re-parse. Options: accept it; cap the work and report the
   index as behind for the rest, so `status` is truthful; or build M4. Recommendation: cap and
   report first, measure, and promote M4 only if the cap is hit in practice.
3. **Published numbers.** M1 changes n8n's edge count by 1,939, and M3 adds work to an
   incremental run. Any `FINDINGS.md` figure that depends on either (edge counts, the
   "O(changed file)" claim, the 379 ms comparison) needs an ADR 010 registration before it is
   re-measured. Which figures are affected has not been enumerated yet.
4. **Severity.** D081, D083, D084 and D085 are filed S1. By the ledger's own definition (a
   confident answer that is silently incomplete, which the caller cannot tell) they read as S0.

## Test work list

Written before any fix, each seen failing against current code. This is the list to work
through; items are ticked here as they land.

- [ ] **T1. Equivalence helper.** `expectGraphEqualsFullIndex(projectDir)`: dumps edges, star
      rows and imports by name, builds a fresh full index of the same tree in a second state
      directory, and compares. One helper, used by every test below.
- [ ] **T2. Equivalence table, incremental run.** One row per scenario: build, index, edit,
      incremental run, T1. First rows are every scenario in `spikes/s0-reproductions`: body edit
      of a called file; new name already imported elsewhere; file created after its caller;
      rename; barrel re-pointed; re-export replaced by a declaration; `type` to `interface`;
      body edit of a star-re-exported file; file deleted and recreated; function moved behind a
      barrel. Each later edge defect adds a row.
- [ ] **T3. The same table through the query-time path.** The edit is followed by a read-tool
      refresh of the edited file, then T1; then an incremental run, then T1 again.
- [ ] **T4. Order independence.** The same project under file names that sort the caller before
      and after the barrel; named re-exports chained three deep in the adverse order; a star and
      a named re-export mixed. Edges equal in every ordering.
- [ ] **T5. Same name in two files (D085).** Two classes with one name each keep their own
      members; `implements` follows the import; the answer is the same after either file is
      re-written.
- [ ] **T6. Checker verdicts.** A verdict about a re-written file's symbols does not survive
      the re-write, including when other files' edges into it are resolved again.
- [ ] **T7. Tool answers.** `mast_callers`, `mast_implementors` and `mast_rename_impact` give
      the same answer before and after a body edit of the target file. One test per tool: this
      is the layer a user sees.
- [ ] **T8. Watcher path.** With the server's watcher running, an edit to a called file leaves
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

T10 was held in reserve in the first draft. S2 promotes it: the 63 lost edges the cause rule
could not explain, and D085 itself, came from combinations no hand-written scenario had.

## Order of work

1. Agree the decisions above.
2. T1, then T4 and T5 red; M1 and M8 green. After this a full index is a fixed reference.
3. T2, T6 and T7 red; M3a green; then M3b with its bound.
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

## Not known

- Whether M3a plus M3b reach zero difference on the replays. Nothing was prototyped; the
  numbers size the work, they do not prove the design. T2, T10 and T12 are the proof.
- How narrow M3b can be made. Counting only importers of the names that actually changed,
  rather than of any name the file declares, was not measured.
- How many of n8n's 435 ambiguous `EXTENDS`/`IMPLEMENTS` edges point at the wrong declaration.
- Per-save behaviour. A commit is coarser than a save.
- Lock behaviour of M3a on the query-time path, where there is no run-wide ordering.
- A third corpus. mast has two star rows and hid D083 completely; n8n is the only corpus with
  barrels.
- Three reviewer findings were not re-run: the checker's three-line tolerance
  (`checker-resolver.ts:299`), and two scenarios now listed as rows of T2.
