# S5 — cost of resolving one file's edges again (2026-10-06, exploratory)

**Question.** What does it cost to resolve one file's edges again, by re-parsing the file (M3)
and from edge records already extracted (M4)?

**Script.** `s5-cost.mjs <dist> <project> <target-file> <sample-size> <out.json>`, in a
transaction that is rolled back. Raw output: `n8n.json`, `n8n-run2.json`, `mast.json` (one row
per file) and their `*.summary.json`.

Per file, timed separately: `parse` (mast's `extractFile`: read, tree-sitter, chunking, edge
extraction); `delete` (the file's outgoing non-checker edges); `resolve` (`insertEdges` with the
file's records); `decode` (`JSON.parse` of the records' JSON, standing in for a table read).

Two samples: every file holding a stored edge into a named target file, and every k-th file
that has at least one outgoing edge.

## n8n, two runs (load average 4 to 6)

Files holding an edge into `packages/workflow/src/interfaces.ts`: 1,115.

| | run 1 | run 2 |
|---|---|---|
| Re-parse, delete, resolve — total | 3,332 ms | 3,383 ms |
| Decode, delete, resolve — total | 359 ms | 364 ms |
| `parse` per file: median / p99 | 1.27 / 18.5 ms | 1.28 / 19.0 ms |
| `resolve` per file: median / p99 | 0.15 / 1.62 ms | 0.16 / 1.54 ms |

Every 6th file with an outgoing edge (6,217 such files), first 1,000 by path.

| | run 1 | run 2 |
|---|---|---|
| Re-parse, delete, resolve — total | 3,835 ms | 3,802 ms |
| Decode, delete, resolve — total | 754 ms | 671 ms |
| `parse` per file: median / p99 | 1.74 / 21.2 ms | 1.76 / 20.6 ms |
| `resolve` per file: median / p99 / max | 0.38 / 4.08 / 47.9 ms | 0.37 / 4.18 ms / — |

Run 1 detail: records per file median 4 to 6, p99 121 to 154, max 405; records as JSON median
0.5 to 1.0 KB per file, 2.8 to 2.9 MB for each 1,000-file sample; `decode` 7 to 9 ms in total;
`delete` 60 to 107 ms in total.

Re-resolving both samples added 370 edges to the 53,681 a full index had left (S1's walk-order
edges, repaired as a side effect).

## mast

67 files with an outgoing edge: re-parse path 260 ms in total, records path 37 ms. `parse`
median 2.4 ms, `resolve` median 0.34 ms. Two files hold an edge into `src/ast/types.ts`.

## What this shows

- Resolving from records is about a tenth of the cost of re-parsing for the type-heavy sample
  (359 against 3,332 ms) and about a fifth for the general one (754 against 3,835 ms).
- Re-parsing is itself cheap: about 3 to 4 ms per file on average. The "20 to 47 ms per file"
  in S0-T was parse plus the full write of chunks, symbols and FTS rows.
- The worst file in S3 by stored edges (1,115 holders) costs about 3.3 s to repair by
  re-parsing and 0.36 s from records.
- Extrapolated, not measured: the worst file by name through barrels (5,011 importers, S3) at
  these per-file averages is 15 to 19 s by re-parsing and 1.6 to 3.8 s from records.

## Limits

- `decode` is not a table read. A stored-records design also pays to write the records on
  every file write and to keep them in step; neither was measured.
- One process, one transaction, warm cache; no lock acquisition, no second writer.
- The stride sample is by path order, not random.
- Two corpora; mast's sample is 67 files.
