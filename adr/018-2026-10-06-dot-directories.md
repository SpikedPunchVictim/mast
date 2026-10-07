# ADR 018 — Dot directories are walked only when named

- **Status:** Accepted and implemented (2026-10-06)
- **Decided:** 2026-10-06
- **Evidence:** the scratch-project runs quoted below, made on 2026-10-06 with the built CLI ·
  `src/indexer/__tests__/dot-dirs.test.ts` · `docs/defects/LEDGER.md` D071

## Context

A user could not get `.agents/` into the index, and no setting could do it. `walkProject`
hands fast-glob the patterns `**/*<ext>` without `dot: true`, and fast-glob does not enter
a dot-leading directory for such a pattern. `file_extensions` only ever produced patterns
of that form, and `exclude_patterns` can only remove.

It also failed without saying so. **Measured** with the CLI as built before this change, a scratch project
holding `src/x.ts` and four `.md` files under dot paths (`.agents/a.md`,
`.agents/sub/b.md`, `.root.md`, `pkg/.hidden/h.md`): `mast init` then `mast status`
printed `indexed_files: 1`, `stale_files: 0`, `index_fresh: true`. The freshness probe
walks with the same function, so the four files were not counted as unindexed either. The
README listed what is indexed as five extensions minus the excludes, and did not mention
dot directories.

**Inferred from code, not run:** watch mode disagreed with the walker. chokidar was given
only `exclude_patterns` and the state directory to ignore, so it watched every dot
directory, `.git` included, and `shouldWatchPath` accepted `.history/x.ts`. Each such
event queued an incremental run that then walked none of those files.

## Options weighed

1. **`dot: true` in the walker, with more default excludes.** One line. It changes what
   every existing project indexes on upgrade, and the exclude list it depends on cannot be
   complete: it has to name every dot directory that holds copies of source. In this
   repository it would add 8 files to the 156 walked on 2026-10-06 before this change, 2 under `.agents` and
   6 under `.history`, the second being editor-saved copies of files already indexed.
   Duplicate declarations are what make `mast_callers` and ranker D wrong.
2. **A boolean `index_dotfiles`.** Option 1 behind a switch; the same incomplete list once
   it is on.
3. **An opt-in list of directories.** Nothing changes until a project names a directory.

## Decision

Option 3: `include_dot_dirs`, an array of directory paths relative to the project root,
default empty.

- **Entries are literal paths, not globs.** fast-glob enters a dot directory that a
  pattern names, so each entry becomes `<dir>/**/*<ext>` and `dot` stays off. A glob entry
  would have to be expanded by the walker and re-implemented by the watcher.
- **One level of opt-in per entry.** `**` below a named directory still skips dot entries,
  so `.agents/.cache` needs its own entry. This falls out of leaving `dot` off, and it is
  the behaviour wanted: naming `.claude` should not pull in `.claude/.something` unasked.
- **`exclude_patterns` still applies** inside a named directory.
- **The key is validated when config is resolved**, unlike the rest of `mast.config.json`.
  An entry throws when it is empty, absolute, padded with whitespace, has a `..` segment
  (`..scratch` is a name and is accepted), contains a glob character, a pipe or a
  backslash, or has no dot-leading segment. The message names the file the entry came
  from, `mast.config.json` or the saved `<state_dir>/config.json`. Unvalidated, such an entry is a pattern that matches
  nothing, and the result is the silent state this ADR started from.
- **One statement of the rule.** `src/indexer/scope.ts` builds the walker's patterns and
  holds the per-path predicates watch mode uses. `dot-dirs.test.ts` compares the
  predicates with fast-glob's answer on a real tree for six configurations.
- **The watcher prunes dot directories that are not named.** This changes behaviour for
  every project, not only those that set the key: `.git` and its like no longer get an OS
  watch. It removes work that produced nothing.
- **`mast walk`** prints what the resolved config walks, by directory, without an index.
  It calls `walkProject`, so it cannot disagree with `mast index`. An entry that
  brought no file into the walk is flagged with which of four causes applies: no
  directory of exactly that name, a symbolic link, a file, or a directory with nothing
  walkable in it. A file is credited to the entry that makes the walk reach it, so an
  entry above a deeper named one is not shown as working on the deeper one's files.
- **The empty-result text** of `mast search`, `mast docs signals` and `mast skill` now
  says dot directories are skipped unless named.

No schema bump. Adding an entry makes its files "added" in the next manifest diff;
removing one makes them "deleted". **Measured** for adding: the scratch project above with
`include_dot_dirs: [".agents"]`, `mast index` then `mast status`, printed
`indexed_files: 3`, `index_fresh: true`. Removing was **inferred from `diffManifest`** by
the author and then **run by the review** (a scratch project, 2026-10-06):
`chunks: +0 -2`, `indexed_files` 4 to 2, fresh. That run is the reviewer's report, not
re-run by the author.

## What it does not claim

- A dot directory nobody named is still invisible, and `unindexed_files` still does not
  count it. A caller in `.storybook/preview.ts` is missing from `mast_callers` until the
  project lists `.storybook`. What changed is that the README, the spec, the empty-result
  text and `mast walk` now say so. No tool response carries a signal for it.
- Deleting the key from `mast.config.json` does not turn it off once `mast init` or
  `mast serve` has saved a config: `<state_dir>/config.json` supplies any key the project
  file leaves unset, as it already did for `exclude_patterns`. **Measured** in the scratch
  project: `mast init` with `[".agents"]`, the config file removed, `mast walk` still
  listed `.agents`. Setting `"include_dot_dirs": []` turns it off. `mast walk` names the
  saved file; the precedence itself is unchanged.
- Dot-leading **files** are not indexable anywhere, inside a named directory included
  (`.agents/.notes.md` is skipped with `.agents` listed). Nothing here adds that.
- **Symbolic links.** The walk does not follow them and chokidar does, so an edit behind
  a link inside a named directory still queues an index run that walks nothing. That
  mismatch predates this ADR for ordinary directories; naming `.claude`, where linked
  skill directories are common, makes it likelier. `mast walk` reports an entry that is
  itself a link; it does not detect links further down.
- `skill`, `setup` and `hook claude search` exit 0 without mentioning a rejected entry
  (reported by the second review, not re-run).
- **A malformed value in `<state_dir>/config.json`** (a string where an array belongs)
  is dropped without a message, as every key read from that file is.
- A directory whose real name contains a glob character, a pipe or a backslash cannot be
  listed. The rejected characters are a hand-written list checked against fast-glob by
  trying names, not derived from it: a second review tried
  `+ # ^ $ @ , & : ~ % ' <`, a space, a tab and a newline and all were walked.
- **An entry that is valid but can never match** is accepted: `.mast` and `.next` (both
  in the default `exclude_patterns`), or `~/.agents`. Only `mast walk` shows it, as
  `empty` or `missing`. A name that differs from the disk in Unicode normalisation is
  reported `missing` with advice about spelling and case only.
- The search-reminder hook (`mast hook <harness> search`) decides by extension only. A
  Grep scoped to a dot directory that is not indexed is still reminded about
  `mast_search`.
- The `--checker` pass discovers `tsconfig.json` files with its own glob, which does not
  enter dot directories. TypeScript in a named dot directory is indexed; whether the
  checker resolves calls in it was not tested.
- Windows path separators in an entry were not tested.

## Follow-up, 2026-10-06: what the reviews found beside the feature

Fixed on the same branch at the user's request. The four numbered defects have ledger
rows; the changes to how an error is printed do not.

- **A config the user can fix is one line, in every command.** `UserError`
  (`src/user-error.ts`) marks a rejected `include_dot_dirs`, a `mast.config.json`
  that is not JSON, and a project root that is not a directory. `runCli` in
  `src/cli/program.ts`, which `cli/index.ts` runs, prints `mast: <message>` on stderr and
  exits 1 for those and for nothing else. An error of any other type keeps its stack
  trace: it is a bug in mast, and the trace is the report. A catch-all with a debug
  switch was the alternative; it would have hidden the trace for every unexpected
  failure to tidy up three expected ones. **Measured** with the built CLI and
  `[".agents/*"]`: `status`, `index`, `prime` and `metrics` each printed one line, exit 1.
- **`mast index` and `mast init` refuse a project path that is not a directory (D075).**
  Both check before writing anything. **Measured**: each printed
  `mast: project root <path> is not a directory`, exit 1, and the path did not exist
  afterwards. `status`, `prime` and `search` already reported "no index" for such a path
  and are unchanged.
- **The walker excludes the state directory by its resolved path (D076).** It used to
  stay out only through the default pattern `.mast/**`. With `state_dir: "mast-state"`,
  `mast-state/n2.md` is no longer walked, which is what the watcher already assumed.
  A project that had indexed files inside such a directory loses them at the next index
  run.
- **`mast serve` with a rejected entry prints the same one line.** **Measured**: started
  in a project with `[".agents/*"]`, it printed `mast: …include_dot_dirs…` and exited 1.
  It still does not start; the entry has to be fixed.
- **`mast metrics` where there is no index says so (D077).** It printed a better-sqlite3
  stack trace when the state directory was missing, and created an empty `graph.db` when
  the state directory existed without one. It now checks for the database first, as
  `mast query` does. `mast metrics --locks` reads a different file and is unchanged.
- **A state directory that is the project root, or contains it, no longer turns watch
  mode off (D078).** The watcher ignored every path "inside the state directory", which
  in that layout is every source file. `stateDirBelowRoot` in `scope.ts` now gives the
  walker and the watcher one rule: the state directory is excluded only when it is below
  the root. Otherwise nothing is excluded; its own files carry no indexed extension
  unless `file_extensions` is widened to one of them (`.json`), which was not tested.
- **A directory the walk may not read stops it with a message, not a stack trace.** The
  walk still stops: skipping the directory would produce an index that reports itself
  complete. The message names the directory and the pattern that excludes it.
  **Measured** with a mode-000 named dot directory: `mast index` printed one line, exit
  1, and with the suggested `exclude_patterns` entry the walk completed. An unreadable
  **file** is a separate, existing path (a parse warning) and is unchanged.
