# ADR 019 — An index another version built is rebuilt in place, or refused

- **Status:** Accepted and implemented (2026-10-08)
- **Decided:** 2026-10-08, by the user, from [`proposals/schema-rebuild/PROPOSAL.md`](proposals/schema-rebuild/PROPOSAL.md)
- **Evidence:** [`proposals/schema-rebuild/spikes/RESULTS.md`](proposals/schema-rebuild/spikes/RESULTS.md)
  (spike and four end-to-end runs) · [`proposals/schema-rebuild/EVAL.md`](proposals/schema-rebuild/EVAL.md)
  (scripts and the tests that pin each claim) · `docs/defects/LEDGER.md` D125 to D129, D134,
  D137, D138, D142

This was design work with a throwaway spike, not an experiment registered under ADR 010.
`FINDINGS.md` was searched for `schema`, `wipe` and `index.json` before the proposal and held
no settled claim and no dead hypothesis about the rebuild.

## Context

`index.json` names the schema version that built the index. When it named another version,
an index run and `mast serve` deleted `graph.db` and indexed from nothing. A review of that
code on 2026-10-08 found seven defects, each run again before it was filed. The two that
decided the design, both **measured** in the spike:

- A running `mast serve` kept the deleted file open. After another process rebuilt, the
  server did not find a file added since and gave 2 callers of a method where a new process
  gave 3; its `mast_status` reported one stale file and nothing else (D125).
- The usage metrics are in the same file and went with it: 2 rows before, 0 after (D126).

The others: the deletion ran outside the structure lock (D127); an empty `index.json` ended
every command with a `SyntaxError` (D128); the rebuild printed nothing and an index from a
newer mast was deleted like any other (D129); a first index killed before its stamp was read
by `--incremental` as complete (D137); no reader looked at the version (D138).

## Options weighed

1. **Keep deleting, and make a server reopen its database.** Every long-lived handle would
   need to notice the file under it had changed. Nothing in the server does that today, and
   it leaves the metrics lost.
2. **Empty the derived tables inside the same file.** Chosen. A second connection's
   prepared statements keep working across it (spike Q1), so a running server reads the
   rebuilt index with no change to the server.
3. **Migrate rows in place instead of rebuilding.** Not weighed further: the index is
   derived, and a rebuild is a full index that the scorecard already checks.

## Decision

1. **The rebuild empties twelve derived tables in one transaction, under the structure
   lock, and keeps `metrics` and `metrics_daily`.** `index.json` is then rewritten with the
   old version's name over empty counts, so a rebuild that dies is started again.
2. **What a run does with each stamp.** This version: as asked. Older: one line on stderr
   naming both versions, then a rebuild. Newer: the run and `mast serve` stop with an error
   naming both versions, and the index is left as it was. Unreadable: rebuilt, and the line
   says so. Absent: every file is read.
3. **Every file row carries the schema version that wrote it** (`files.written_by`). An
   incremental run rewrites a row without this version's mark, and `mast status` counts it
   as changed. This is for a server of an older mast that shares the file and rewrites a
   row after the rebuild.
4. **A read over an index of another version is an error**, not an answer with a warning
   field. The eight tools that answer from stored rows return it; `mast status` and
   `mast_status` print the index's version beside the binary's.

Items 3, 4 and "unreadable is rebuilt" were put to the user as three separate questions,
because each is a stored format or a behaviour users meet. All three were accepted as
recommended.

## Consequences

- **Measured:** with the spike's prototype clear in place of the deletion, the running
  server finds the new file, gives 3 callers, and the metrics rows go 2 to 2 (spike Q3, Q4).
  The shipped code is pinned by `src/indexer/__tests__/schema-guard.test.ts`, "is read by a
  database handle that was open before it ran (D125)" and "keeps the metrics rows of the
  index it rebuilds (D126)".
- **Measured:** on n8n (13,985 files, a 445,681,664-byte `graph.db`) the clear took 612 ms
  to 4,455 ms over three runs. The rebuilt file is the same size to the byte.
- **Measured, direction only:** a full index into the cleared file was slower than into an
  empty directory in two of two pairs, by 7% and 23% (102.8 s and 118.2 s against 95.9 s,
  one run of the baseline). The size of the difference is not established.
- **Measured:** the check a read now runs costs 26.1 to 47.2 µs per call over a valid stamp
  (five runs of 10,000, one machine).
- A database from this branch built before the mark existed has every row rewritten once
  by its next incremental run.
- Upgrading mast and then running `mast search` before `mast index` or `mast serve` now
  stops with an error where it used to answer. `mast upgrade` says so in advance.
- The graph a full index produces is checked by the four scorecard baselines: the four
  comparisons exited 0 after the stamp table, after the per-file mark and after the
  readers. For the two steps before those I have no kept record of the comparison.

## What it does not claim

- **That the per-file mark has healed a row in a real mixed-version run.** In the one run
  with a released `v0.4.1` server, the row it damaged was also behind in the manifest and
  would have been rewritten without the mark. The mark's own effect is covered by unit
  tests only.
- **That a read is safe during a rebuild by another process.** What a server answers part
  way through was not measured. The emptied index is not refused; it answers with
  `index_empty`.
- **That an unreadable stamp is safe to read over.** A read answers over it, because the
  stamp is not written through a rename and a reader beside a running index can catch it
  empty. `mast status` reports it.
- **That the refresh a read does on one file looks at the mark.** It does not; only an
  index run rewrites an unmarked row.
- **Anything about Windows, a server with the watcher on, or two servers.** Not run.
- **Anything about a real newer mast.** None exists; the newer case was run with a stamp
  set to `9.9.0` by hand.

## Held in reserve

Recorded in the proposal with what evidence would bring each in: a version inside the
database checked by every write, a column an old writer cannot fill, deleting the file when
nobody has it open, and changing the shape of the metrics tables.
