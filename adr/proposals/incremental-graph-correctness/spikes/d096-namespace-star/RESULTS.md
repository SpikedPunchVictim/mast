# D096: `export * as ns from` stored as a plain star — measurements of the fix (2026-10-08)

Build: `c5807d7` plus the extractor change. n8n copy at `9d9e9bf9`, whole monorepo indexed.

| Measured | Before (D112 build) | After |
|---|---|---|
| `ns-star-repro.sh`, the caller's edge | `src/zc.ts:use -> src/a.ts:fn` | `src/zc.ts:use -> src/b.ts:fn` |
| `ns-star-repro.sh`, star rows | `barrel -> a`, `barrel -> b` | `barrel -> b` |
| n8n, rows in `re_export_files` | 1,063 | 926 |
| n8n, distinct edges of every type | 71,091 | 71,091 (0 gone, 0 new) |

The 137 rows that went are the 137 `export * as` lines spike S12 counted by text search.

- `scorecard-d096-{mast,n8n-core,n8n-cli}.compare.txt`: all PASS, no key changed bucket.
  `packages/core` and `packages/cli` hold no namespace star, so the scorecard did not see
  this defect and does not show the fix.
- `replay-check-{mast,n8n}.json`: the incremental path against a full index on the fixed build.

Not followed: a call written `ns.fn()` after `import { ns } from './barrel'`. It gets no edge,
before and after (three-file project, 0 edges). A namespace is not a symbol in mast.
