# S3 — how many files depend on one file (2026-10-06, exploratory)

**Question.** If file X changes, how many other files would need their edges resolved again?

**Script.** `s3-importers.mjs <dist> <project> <out.json>`, read-only. Raw output: `n8n.json`,
`mast.json` (one row per file); `*.summary.json` holds the distributions and the top rows.
Same indexes as S1. Markdown files are left out: n8n 13,460 code files, mast 83.

Four counts per file X, each a number of *other files*:

| Count | Meaning |
|---|---|
| `direct` | files that import X by path |
| `via_file` | `direct`, plus every barrel that re-exports from X (transitively), plus every file that imports one of those barrels. An upper bound: it counts an importer of the barrel even if it takes nothing X declares. |
| `via_name` | as `via_file`, but an importer of a barrel counts only if its import names something X declares |
| `edge` | files that hold a stored edge into a symbol of X. This is what a re-write of X deletes today (D081). Low by the edges S1 found missing. |

## n8n

| | files at 0 | median | p90 | p99 | p99.9 | max | mean | files > 100 | files > 1,000 |
|---|---|---|---|---|---|---|---|---|---|
| `direct` | 5,305 | 1 | 3 | 20 | 272 | 4,994 | 2.58 | 26 | 2 |
| `via_file` | 3,881 | 1 | 67 | 1,881 | 5,552 | 5,591 | 104.64 | 1,057 | 334 |
| `via_name` | 3,881 | 1 | 6 | 37 | 434 | 5,011 | 4.64 | 51 | 5 |
| `edge` | 10,214 | 0 | 1 | 7 | 53 | 1,115 | 0.69 | 5 | 1 |

2,597 files are re-exported by at least one barrel. The five files over 1,000 by `via_name`:
`packages/workflow/src/index.ts` (5,011), `packages/workflow/src/interfaces.ts` (4,555),
`packages/@n8n/typeorm/src/index.ts` (1,305), `.../decorator/entity/Entity.ts` (1,217),
`.../decorator/columns/Column.ts` (1,181). The one file over 1,000 by `edge` is
`packages/workflow/src/interfaces.ts` (1,115 files, 1,127 edges); next is
`packages/@n8n/db/src/migrations/migration-types.ts` (308).

`packages/workflow/src/execution-context.ts` shows the gap between the two barrel counts: 3
direct importers, 5,591 by `via_file`, 65 by `via_name`.

Not matched to an indexed file: 408 import rows and 111 re-export targets (excluded test
files, non-indexed extensions).

## mast

| | files at 0 | median | p90 | max | mean |
|---|---|---|---|---|---|
| `direct` | 7 | 1 | 8 | 28 | 3.22 |
| `via_name` | 7 | 2 | 8 | 29 | 3.33 |
| `edge` | 15 | 1 | 4 | 11 | 1.94 |

The largest is `src/ast/types.ts`: 28 direct importers, 2 files holding an edge into it. This
matches the reviewer's S0 figures (28 by import, 11 the most by edge).

## What this shows

- Restoring the edges a re-write deletes (D081) touches few files: on n8n, 99% of files have at
  most 7 other files holding an edge into them, and one file has more than 308.
- Following barrels by file, without looking at names, is the GitNexus failure again: 1,057
  n8n files would each pull in more than 100 others, and 334 more than 1,000.
- Following barrels by name keeps it small for almost every file (p99 37) but not for the
  package entry points and the main types file: five files reach 1,180 to 5,011 others, up to
  37% of the repository. Any design that re-resolves importers needs an answer for those five.
- `direct` alone would miss most of the reach: `interfaces.ts` has 55 direct importers and
  4,555 by name through the package barrel.

## Limits

- `via_name` uses the names an importer lists and the names X declares. It does not see
  `import * as ns` use, and a name declared in two re-exported files counts for both.
- Counts are files, not edges or time. S5 puts a cost on one file.
- Two corpora; mast has almost no barrels.
