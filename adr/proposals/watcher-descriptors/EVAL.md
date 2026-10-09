# watcher-descriptors — eval manifest

**Record:** [`PROPOSAL.md`](PROPOSAL.md). Ledger row D158.

Nothing here writes into `eval/results/` or into the project it watches.

## s1 — open files (`spikes/s1-open-files/`)

| File | What it is |
|---|---|
| `count.mjs` | Starts the watch `mast serve` starts on a project root and counts the open files it holds, by `lsof` type |
| `mast-before.json`, `nest-before.json` | This repository and nest `c3bc75c97`, by the build before the change |
| `mast-after.json`, `nest-after.json` | The same, by the build with the change |
| `drive-watch.mjs`, `drive-watch.out.txt` | The built watcher driven through changes, creates and a rename in a temporary project |
