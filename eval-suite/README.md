# eval-suite

Checks meant to be run again and again, to validate a change. The experiments, and the
results they published, are in `eval/`.

Rules:

- Nothing here writes into `eval/results/`. A run writes to `eval-suite/out/` (ignored by
  git) or to a path it is given. `__tests__/suite-rule.test.mjs` pins this, because
  `eval/results-writers.mjs` does not scan this directory.
- Shared helpers are imported from `../eval/`, not copied.
- Pure logic is tested in `__tests__/`, which `pnpm gate` runs. The checks themselves are
  not part of the gate: they index real repositories and take minutes.
- Each check is also listed in the `EVAL.md` of the proposal it came from.

| Check | What it answers | Run |
|---|---|---|
| `replay-check.mjs` | Does a run of real commits, indexed one at a time, leave the graph a full index would build? | `node eval-suite/replay-check.mjs` (needs `dist/`; see the file header) |
| `graph-scorecard.mjs` | For each kind of symbol, edge and import mast stores, how much agrees with the TypeScript compiler, and what a change moved | See [`GRAPH-SCORECARD.md`](GRAPH-SCORECARD.md). Baselines are in `baselines/` |
