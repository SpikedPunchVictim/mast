# Open files held by a watch (D158)

**Status:** first step done 2026-10-09. No ADR: nothing here changes a stored format or a
public surface. The second step is in reserve.

## What was found

A `mast serve` watches its project with chokidar 5, which calls `fs.watch` on every file it
is not told to ignore (`node_modules/chokidar/handler.js`, `_watchWithNodeFs`). On macOS that
is one open file per watched file for as long as the server runs. Six servers of the
installed 0.4.0 held 94,528 of the machine's 122,880 (D158), and every process on the
machine began failing with `ENFILE`.

The watcher's `ignored` callback pruned directories only. A file was judged by its extension
when an event for it arrived, after it was already being watched.

## Step 1, done: a file that is never indexed is not watched

`isIgnored` in `src/indexer/watcher.ts` now applies `shouldWatchPath` to a path known to be
a file. chokidar passes the path's `stats` the second time it asks, and reconciliation passes
the directory entry's type. A path whose type is not known is not judged by its extension,
because a directory can be named `icons.png`.

Measured with `spikes/s1-open-files/count.mjs` (real chokidar, `startWatchMode` of the built
`dist/`, `lsof` on the process before the watch and after it settles):

| Open files a watch holds | Before | After |
|---|---|---|
| this repository (219 files indexed) | 1,026 | 219 |
| nest `c3bc75c97` | 1,658 | 1,334 |

Directories hold none in either column: `lsof` shows the difference as regular files only.

`spikes/s1-open-files/drive-watch.mjs` drives the built watcher in a temporary project: a
change to an existing `.ts`, a new `.ts`, a change to it, a rename of `notes.txt` to
`notes.md`, a change to that, and a `.ts` in a new directory each start a batch; a change to
a `.png` does not. Output in `drive-watch.out.txt`.

## Reviewed after the commit

A separate review drove the built watcher through 40 steps against the same watcher with
the file rule switched off (renames across the extension boundary, new directories two
deep, symbolic links, a named dot directory, deletes, saves by rename) and found no event
lost. Its scripts are not in the repository. It found two things the first version of this
record did not say (the second is its finding, read against the code and not run again here):

- A symbolic link is followed by chokidar and not by the walk, so the files of a linked
  directory are watched, held open and never indexed. That is older than this change. Run
  again here on `symlink-fixture.sh` (one file, and a link to a directory of eight): 9 open
  files for one indexed file. Filed as D160. Telling chokidar not to follow links brings the
  fixture to 1 (`symlink-links-not-followed.json`), and stops a project whose root is itself
  a link from being watched at all: 2 batches for the real path, 0 for the link
  (`drive-linked-root.out.txt`). That change was not kept. What was: the ignore rule asks
  the disk whether a path below the root is itself a link, and ignores it. The fixture
  holds 1 open file, a linked root gets its batches, and a change reached through a link
  starts none (`drive-links.out.txt`). What the extra question per path costs a start on nest is not
  separated from the load: alternated, 231 to 466 ms asking and 234 to 652 ms not
  (`drive-links.out.txt`, three rounds); in
  two runs one after the other, a median near 550 ms of eight asking and near 250 ms of six
  not (`start-and-close.out.txt`).
- Closing the watcher blocks the process for 23 to 59 s on nest, in the build before any
  of this as well. Filed as D161; see "Leaving without closing" below.
- At each start, reconciliation hands the watcher every link to a file that is not indexed,
  because chokidar ignores it by the file it points at and the directory listing reports a
  link. The watcher ignores it again. Nothing is indexed or lost; neither corpus has one.

The 219 above was this repository when measured; it has 221 indexed files now and the watch
holds 221.

## Not measured

- The grizzly projects the six servers were watching. The 0.4.0 they run is not this build,
  and what share of their 22,469 files has an indexed extension is not known.
- Linux and Windows. Both numbers are macOS.
- Why directories hold no open file. That libuv watches a directory through FSEvents on
  macOS is recalled, not checked here.

## Leaving without closing (D161, 2026-10-10)

**Where the time goes** (`spikes/s2-close/raw-fs-watch.mjs`, nest, Node v24.18.0, macOS, no
chokidar): closing an `fs.watch` on a directory blocks for about 45 ms (median of 636), and
on a file for nothing. 636 directory watches close in 28.8 s; 636 file watches in 1 ms.

**What ends a process holding them** (`exit-without-closing.mjs`): `process.exit` with the
watches open, 0.11 s. Letting the event loop run dry, with `unref()` or with
`persistent: false`, 27 and 29 s. So the cost is paid whenever the handles are closed, by
the program or by Node at the end, and not when the process is ended by `process.exit`.

**Decided** (the user's choice between this and the single recursive watch): `mast serve`
no longer closes the watcher when its client goes. It stops the watcher's work, waits for
an index run that is under way, closes the index and calls `process.exit`.

| `mast serve` on nest, time to leave | before | after |
|---|---|---|
| stdin closed | 23.1, 25.5 s | 12, 9, 9 ms |
| SIGTERM | 22.9, 22.2 s | 9, 9, 11 ms |
| SIGINT | not run | 16, 11 ms |

Measured by `serve-exit.mjs` on the real server, on a loaded machine (load average 5.7
before, 10 after). Exit code 0 on stdin close and 1 on a signal, before and after: the 1 is
the lock module's own signal handler, which is not changed.

**A client that leaves during a batch** (`serve-exit-mid-batch.mjs`, a copy of nest's
`packages/common`, one run): the server left 1.9 s later with exit 0, and the file written
just before was indexed.

**What the review found, and the fix to the fix.** The first version waited only while the
structure lock was held or wanted. A reviewer asked to break it did:

- An index run walks the project before it takes its first lock. A client that left in
  that window ended the server with exit 0 and the run not done. Reproduced here on nest
  with an empty state directory (`serve-exit-early.mjs`): stdin closed 300 and 600 ms after
  the start, exit 0, no `index.json`. The build before any of this finished the run.
- A `mast_reindex` whose client closed stdin straight after got no answer (the reviewer's
  run; re-run here after the fix, and the answer arrives).
- The reason the code gave for waiting, a lock directory left behind, is false:
  `proper-lockfile` removes it on exit. The cost of a run cut off is an index left behind
  the files, or empty, with exit 0.

So the exit now waits for the run itself (`isIndexRunInFlight`, counted around
`runIndex`), not for a lock. With it both early closes finish the run and leave after 5.0
and 4.3 s (`serve-exit-early.nest.out.txt`).

**Not done, not measured.**

- `WatchHandle.close()` still closes every watch and is as slow. Nothing in `src` calls it
  now; the tests do, on trees of a few files.
- A server started with `--no-watch`, or whose watcher failed to start, ends as before: when
  its event loop runs dry.
- On a signal, once any lock has been taken in the process, the lock module's handler
  ends it at once with exit 1, run under way or not, as before. Only a server that never
  took a lock (`--no-startup-reindex`, no batch yet) leaves by the new path, with exit 0;
  the reviewer measured that the build before did not leave at all in that case.
- A tool call other than `mast_reindex` still being answered when the client goes is cut
  off. What it writes is one transaction.
- `graph.db-wal` was left behind in 3 of the reviewer's 18 exits and in none of the runs
  here. The cause was not found. The next process reads through it.
- If stdin closes before the watcher has been started, nothing is listening for it. Not
  changed and not measured.
- Linux and Windows. Whether closing a watch costs anything there is not known.
- No test times an exit. The numbers above are the two scripts' and need a large tree.

## In reserve: one watch for the tree

Step 1 still costs one open file per indexed file, so several servers on a large repository
can fill the table again: n8n has 13,985 indexed files. `fs.watch(root, { recursive: true })`
would hold none per file on macOS. It replaces chokidar on that platform and needs its own
spike (what it reports for a rename, a new directory, an excluded subtree; Linux) before any
code.
