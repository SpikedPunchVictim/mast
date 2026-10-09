# Proposal — rebuilding an index another mast version built

**Status:** proposed 2026-10-08; the design and the three decisions below were accepted by the
user the same day ("I agree with all three recommendations"). Being built in the order at the
end; progress is in "Built so far". The spike is in [`spikes/s1-inplace/`](spikes/s1-inplace/),
its numbers in [`spikes/RESULTS.md`](spikes/RESULTS.md).

This is design work with a throwaway spike, not a registered experiment under ADR 010. Nothing
here is a pre-registration. `FINDINGS.md` was searched for `schema`, `wipe` and `index.json`
all the same: it holds no settled claim and no dead hypothesis about the rebuild.

## The problem

`index.json` names the schema version that built the index. When it names another version,
`runIndex` and `mast serve` delete `graph.db` and its sidecar files and index from nothing
(`src/indexer/index.ts:317-320`, `src/mcp/startup.ts:94-103`, `src/store/derived-state.ts`).
Seven ledger rows are open against that:

| Row | Sev | What happens |
|---|---|---|
| D125 | S0 | A running `mast serve` keeps the deleted file open and answers from it; its reindex is written to a file it does not read |
| D126 | S2 | `metrics` and `metrics_daily` are in `graph.db` and go with it |
| D127 | S1 | The deletion happens before the structure lock is taken; with the lock held the run leaves 0 files and exits 0 |
| D128 | S2 | An empty `index.json` ends every command with `SyntaxError: Unexpected end of JSON input` |
| D129 | S2 | The rebuild prints nothing, and an index from a *newer* mast is deleted like any other |
| D137 | S0 | A first index killed before it writes `index.json` is taken by `--incremental` as complete: 906 of 917 edges, reported fresh |
| D138 | S1 | `mast status` prints the binary's version over an index of another, and the read tools answer from it |

## Prior decisions this touches

1. **A version change rebuilds from nothing** (`MAST_SPEC.md` §7.4 Step 2, lines 616-623 and
   679-690). Kept. Only the way the old rows are removed changes.
2. **Every index run makes the check, not only `mast serve`** (D113, `MAST_SPEC.md:673-677`). Kept.
3. **`mast upgrade` warns of the rebuild before it happens** (ADR 014 §3). Kept; the rebuild
   itself now also says so when it happens.
4. **`mast query` does not climb the startup ladder** (ADR 015, lines 126-130). This proposal
   changes one thing there: a read command checks the stamp. It still does not index.
5. **A column added with `ALTER TABLE … ADD COLUMN` needs no version change**
   (`MAST_SPEC.md:686-688`). Kept, and used for the per-file mark below.
6. **`mast_status` reports the running binary's version** (`src/mcp/tools/__tests__/tools.test.ts:887`).
   Kept, and the index's own version is added beside it.
7. **Chunks live in `graph.db`** (ADR 006). This is why one transaction can clear everything.
8. **Metrics are user history, not derived state** — not written down anywhere before now.
   `derived-state.ts:5` says everything it removes "is rebuilt from source by a reindex",
   which is false for the two metrics tables.

Every released version (tags `v0.2.0` to `v0.4.1`) carries schema `1.3.0`, and none has the
check in `runIndex`. `1.4.0` exists only on this branch. So the next release is the first
version change any installed mast will cross. `0.1.0` is on the registry with no tag and was
not checked.

## What the spike found

Eight questions were written before the scripts. The full output is in `spikes/s1-inplace/`.
All of it is **measured** unless marked.

1. **A second connection survives the clear.** Statements it prepared before the tables were
   dropped and re-created return the new contents afterwards, including FTS matches. A read
   already in progress finishes on the old rows (5,000 of 5,000).
2. **A changed column fails loudly, not quietly.** After a clear that re-created `symbols`
   without `body_hash`, the reader's statement naming it throws `no such column: body_hash`.
3. **A running `mast serve` of this version answers from the rebuilt index.** After another
   process cleared and rebuilt, the server found a file added in between and returned the
   same three callers as a new process. With today's deletion it returned the old two and
   did not find the file.
4. **Metrics rows survive**: 2 before, 2 after. With today's deletion: 2 before, 0 after.
5. **The clear waits for a writer and then fails.** With another connection in a write
   transaction it throws `SQLITE_BUSY` after the busy timeout. Nothing is half cleared.
6. **At n8n size the clear takes seconds and the file is reused.** On the 446 MB n8n
   index the clear took 0.6 to 4.5 s over three runs. The rebuilt file is the same size to
   the byte, with the same row counts. The rebuild took 118.2 s and 102.8 s against 95.9 s
   into an empty directory: slower both times, by an amount one run per arm does not settle.
7. **A server of an older version damages the index under either method.** A released
   `v0.4.1` server, running while this branch's mast rebuilt the index:
   - under today's deletion, its `mast_reindex` wrote one file's rows in the old shape into
     the new database and stamped the index `1.3.0`;
   - under the in-place clear, its refresh of one edited file on a read wrote that file's
     import row with no alias, and the stamp stayed `1.4.0`. This is new damage that the
     deletion does not cause: the old server now writes to the file everyone reads.
8. **A per-file mark finds exactly those rows.** With a column on `files` that only the new
   mast fills, the one file the old server rewrote was the one file with no mark, in every
   arm (1 of 32).

Finding 7 is the one I did not expect, and it changes the design: the stamp is one value for
the whole index, and the damage is done one file at a time (SHAPES S-02).

## Design

**1. Clear in place.** One function drops every table except `metrics` and `metrics_daily`
and creates them again from the schema, in one transaction, and removes `file_manifest.json`.
It replaces `wipeDerivedState` in both callers. It runs inside the structure lock. A run that
cannot take the lock fails as it does today for any other reason, and has cleared nothing.

**2. The stamp is written last, as now.** A rebuild that dies leaves the old stamp, so the
next run clears and starts again. `bootstrapState` stops writing the new stamp before the
index exists.

**3. What a run does with each stamp.**

| `index.json` | Database | The run |
|---|---|---|
| this version | any | as asked |
| an older version | any | prints one line naming both versions, clears, reads every file |
| a newer version | any | stops, exit 1, naming both versions and the two ways out (upgrade mast, or delete the state directory) |
| unreadable | any | treated as an older version; the line says the stamp could not be read |
| absent | has file rows | a run did not finish: reads every file (D137) |
| absent | empty | a first index |

**4. Every file row carries the version that wrote it.** A nullable column on `files`, added
by `ALTER TABLE`, filled by this mast and left empty by any older one. The stability skip
treats a row without this version's mark as changed, so the next run of the right version
rewrites it. `mast status` counts such rows. This is what makes finding 7 heal, for released
versions that cannot be changed and for every later pair of versions.

**5. Readers.** `mast status` and `mast_status` show the index's version beside the binary's.
`mast query`, `mast search` and the read tools of a server, on an index of another version,
return an error that names both versions and says to run `mast index`. A server rebuilds at
startup as it does now, so in a server this is reached only when another version has
restamped the index while it runs.

## Design reserve

Thought through and **not** proposed for building. Each needs evidence to enter.

- **The version inside the database** (`PRAGMA user_version`), checked by every write
  transaction, so a writer of another version refuses instead of writing. Reading it costs
  1.5 µs (145.6 ms for 100,000 reads). It cannot protect against released versions, which is
  the case in front of us, and the per-file mark covers the versions after. Enters if a
  mixed-version write is found that the mark does not catch (edge rows re-resolved by an old
  server's repair are the candidate; not measured).
- **Making an old writer fail**, by a `NOT NULL` column it does not fill. Would stop finding
  7 at the write. Not measured, and it is a trick the next reader has to be told about.
- **Deleting the file when no other process has it open**, to get the faster rebuild of
  finding 6. Needs a way to know nobody has it open, and a second code path. Enters if the
  slower rebuild is confirmed and matters; a rebuild happens once per upgrade.
- **Changing the shape of the metrics tables.** No version has needed it. Additive columns
  already go through `ALTER TABLE`.

## Decisions that are the user's

Each of these is a stored format or a behaviour users will meet, so I am asking, with a
recommendation.

1. **The per-file mark (design 4).** Recommended. It is a new column in the stored schema.
   Without it the in-place clear is worse than the deletion in the one case of finding 7.
2. **A read on an index of another version is an error (design 5).** Recommended. The other
   choice is to answer with a warning field, as `index_empty` does. I recommend the error
   because a version change means the stored rows may be wrong for this code, and a warning
   on a wrong answer is still a wrong answer.
3. **An unreadable stamp is rebuilt, not refused.** Recommended: the index is derived, and
   nothing in an unreadable stamp says a newer mast wrote it.

**Decided 2026-10-08:** the user accepted all three as recommended.

## Built so far

| Step | Commit | Rows closed | Differs from the design above |
|---|---|---|---|
| 1. Wider comparison | `f3c8f8e` | D134 | The two FTS tables and `files.language` are still not compared |
| 2. Clear in place, under the lock | `c77faf0` | D125, D126, D127 | After the clear `index.json` keeps the old version's name with empty counts, not the old stamp unchanged: the name makes the next run rebuild, the empty counts stop `--no-startup-reindex` serving it |
| 3. The stamp table | `4051231` | D128, D129, D137 | An absent stamp makes the run a full one whether or not the database has rows; the two rows of the table differ only in the line printed. An unreadable stamp is left as it is by the clear. `mast serve` refuses a newer stamp at startup with the same message as `mast index` |
| 4. The per-file mark | this commit | D142 | The freshness measure counts an unmarked row under `changed`, so `mast status` shows it in `stale_files`; there is no separate count. The refresh on a read does not look at the mark |

Step 4 with a released `v0.4.1` server: [`spikes/s3-mark/`](spikes/s3-mark/).
Step 3 through the built CLI, row by row: [`spikes/s2-stamps/`](spikes/s2-stamps/).

## Which instrument covers each claim

The scorecard compares the graph of a full index with the compiler. A rebuild ends in a full
index, so the scorecard covers its result and nothing about how it got there.

| Claim | Instrument |
|---|---|
| The graph after a rebuild equals a full index into an empty directory | `expectGraphEqualsFullIndex` in a new test; the four scorecard baselines must not move |
| A server answers from the rebuilt index | a tool-handler test holding one database handle across a rebuild; the spike's `serve.mjs` kept as the end-to-end run |
| Metrics rows survive | a test on the clear function |
| A run without the lock clears nothing | a test with the lock held; `mast search --reindex` exits non-zero |
| Each row of the stamp table | one `it.each` over the six rows, asserting files read and exit |
| A killed first index is completed by `--incremental` | a test that stops a run after pass 1; replay check widened to report files skipped per step |
| Rows of another version are rewritten | a test that empties one file's mark and runs `--incremental` |
| A changed column | a test that builds a database with an older `symbols` table and rebuilds |
| Readers refuse another version | tool-handler and CLI tests; `tools.test.ts:887` extended to the second field |
| Nothing else stored changes on an incremental run | replay check, after D134 is closed |

D134 is part of this work: the replay check and `dumpGraph` are widened to symbol flags,
`imports.aliases`, `reexport_aliases`, `star_reexport_unresolved`, chunks and the new mark
before the first production change, so that the comparison in the first row sees every table.

## Order of work

1. Widen `dumpGraph` and the replay check (D134). Each new field is seen to fail on a planted difference.
2. The clear function, with its tests, replacing `wipeDerivedState` in `runIndex` under the lock (D125, D126, D127).
3. The stamp table (D128, D129, D137), then `bootstrapState`.
4. The per-file mark and the stability skip.
5. Readers (D138).
6. Spec §7.4 and §13.8, ADR for the decision, `mast upgrade` wording, ledger rows closed.

Each step is red then green, and `pnpm gate` and the four scorecard comparisons run at each.

## Not known

- **Windows.** The deletion of an open file behaves differently there. Not run. The in-place
  clear does not delete the file, which is inferred to remove that difference.
- **What a server answers during the rebuild.** Between the clear and the end of the run the
  index is partly filled. Which of `index_empty`, `unindexed_files` and `stale` fire in a
  server when *another* process is rebuilding was not measured.
- **Two servers, or a server with the watcher on.** The spike ran one server with
  `--no-watch --no-startup-reindex`. A watcher's write during the clear meets finding 5:
  the clear waits up to the busy timeout and then fails. How often was not measured.
- **Old-version repair of edges.** The mark is on a file's own row. Whether an old server can
  rewrite another file's edges without touching that file's row was not measured.
- **The Docker seed** (`MAST_SPEC.md:3099-3103`, in §13.8). A seed of an older version takes the same path
  as any older stamp. Inferred from code, not run.
- **`0.1.0`** was not checked for its schema version.
