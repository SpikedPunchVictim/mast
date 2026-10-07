# S7 — how often a cap on re-resolution would be hit (2026-10-06, exploratory, an estimate)

**Question (decision 2).** With re-resolution capped and the rest reported as pending, where
should the cap sit, given that machines differ?

**Script.** `s7-cap.mjs <S2 steps.json> <S3 json> <out.json>`. It opens no index. For each
replayed commit it sums, over the files the commit changed, the files that would need
resolving again: holders of a stored edge into the file (M3a, S3 `edge`), and for a file whose
names or re-exports changed or that was added or deleted, the importers of its names through
barrels (M3b, S3 `via_name`). Raw output: `n8n.json`, `mast.json` (one row per run).

| Files to resolve again, per run | n8n (143 runs) | mast (40 runs) |
|---|---|---|
| p50 / p75 / p90 / p95 / max | 6 / 43 / 103 / 913 / 10,720 | 8 / 25 / 42 / 46 / 56 |
| Runs over 100 | 15 | 0 |
| Runs over 250 | 10 | 0 |
| Runs over 500 | 9 | 0 |
| Runs over 1,000 | 4 | 0 |
| Runs over 2,500 | 2 | 0 |

The two largest n8n runs both changed the re-exports of `packages/workflow/src/index.ts`
(5,011 importers). So the worst file in S3 was edited twice in about four working days.

At S5's measured 3.3 to 3.8 ms per file on this machine (re-parse path): 100 files is about
0.4 s, 250 about 0.9 s, 500 about 1.8 s, 1,000 about 3.6 s.

## What this shows

- A cap counted in files means different waits on different machines. A cap counted in
  elapsed time does not: the loop resolves files until the budget is spent, and a slower
  machine simply finishes fewer of them.
- With a budget near 2 s, about 9 of 143 n8n runs (6%) would leave work pending, and none of
  mast's 40.

## Limits

- Estimate, not a run. Per-file sets are summed, so a run's figure is an upper bound on the
  union (10,720 exceeds the files that have any outgoing edge).
- S3 was measured at the final commit; a file deleted during the replay counts 0.
- Importers are of any name the file declares. Counting only the names that changed was not
  measured and would lower the large runs.
- A commit is coarser than a save.
