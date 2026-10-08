# Reproductions for D121 to D133

`repro.sh <empty work dir>` builds each small project, runs the built CLI of this checkout
(`pnpm build` first) and prints what it stored and answered. `serve-wipe.mjs` is the part
that needs a running `mast serve`. `OUTPUT.txt` is one run, on the commit named in its first
line; `duration` values differ from run to run and nothing else did between two runs.

| Case | Rows |
|---|---|
| A | D121, D122, D123 (on `eval-suite/fixtures/resolver-shapes/`) |
| B2, B3 | D129 |
| B4 | D127 |
| B5 | D128 |
| B6 | D125, D126 |
| C | D130, D131 |
| D1 | D132 |
| D2 | D133 |

D115 to D120 and D124 are stored edges, and are in `eval-suite/baselines/shapes.json`.
