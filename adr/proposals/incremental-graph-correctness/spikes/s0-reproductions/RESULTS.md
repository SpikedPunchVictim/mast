# S0-R — reproductions (2026-10-06, exploratory)

Each scenario: build a scratch project, `mast init`, one edit, `mast index --incremental`,
then `mast index`. The graph is dumped by name after each step.

## Scenarios with a script: `scenarios.sh`, raw output `scenarios.out.txt`

Written from an adversarial reviewer's descriptions, not from its files. `reviewer-scen.sh` and
`reviewer-dump.sh` are the reviewer's own harness, kept for comparison. Callers are named `zc.ts`
so they sort after the files they import and D083 is not involved.

| id | Edit | After incremental | After full index | Defect |
|---|---|---|---|---|
| n2 | `x.ts` gains `fresh`, which `zc.ts` already imports and calls | no edge | `zc.ts:use -> x.ts:fresh` | D084 |
| n1 | `x.ts` created after `zc.ts`, which imports from it | no edge | `zc.ts:use -> x.ts:fn` | D084 |
| s4b | `fn` renamed in `x.ts` | no edge | no edge | none (agree) |
| s4e | `barrel.ts` `export *` re-pointed from `x` to `y` | `zc.ts:use -> x.ts:fn`, `barrel => y` | `zc.ts:use -> y.ts:fn` | D084 |
| m1 | `x.ts` changes from `export { fn } from './impl.js'` to declaring `fn` | `zc.ts:use -> impl.ts:fn` | `zc.ts:use -> x.ts:fn` | D084 |
| s3k | `type Opts` becomes `interface Opts` in `x.ts` | `IMPLEMENTS` edge gone | `zc.ts:Impl -IMPLEMENTS-> x.ts:Opts` | D081 |
| r1 | body of `fn` edited in `x.ts`, which `barrel.ts` star-re-exports | `barrel => x` row gone | `barrel => x` | D081 |

Every incremental run printed `stale_files: 0`.

## Scenarios run by hand (commands were inline; no script kept)

**D081, two files.** `a.ts` exports `alpha`; `b.ts` imports and calls it. `POTENTIAL_CALL` edges:
`1` after `mast init`; `0` after changing the body of `alpha` and `mast index --incremental`
(`files: 1 indexed, 1 skipped`, `stale_files: 0`); `1` after `mast index`.

**D081, n8n copy.** `packages/frontend/@n8n/rest-api-client/src/utils.ts` had 289 `POTENTIAL_CALL`
edges pointing at it from other files (the most of any file; next `packages/@n8n/utils/src/is-record.ts`
280, `packages/@n8n/utils/src/errors/ensure-error.ts` 154). After appending
`export const zzProbe = 1;` and `mast index --incremental` (`files: 1 indexed, 13984 skipped`,
`duration: 505ms`): 0 edges into it; total `edges` rows 52506 -> 52217; `stale_files: 0`.

**D081 on the query-time path.** Same two-file project. After editing `a.ts`,
`mast query mast_exports '{"file_path":"src/a.ts"}'`: edges `1 -> 0`. Then
`mast index --incremental`: `files: 0 indexed, 2 skipped`, edges `0`, `stale_files: 0`. Full: `1`.

**D080.** Three-file project, counts of `edges | re_export_files | imports` for the edited file:
`1|1|1` after a full index; `0|0|1` after a query-time re-parse; `mast_callers alpha`
`verified_count: 0`; `0|1|1` after `mast index --incremental` (the re-export came back only
because of the D079 fix); `stale_files: 0`.

**D083, walk order.** Copy of the reviewer's project `p3`: `barrel.ts` is
`export { g } from './impl.js'; export * from './star.js';`; `a_first.ts` and `zz_last.ts` each
import `g`, `z` from the barrel and call both. Full index: 6 edges, with
`zz_last.ts:late -> impl.ts:g` and `-> star.ts:z` and nothing from `a_first.ts:early`. After
appending a comment to `a_first.ts` and `mast index --incremental` (`1 indexed, 8 skipped`):
8 edges, both calls from `early` present. Full again: 6.

**Checker verdicts (the cascade that must be kept).** `tsconfig.json` with `strict`, `NodeNext`.
`x.ts`: `export function run()` on line 1 and, ten lines down, `export const api = { run() {...} }`.
`zc.ts`: `return api.run();`. After `mast init` and `mast index --checker`
(`edges_upgraded: 0  non_call_site: 3  different_declaration: 1`): 4 verdict rows, among them
`run@1 / src/zc.ts:2 / resolves_to_different`; `mast_callers run`: `verified_count: 0, potential_count: 0`.
After changing `x.ts` to `export const api = { run };` and `mast index --incremental`
(no `--checker`): 1 verdict row left (`use@2 / src/zc.ts:2 / non_call_site`). After
`mast index --checker`: 4 rows, `run@1 / src/zc.ts:2 / resolves_to_queried`, and an edge
`use -> run@1 POTENTIAL_CALL checker`. So the verdict the edit deleted was one that had become wrong.

## The hand-run scenarios as a script: `hand-scenarios.sh`, raw output `hand-scenarios.out.txt`

Added later the same day so the two-file, query-time and D080 cases can be re-run. Row counts
are `edges | re_export_files | imports` for the whole project.

| Scenario | After init | After the edit and the step named | Next incremental run | Full index |
|---|---|---|---|---|
| D081, incremental run | `1\|0\|1` | `0\|0\|1` (`1 indexed, 1 skipped`) | — | `1\|0\|1` |
| D081, `mast_exports` on the edited file | `1\|0\|1` | `0\|0\|1` | `0\|0\|1` (`0 indexed, 2 skipped`) | `1\|0\|1` |
| D080, edited file has a star re-export | `1\|1\|1` | `0\|0\|1`, `verified_count: 0` | `1\|1\|1` (`1 indexed`) | `1\|1\|1` |
| D080, edited file has no star re-export | `1\|0\|1` | `0\|0\|1`, `verified_count: 0` | `0\|0\|1` (`0 indexed, 2 skipped`) | `1\|0\|1` |

Every `mast status` printed `stale_files: 0`.

New in this run: when the file re-parsed at query time has a star re-export, the next
incremental run repairs it, because the D079 check notices the missing star row and re-writes
the file. Without a star re-export the loss stays until a full index. The earlier hand-run
D080 figure (`0|1|1`) counted rows for the edited file only, in a three-file project laid out
differently, so the two are not the same measurement.

## Reported by the reviewer and not re-run

- `x.ts` deleted, indexed, recreated: incremental 0 edges, full 1.
- A function moved to another file with the barrel re-pointed: incremental 0, full 2.
- `IMPLEMENTS` resolves by bare name across the whole graph: after an unrelated file gains
  `interface Opts`, a full index points the edge at that file although the class imports `Opts`
  from elsewhere.
- The checker accepts any declaration within three lines of the resolved one
  (`checker-resolver.ts:299`): a method call became a `checker` edge to a different function.
- On mast's own index (162 files), the most callers by edge for one file is 11 and by import 28
  (`src/ast/types.ts`).
