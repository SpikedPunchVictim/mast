# graph-reference — eval manifest

**Decision:** none yet; the record is [`PROPOSAL.md`](PROPOSAL.md). **Spike numbers:**
[`spikes/RESULTS.md`](spikes/RESULTS.md).

Experiment scripts stay in `eval/` (ADR 001). Checks meant to be run again and again live in
`eval-suite/`. Spike scripts are throwaway and stay under `spikes/`.

## Scripts (1)

- `eval-suite/graph-scorecard.mjs` — the standing form of spike S1
  (`spikes/s1-call-edges/reference.mjs`, which judged call edges only and joined
  declarations by line). Scores an index mast has written against the TypeScript compiler,
  one line item per symbol kind, edge type and import record, and compares two scorecards
  key by key. `compare` exits 1 when a key that agreed no longer does or a key is newly
  wrong. Not part of `pnpm gate`; run after each change to the graph. The line items, the
  rules and the limits are in `eval-suite/GRAPH-SCORECARD.md`. Pure logic is in
  `eval-suite/scorecard-lib.mjs`, pinned by `eval-suite/__tests__/scorecard-lib.test.mjs`.

## Artifacts

- `eval-suite/baselines/mast.json.gz`, `n8n-core.json.gz`, `n8n-cli.json.gz` — first
  written 2026-10-07 for the build of `4ca9a71`. Each is replaced, in the same commit, by
  the scorecard of a change that is accepted; `label` in the file says which build. Not under `eval/results/`: these
  are a moving baseline, not a published result.

## Defects found by the first runs

D107 (an optional method of a class has no symbol) and D108 (a name imported and then
exported with no `from` breaks the chain). Both fixed the same day, each measured by a
`compare` against the baseline, which its scorecard then replaced.
