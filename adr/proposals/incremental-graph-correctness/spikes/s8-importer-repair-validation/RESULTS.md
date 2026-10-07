# S8 — does the importer repair (M3b) hold on n8n, and what does it cost?

2026-10-07. Not a registered experiment. One machine, under other load, one run of each step
unless shown twice. Corpus: the scratch clone of n8n at `9d9e9bf97e` (13,985 indexed files),
its index built by a full run of commit `7f33b96` and then updated only by incremental runs of
the working tree that became the M3b commit.

Scripts: `capped.mjs <dist> <project> <budgetMs|none>` runs one incremental run and prints
what it did; `full.mjs <dist> <project> <state-dir>` builds a full index into a separate state
directory; `dump-edges.sh <graph.db>` prints every edge (type, resolution, both ends by path,
name and line), every star row and every import row, sorted.

## Questions

1. After a sequence of incremental runs over real files, is the graph the one a full index
   of the same tree gives?
2. How many files does a run resolve again for a widely imported file, and how long does it
   take?
3. Does a run stopped at the 2 s budget report what it left, and does the next run finish?

## The sequence

Each line is one edit followed by one incremental run. `reResolved` counts files resolved
again without being re-written; `edges` is the pass-2 phase in ms.

| # | Edit | Budget | indexed | reResolved | pending | edges ms | total ms |
|---|---|---|---|---|---|---|---|
| 1 | comment appended to `packages/workflow/src/interfaces.ts` | none | 1 | not recorded | 0 | not recorded | 11,778 |
| 2 | comment appended to `packages/workflow/src/index.ts` (the package barrel) | none | 1 | not recorded | 0 | not recorded | 8,873 |
| 3 | the same barrel again | 2,000 ms | 1 | 229 | 336 | 2,321 | 2,913 |
| 4 | no edit: drain | none | 0 | 336 | 0 | 2,673 | 2,960 |
| 5 | `export function __mastProbeAdded` appended to `packages/workflow/src/utils.ts` | none | 1 | 333 | 0 | 3,007 | 3,548 |
| 6 | `git mv packages/workflow/src/cron.ts cron-moved.ts` (the barrel has `export * from './cron'`) | none | 1 | 6 | 0 | 283 | 857 |

Runs 1 and 2 used the CLI of an earlier build of the same day, before the counter existed and
before the clear step took its lock once per batch instead of once per file; their times are
not comparable with the rest.

After run 3, `mast status` printed `pending_edge_repairs: 336`, `index_fresh: false`,
`freshness_cause: edge_repair_pending`. After run 4 it printed 0, true, none.

## Answer to 1

After run 6 a full index of the same tree was built into a fresh state directory (13,985
files, 60,327 ms) and both databases dumped:

- 108,288 lines each (edges, star rows and import rows together);
- `diff` of the two dumps: 0 lines.

Before run 3, after runs 1 and 2, the edge counts by type were those of the full index the
sequence started from: 55,610 in total; `POTENTIAL_CALL` 30,740, `PARENT_OF` 17,650,
`RE_EXPORTS` 4,172, `IMPLEMENTS` 1,797, `EXTENDS` 1,251.

This is one sequence of six edits, chosen by hand, in one package. It is not the commit
replay (T12), which is still to be written.

## Answer to 2

Re-timed after the last code change, no budget:

| Edit | reResolved | edges ms | total ms |
|---|---|---|---|
| package barrel `index.ts`, comment appended | 565 | 3,609 | 4,129 |
| the same again | 565 | 3,289 | 3,646 |
| `interfaces.ts`, comment appended | 1,193 | 4,483 | 5,112 |

That is 5.8 to 6.4 ms per file for the barrel's importers and 3.8 ms per file for the holders
of `interfaces.ts`, the pass-2 phase divided by the count. S5 measured 3.3 to 3.8 ms per file.
At these rates the 2,000 ms budget is about 310 to 530 files; run 3 reached 229 before the
budget, on the per-file-lock build.

A comment appended to the barrel resolves 565 files again although nothing it exports
changed. The cause is known: a named re-export's marker row does not record where it points,
so every one in a re-written file is treated as changed.

## Answer to 3

Yes for this case: run 3 and run 4 above.

## Not checked

- Any sequence but this one. No deletion of a widely imported file, no rename of an exported
  name with callers, no change inside a second package.
- A second corpus.
- The watcher. The budget was passed by script; the watcher passing it is covered only by
  `src/mcp/__tests__/serve-freshness-wiring.test.ts`.
- The query-time path, which still does not resolve edges at all (D080).
