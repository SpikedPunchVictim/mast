# resolver-shapes — eval manifest

**Record:** [`PROPOSAL.md`](PROPOSAL.md). No ADR yet; one is written when the rows are done.

Checks meant to be run again live in `eval-suite/`. Spike scripts and their output stay under
`spikes/`. Nothing here writes into `eval/results/`.

## The instrument for every row

`eval-suite/graph-scorecard.mjs` against the four baselines in `eval-suite/baselines/`, run
as `eval-suite/GRAPH-SCORECARD.md` describes. `shapes.json` holds the wrong edges of these
rows; a fix shows there as `wrong -> agree` or `wrong -> absent`.

## D115 (`spikes/d115/`)

| File | What it is |
|---|---|
| `field-shadows.py <state dir>` | Counts classes with stored fields, the fields, and the fields whose name is a method of a class above along stored `EXTENDS` edges |
| `field-shadows.out.txt` | Its output on this repository, n8n `9d9e9bf9` and the shapes corpus |
| `n8n-edges-vs-0156146.json` | n8n edges of the D115 build against those of `0156146`, by `inherited-call-edges/spikes/s2-found-on-cli/edge-diff.py` |
| `scorecard-*.compare.txt` | `compare` of each baseline with the D115 build |

## D116 (`spikes/d116/`)

| File | What it is |
|---|---|
| `n8n-edges-vs-d115.json` | n8n edges of the D116 build against those of the D115 build, by the same `edge-diff.py` |
| `scorecard-*.compare.txt` | `compare` of each baseline (as of the D115 commit) with the D116 build |
