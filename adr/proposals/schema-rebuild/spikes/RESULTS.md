# schema-rebuild — spike results

Run 2026-10-08 on mast `24e5799` (clean tree, `pnpm build` of that commit), macOS, Node 24.18.0,
better-sqlite3 12.11.1. Scripts and raw output are in [`s1-inplace/`](s1-inplace/). Everything
below is **measured** by those scripts unless a line says otherwise. The spike is throwaway:
`clear.mjs` is a prototype, not the code that will ship.

## The questions, written before the scripts

1. Can the derived tables be dropped and created again inside `graph.db` while a second
   connection holds statements it prepared earlier?
2. What does that connection get when a re-created table has other columns?
3. Does a running `mast serve` answer from an index another process rebuilt under it?
4. Do the metrics rows survive?
5. What happens when the clear meets a read in progress, or a writer?
6. What does the clear cost at n8n size, and is the rebuilt file larger or the rebuild slower?
7. What does a `mast serve` of an older version do to the rebuilt index?
8. Would a per-file mark find the rows such a server writes?

## Q1, Q2, Q5 — two connections (`two-connections.mjs`, `OUTPUT.txt`)

Corpus: `eval-suite/fixtures/resolver-shapes/`, 31 files, 100 symbol rows. The reader prepares
five statements, then the writer clears.

| Case | Reader's statements afterwards |
|---|---|
| 1. clear, same columns | all five run; `symbols` 100 → 0, FTS matches 57 → 0, `metrics` 2 → 2 |
| 2. writer inserts one file and one symbol | the reader's counts go 0 → 1 |
| 3. `symbols` re-created without `body_hash`, with a new `NOT NULL` column | four run; the one naming `body_hash` throws `SQLITE_ERROR no such column: body_hash` |
| 4. clear while the reader is one row into a 5,000-row read | the clear succeeds; the open read returns all 5,000; the reader's next statement returns 0 |
| 5. clear while the other connection holds a write transaction, busy timeout 2,000 ms | the clear throws `SQLITE_BUSY database is locked` and nothing is dropped |

The clear took 3 to 9 ms on this database. `integrity_check` is `ok` at the end.

Twelve tables are dropped: `files`, `symbols`, `edges`, `re_export_files`,
`edge_repair_pending`, `star_reexport_unresolved`, `reexport_aliases`, `imports`, `chunks`,
`chunk_fts`, `identifier_fts`, `checker_verdicts`. Two are kept: `metrics`, `metrics_daily`.

The prototype turns `foreign_keys` off for the transaction. With it on, `DROP TABLE` deletes
row by row and checks every reference. The cost with it on was not measured.

## Q3, Q4 — a running server of this version (`serve.mjs`, `OUTPUT.txt`)

One `mast serve --no-watch --no-startup-reindex`. A file with a new caller of `K.save` is
added, and a second process rebuilds.

| | deletion (today) | clear in place |
|---|---|---|
| server finds the new file | no | yes |
| server's callers of `K.save` | 2 (the old answer) | 3 |
| a new process's callers of `K.save` | 3 | 3 |
| metrics rows on disk, before → after | 2 → 0 | 2 → 2 |
| server's `mast_status` `stale_files` | 1 | 0 |

In the deletion arm the rebuild is triggered by a stamp set to `1.3.0` by hand. In the clear
arm the prototype clears and the CLI then runs a normal full index. The server calling its
own `mast_reindex` over an in-place clear was not run; it is the same file and a second
connection, so it is **inferred** to behave as Q1.

## Q6 — n8n size (`cost.mjs`, `n8n-rebuild.sh`, `OUTPUT-n8n.txt`)

The n8n copy at `9d9e9bf9`, 13,985 files, a 445,681,664-byte `graph.db` (108,809 pages).

**The clear.** Three runs on that database: 4,455.5 ms (a copy just made, earlier in the
session, output not kept), 612.1 ms and 3,147.8 ms. It writes 0.7 MB to the WAL and moves
108,765 of 108,809 pages to the free list. The file does not shrink.

**The rebuild**, one after another on one machine with nothing else running:

| Full index into | Duration | Rows after | Pages, free pages, bytes |
|---|---|---|---|
| an empty state directory | 95.9 s | 13,985 files, 71,091 edges, 51,963 imports, 73,385 chunks | 108,809, 0, 445,681,664 |
| the same database after the clear | 118.2 s | the same four counts | 108,809, 0, 445,681,664 |
| the same database after a second clear | 102.8 s | the same four counts | 108,809, 0, 445,681,664 |

- The rebuilt file is the same size to the byte, with no free page left. The space is reused.
- The counts equal those of a full index into an empty directory, and the nine counts of
  `incremental-graph-correctness/spikes/n8n-counts/counts.json` (compared with `diff` for an
  earlier cleared rebuild in this session, which took 137.9 s while other spike scripts ran).
  Counts are not a row-by-row comparison; that is the proposed test's job.
- The rebuild into a cleared file was slower than into an empty directory both times, by 7%
  and by 23%. There is one run of the empty-directory arm here (and 82.8 s for the same
  commit's code in `counts.json`), so the size of the difference is not established, only
  its direction in two of two pairs. Writing into pages taken from a free list in no
  particular order is the **inferred** cause; it was not measured.

## Q7, Q8 — a server of an older version (`mixed.mjs`, `OUTPUT-v0.4.1.txt`, `OUTPUT.txt`)

The older mast indexes (stamp `1.3.0`) and serves. This branch's mast then rebuilds (stamp
`1.4.0`, the import row of `al.ts` has `{"Kay":"K"}` in `aliases`). A `written_by` column is
added to `files` by hand and filled for all 32 rows. `al.ts` is edited. The old server is
asked for a signature in that file, then for `mast_reindex`.

Older server from the released tag `v0.4.1` (no check in `runIndex`):

| Step | deletion | clear in place |
|---|---|---|
| after the old server's read of the edited file | stamp `1.4.0`, alias kept, 0 files unmarked | stamp `1.4.0`, **alias `NULL`**, 1 file unmarked (`al.ts`) |
| old server's `mast_reindex` | indexed 1, skipped 31 | indexed 0, skipped 32 |
| after it | **stamp `1.3.0`, alias `NULL`**, 1 file unmarked | **stamp `1.3.0`**, alias `NULL`, 1 file unmarked |

Older server from `00319c0` (schema `1.3.0`, with the `runIndex` check): the read step is the
same in both arms as above. Its `mast_reindex` then removes the whole `1.4.0` index and writes
a `1.3.0` one, `imports` without the `aliases` column, in both arms. That is D129 seen from
the other side: a version that deletes whatever is not its own also deletes a newer index.

What this says:

- Under deletion the old server reads and refreshes a file nobody else can see, so its read
  does no damage; its `mast_reindex` opens the path again and does.
- Under the clear the old server shares the file, so its read-time refresh does the damage
  earlier, and under a stamp that says `1.4.0`.
- Either way the index ends stamped `1.3.0` once the old server reindexes, and the next run
  of the new mast rebuilds it.
- The hand-made mark was empty for `al.ts` and for no other file at every step where an old
  binary had written it.

Which released versions exist: tags `v0.2.0`, `v0.3.0`, `v0.4.0`, `v0.4.1` all have
`CURRENT_SCHEMA_VERSION = '1.3.0'` and no `wipeDerivedState` in `src/indexer/index.ts`
(`git grep` at each tag). `npm view @spikedpunch/mast versions` also lists `0.1.0`, which has
no tag and was not checked.

## A side measurement

`PRAGMA user_version`, 100,000 reads on one connection: 145.6 ms, so about 1.5 µs each. One
run, not repeated. It is quoted only for the reserve item in the proposal.

## Not measured

- Windows, where an open file cannot be deleted the same way.
- A server with the watcher on, and two servers.
- What a server answers while another process is part way through the rebuild.
- Whether an old server's edge repair writes rows for a file whose `files` row it leaves alone.
- The clear with `foreign_keys` on.

## After the build: the shipped stamp table and mark (2026-10-08)

Not part of the spike. These two runs use the production code, not `clear.mjs`.

**`s2-stamps/`** (commit `4051231`): each row of the stamp table through the built CLI.
An older stamp and an unreadable one are rebuilt with one line on stderr; a newer one stops
`mast index`, `mast index --incremental` and `mast serve` with exit 1 and leaves 2 of 2 file
rows; a database with file rows, no edges and no stamp gets its edge back.

**`s3-mark/`**: the Q7 case with a `v0.4.1` server and the shipped `written_by` column, on
the 32-file fixture.

| Step | On disk |
|---|---|
| this mast rebuilds the old server's index | stamp `1.4.0`, alias kept, 0 rows unmarked |
| the old server answers `mast_signature` for the edited `al.ts` | stamp `1.4.0`, alias `NULL`, 1 row unmarked; this mast's `mast status`: `stale_files: 1` |
| `mast index --incremental` by this mast | 1 indexed, 31 skipped; alias back, 0 rows unmarked; `stale_files: 0` |
| the old server's `mast_reindex` | stamp `1.3.0` |
| `mast index --incremental` by this mast | rebuild announced, 32 indexed; alias kept, 0 rows unmarked |

What this run does not show: the edited file was also behind in the manifest, and the
stability skip compares import aliases, so step 3 would have rewritten it without the mark
(the unit test for that case passed before the mark was read anywhere). The mark is what
catches a row that is not behind in the manifest, or whose difference the skip does not
compare; both are unit tests in `src/indexer/__tests__/file-mark.test.ts`, not runs against
an old server.
