# schema-rebuild — eval manifest

**Decision:** accepted 2026-10-08, no ADR yet; the record is [`PROPOSAL.md`](PROPOSAL.md). **Spike numbers:**
[`spikes/RESULTS.md`](spikes/RESULTS.md).

Experiment scripts stay in `eval/` (ADR 001). Checks meant to be run again and again live in
`eval-suite/`. Spike scripts are throwaway and stay under `spikes/`. Nothing here writes into
`eval/results/`.

## Spike scripts (`spikes/s1-inplace/`)

| Script | What it does |
|---|---|
| `clear.mjs` | The prototype: drops every table of `graph.db` but the two metrics tables and creates them again, in one transaction. Not the production code |
| `two-connections.mjs` | A second connection's prepared statements across the clear, across a changed column, during an open read, and against a writer |
| `serve.mjs` | A running `mast serve` of this checkout while a second process rebuilds, by deletion (`remove`) and by the clear (`clear`) |
| `mixed.mjs` | The same with the server from an older checkout, and a per-file mark put on by hand |
| `cost.mjs` | Time and file size of the clear on one database |
| `n8n-rebuild.sh` | A full n8n index into an empty directory, then twice into the cleared database |
| `run.sh` | Runs the first four on the `eval-suite/fixtures/resolver-shapes/` corpus |

## Output kept

- `OUTPUT.txt` — `run.sh`, with the older server built from `00319c0` (schema `1.3.0`, with the
  `runIndex` check).
- `OUTPUT-v0.4.1.txt` — `mixed.mjs` with the older server built from the released tag `v0.4.1`.
- `OUTPUT-n8n.txt` — `n8n-rebuild.sh` on n8n `9d9e9bf9`.

## End-to-end run of the stamp table (`spikes/s2-stamps/`)

`run.sh <built checkout> <empty work directory>` drives each row of the stamp table through
the built CLI: `mast index`, `mast index --incremental`, `mast serve` and `mast status`.
`OUTPUT.txt` is its output on the commit that added the table, with the work directory and
the durations replaced.

## End-to-end run of the per-file mark (`spikes/s3-mark/`)

`healed.mjs <built checkout> <built older checkout> <project copy> <empty state dir>` runs a
server of an older mast while this one rebuilds, lets the old server refresh an edited file,
and prints the alias, the unmarked rows and `mast status` before and after this mast's next
incremental run. `OUTPUT.txt` is its output with the older checkout at `v0.4.1`. The older
checkout is built as in "Running the mixed-version case again" below.

## Checks that cover the change

| Claim | Check |
|---|---|
| The clear keeps the metrics tables and is one transaction | `src/graph/__tests__/clear-derived.test.ts` |
| A handle open before the rebuild reads the rebuilt index; metrics kept; nothing removed without the lock | `src/indexer/__tests__/schema-guard.test.ts` |
| Each row of the stamp table, the refusal of a newer stamp, the line printed, a killed first index | `src/indexer/__tests__/schema-guard.test.ts`, "what an incremental run does with each stamp" |
| Server startup: older and unreadable stamps emptied, newer refused | `src/mcp/__tests__/startup.test.ts` |
| Every row carries the version that wrote it; an unmarked row is rewritten and counted; an older `files` table gains the column | `src/indexer/__tests__/file-mark.test.ts`; the mark is in `dumpStoredRows` (`graph-fixture.test.ts`) |
| The graph of a full index is unchanged | the four scorecard baselines in `eval-suite/baselines/`, compared at each step |

Not yet built: readers refusing an index of another version. `eval-suite/replay-check.mjs` does not compare the mark: every row of a replay is written by one version.

## Running the mixed-version case again

`mixed.mjs` and `run.sh` take a built checkout of an older mast:

```
git worktree add --detach <dir> v0.4.1
ln -s "$PWD/node_modules" <dir>/node_modules && (cd <dir> && pnpm build)
node adr/proposals/schema-rebuild/spikes/s1-inplace/mixed.mjs "$PWD" <dir> <copy of the fixture> <empty state dir> remove
git worktree remove --force <dir>
```
