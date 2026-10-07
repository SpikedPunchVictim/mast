# S11 — what recording an empty FTS block saves when markdown is re-indexed (D082, M6)

Run 2026-10-07, working tree on top of `0d73ac4` with the M6 change applied. Script:
`time-md.sh`. Raw output: `n8n.out`.

## Question

M6 was held in reserve on a reviewer's simulation (20 markdown files, median 741 ms cut to 5 to
8 ms) that I had not re-run. With the change written: what does `fts_del` cost for a markdown
file before and after, on the same index?

## Method

The n8n scratch clone at `9d9e9bf97e` (13,985 indexed files, 525 markdown), with an index written
by a build from before the change, so all 525 markdown files held a NULL identifier block. The
first re-write of such a file takes the old path, a scan of `identifier_fts` (69,876 rows) by
path, and records the empty block; later re-writes take the new path. Three sets of 20 files
were each edited and indexed four times, and five single files three times each. `fts_del` is
the span reported by `mast index --incremental --phase-timing`.

## Result (measured)

The machine was busy with other work throughout: load average 34 at the start and 24 at the end.
Every figure is inflated by that, so read the ratio and not the milliseconds.

| | `fts_del`, first re-write (NULL block) | `fts_del`, later re-writes (empty block) |
|---|---|---|
| 20 markdown files, 3 sets | 7038, 3895, 3978 ms | 7 to 519 ms over 9 runs; median 17 ms |
| 1 markdown file, 5 files | 2215, 1275, 1305, 1021, 1639 ms | 0 or 1 ms over 10 runs |

The first set of 20 is the slowest in both columns (7038 ms, then 519, 180, 248): the table had
not been read yet. The single-file runs came after 12 runs that had read it, so their first
re-writes are not a cold cache.

Run duration for one markdown file went from 2854–3883 ms to 822–1344 ms.

## Reading

- The scan was the whole `fts_del` cost for these files; with the empty block it is at the level
  of a typescript file with a block (0 to 3 ms in S0).
- An index written before the change heals one file at a time: 65 of the 525 markdown files had
  been re-written by the end and held the empty block, and 460 still held NULL. Each of those
  pays the scan once more, on its next re-write. Nothing rewrites them in bulk, and nothing
  needs to: the result is correct either way.

## Limits

- One corpus, one machine, under load. No quiet-machine figure.
- Only markdown (no identifier rows) was timed. A file with no chunks at all takes the same path
  for `chunk_fts`; that is covered by a test, not by this timing.
- The delete path (`removeDeletedFiles`) is covered by a test and was not timed.
