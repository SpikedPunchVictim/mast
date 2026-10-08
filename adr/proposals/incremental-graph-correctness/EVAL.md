# incremental-graph-correctness — eval manifest

**Decision:** none yet; the record is [`PROPOSAL.md`](PROPOSAL.md). **Spike numbers:**
[`spikes/RESULTS.md`](spikes/RESULTS.md).

Experiment scripts stay in `eval/` (ADR 001). Checks meant to be run again and again live in
`eval-suite/`. Spike scripts are throwaway and stay under `spikes/`.

## Scripts (1)

- `eval-suite/replay-check.mjs` — T12. (In `eval/` until 2026-10-07, when the T12 runs were made.) Replays the last N first-parent commits of a repository
  through `mast index --incremental`, one at a time, in a temporary clone, and compares every
  edge, star row and import row with a full index of the final tree. Passes when no line
  differs either way, nothing is stale and no repair is pending. Also counts, for the final
  tree, the imported names the resolver did not find. Not part of `pnpm gate`; run before a
  release. Pure logic pinned by `eval-suite/__tests__/replay-check.test.mjs`.

  ```
  node eval-suite/replay-check.mjs                     # this repository, 100 commits
  node eval-suite/replay-check.mjs --repo <checkout> --name n8n --commits 200
  node eval-suite/replay-check.mjs --out <path>.json   # result file, see below
  ```

## Artifacts

- `eval/results/replay-check-mast.json`, `eval/results/replay-check-n8n.json` — the T12 runs
  of 2026-10-07, one per corpus. Their `instrument` field names the script's path at the
  time, `eval/replay-check.mjs`. **A run no longer replaces them**: the script now writes to
  `--out`, or to `eval-suite/out/replay-check-<name>.json` (ignored by git), and refuses a
  path inside `eval/results/`. To publish a new run, copy its file there by hand.
- `spikes/d112-reexport-alias/replay-check-{mast,n8n}.json`, `scorecard-d112-mast.compare.txt` —
  the replays and this repository's scorecard comparison on the build that fixed D112
  (2026-10-08).
- `spikes/d096-namespace-star/` — the same for the D096 fix, with `RESULTS.md` giving the star
  rows and edges of the whole n8n index before and after (2026-10-08).

## What a pass does not show

The two graphs being equal says the incremental path and the full path agree. A resolver gap
both share (D087, D096) leaves them equal. The `imported_names_on_the_final_tree` block is
the instrument for that: a gap shows as a `not_found` count that moves.
