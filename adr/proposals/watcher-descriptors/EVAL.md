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
| `symlink-fixture.sh`, `symlink-links-not-followed.json` | A project with a link to a directory outside it, and the open files a watch of it holds when chokidar is told not to follow links (D160; not the shipped behaviour) |
| `drive-linked-root.mjs`, `drive-linked-root.out.txt` | The built watcher on a root that is a real path and on one that is a link. The output kept is of the attempt with `followSymlinks: false`; the shipped build gives batches for both |
| `drive-links.mjs`, `drive-links.out.txt` | The shipped watcher on the link fixture: which changes start a batch, and the time from start to ready with and without asking the disk about each path |
| `start-and-close.mjs`, `start-and-close.out.txt` | The time from start to ready and the time `close()` takes, repeated, with and without asking the disk about links; and the same for the build before (D161) |
