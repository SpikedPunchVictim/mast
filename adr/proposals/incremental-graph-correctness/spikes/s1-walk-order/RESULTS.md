# S1 — edges a full index misses because of walk order (2026-10-06, exploratory)

**Question.** How many edges does a full index of n8n, and of mast itself, miss because pass 2
resolves each file's edges in walk order (D083)?

**Script.** `s1-order.mjs <dist> <project> <out.json>`. Raw output: `n8n.json`, `mast.json`
(with 40 sample rows per class); `*.summary.json` is the same without the samples.

**Method.** On a fresh full index, inside one transaction that is rolled back: delete every
non-checker edge and every star re-export row; re-insert star rows for all files; insert
`RE_EXPORTS` edges for all files, repeating until the count stops growing; insert every other
edge. This "ordered" graph is compared with the edges the full index left, by name
(`type | resolution | caller file | caller symbol@line | callee name | target file@line`).
The script calls mast's own `extractFile`, `insertReExportFiles` and `insertEdges` from `dist/`.

## Corpora

| | n8n | mast |
|---|---|---|
| Source | clone of the user's n8n checkout at `9d9e9bf97e`, default config (test and spec files excluded) | this repository's working tree, index built into a scratch state directory |
| Files | 13,985 | 166 |
| Star re-export rows | 1,062 | 2 |

## Result

| | n8n | mast |
|---|---|---|
| Edges after a full index | 53,681 | 669 |
| Edges in the ordered graph | 55,620 | 669 |
| Missing from the full index | **1,939** (3.5% of the ordered graph) | **0** |
| Same call, different target | 0 | 0 |
| In the full index, not in the ordered graph | 0 | 0 |

n8n, missing edges by kind (full index -> ordered graph):

| Kind | Full index | Ordered | Missing |
|---|---|---|---|
| `POTENTIAL_CALL` / `import` | 7,581 | 8,844 | 1,263 (14.3% of the ordered count) |
| `RE_EXPORTS` | 3,704 | 4,168 | 464 |
| `POTENTIAL_CALL` / `parameter_type` | 343 | 438 | 95 |
| `POTENTIAL_CALL` / `field_type` | 2,766 | 2,844 | 78 |
| `POTENTIAL_CALL` / `new_expression` | 232 | 270 | 38 |
| `POTENTIAL_CALL` / `super_method` | 23 | 24 | 1 |
| `same_file`, `this_method`, `PARENT_OF`, `IMPLEMENTS`, `EXTENDS` | — | — | 0 |

The 1,939 missing edges point at 765 distinct declarations and come from 701 caller files.
429 of them point into one file, `packages/workflow/src/utils.ts`.

The full index was built twice (once by `mast init`, once by `mast index` over it) and gave
53,681 edges and the same breakdown both times.

## How much each ordering recovers (n8n)

| Pass 2 ordering | Edges | Short of the ordered graph |
|---|---|---|
| As shipped: each file's star rows and edges together, in walk order | 53,681 | 1,939 |
| Star rows for all files first, then edges in walk order (M1 as first written) | 54,503 | 1,117 (675 calls, 442 `RE_EXPORTS`) |
| Star rows, then `RE_EXPORTS` edges once, then the rest | 55,152 | 468 (26 calls, 442 `RE_EXPORTS`) |
| Star rows, then `RE_EXPORTS` edges to a fixed point, then the rest | 55,620 | 0 |

`RE_EXPORTS` edge count after each repeat: 3,726, 4,135, 4,168, 4,168. Three passes were needed:
n8n has named re-exports chained through barrels at least three deep, in an order the walk does
not follow.

## Checked by hand with the CLI

`jsonParse` in `packages/workflow/src/utils.ts`: a text search finds `jsonParse(` in 94 non-test
`.ts` files under `packages/`. On the fresh full index, `mast query mast_callers` gave
`verified_count: 6` (`potential_count: 50`, `potential_truncated: 378`), and all six call edges
come from inside `packages/workflow/`. `packages/cli/src/eventbus/message-event-bus-writer/message-event-bus-log-writer.ts`
has `import { EventMessageTypeNames, jsonParse } from 'n8n-workflow'` and calls it twice. After
appending a line to that file and `mast index --incremental` (`1 indexed, 13984 skipped`), an
edge from that file to `jsonParse` existed.

## What this shows

- D083 is not a corner case on a monorepo with package barrels: a fresh full index of n8n
  misses one in seven import-resolved call edges, and nothing reports it.
- On these two corpora a missing barrel row only ever cost an edge. It never produced an edge to
  a different declaration.
- **M1 as first written is not enough.** Writing star rows first closes 822 of the 1,939.
  Named re-export edges must also be in place before call edges are resolved, and chained
  named re-exports must be resolved in dependency order or to a fixed point.
- mast's own repository shows nothing: it has two star rows. The home corpus hides this defect
  completely.

## Limits

- The ordered graph is built by a script that calls the shipped resolver. It measures what
  ordering alone changes, not whether the resolver is right.
- The fixed-point loop only adds edges. A `RE_EXPORTS` edge resolved early through a star chain
  instead of a not-yet-present named edge would stay; none was seen (zero "different target"
  rows), but the loop would not remove one.
- Test and spec files are outside both indexes.
- Two corpora, one of them with almost no barrels. No third repository.
- One timing was seen in passing and not repeated: `mast index` over the existing n8n index took
  166 s, against 61 s for `mast init` on the empty one (load average 5 to 6).
