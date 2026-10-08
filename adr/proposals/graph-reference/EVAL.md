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

D110 (a path alias written with a `.js` extension is marked external) was found by the
`compare` of the dynamic-import change, on the 68 import rows it left without a file, and
fixed with it. That run also found an error in the reference: `new` through a variable was
judged by the constructor the class inherits. Both are in
`adr/proposals/inherited-call-edges/spikes/RESULTS.md`.

D109 (a declaration under `declare` has no symbol) was found while writing the D107 test,
not by a scorecard: none of the three corpora has one in a scored file. Its fix was run
through `compare` like the others (PASS on all three; n8n gained 5 symbols and no edge).
What `declare module`, `declare global` and `declare namespace` blocks hold is still given
no symbol, and the scorecard has no line item for it.

The walk up stored `EXTENDS` edges (`adr/proposals/inherited-call-edges`, 2026-10-08) was
run through `compare` on all three: PASS, with 941 calls on `packages/cli` and 9 on
`packages/core` moving from `lacks` to `agree`. Outputs:
`adr/proposals/inherited-call-edges/spikes/s2-found-on-cli/scorecard-walk-*.compare.txt`.
Its incremental side was checked by `eval-suite/replay-check.mjs` on this repository and on
n8n; results in `adr/proposals/inherited-call-edges/spikes/t6-replay/`. D111 (one name
re-exported by name from two files) was found by the generated edit sequences on the way.
