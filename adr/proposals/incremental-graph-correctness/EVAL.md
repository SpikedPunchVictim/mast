# incremental-graph-correctness — eval manifest

**Decision:** none yet; the record is [`PROPOSAL.md`](PROPOSAL.md). **Spike numbers:**
[`spikes/RESULTS.md`](spikes/RESULTS.md).

Scripts stay in `eval/` (ADR 001). Spike scripts are throwaway and stay under `spikes/`.

## Scripts (1)

- `eval/replay-check.mjs` — T12. Replays the last N first-parent commits of a repository
  through `mast index --incremental`, one at a time, in a temporary clone, and compares every
  edge, star row and import row with a full index of the final tree. Passes when no line
  differs either way, nothing is stale and no repair is pending. Also counts, for the final
  tree, the imported names the resolver did not find. Not part of `pnpm gate`; run before a
  release. Pure logic pinned by `eval/__tests__/replay-check.test.mjs`.

  ```
  node eval/results-writers.mjs replay-check     # it WRITES; see below
  node eval/replay-check.mjs                     # this repository, 100 commits
  node eval/replay-check.mjs --repo <checkout> --name n8n --commits 200
  ```

## Artifacts

- `eval/results/replay-check-mast.json`, `eval/results/replay-check-n8n.json` — the last run
  per corpus. Each run **replaces** its file; the history of runs is in git.

## What a pass does not show

The two graphs being equal says the incremental path and the full path agree. A resolver gap
both share (D087, D096) leaves them equal. The `imported_names_on_the_final_tree` block is
the instrument for that: a gap shows as a `not_found` count that moves.
