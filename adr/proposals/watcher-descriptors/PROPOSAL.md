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
  of this as well. Filed as D161, open. It is one more reason for the single recursive
  watch below.
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

## In reserve: one watch for the tree

Step 1 still costs one open file per indexed file, so several servers on a large repository
can fill the table again: n8n has 13,985 indexed files. `fs.watch(root, { recursive: true })`
would hold none per file on macOS. It replaces chokidar on that platform and needs its own
spike (what it reports for a rename, a new directory, an excluded subtree; Linux) before any
code.
