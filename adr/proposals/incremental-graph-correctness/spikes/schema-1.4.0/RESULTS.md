# Schema 1.4.0 — measurements (2026-10-08)

Build: `00319c0` plus `imports.aliases` and the version change. n8n copy at `9d9e9bf9`.

## Why a bump

Nothing became unreadable. What changed is what is written for a file that has not changed:
`reexport_aliases` rows that repair relies on (D112), the star rows of `export * as ns`
(D096), and the edges of the fixes before them. A file is re-written only when it changes, so
an index of 1.3.0 keeps its old rows for every other file. The guard that makes a bump take
effect on the command line is D113, fixed in the commit before this one.

## Measured

| | Before (D096 build) | After |
|---|---|---|
| n8n, distinct edges of every type | 71,091 | 71,091 (0 gone, 0 new) |
| n8n, import rows | not counted | 51,963, of which 560 in 448 files hold an alias |
| scorecards, three corpora | | PASS, `scorecard-*.compare.txt` |
| replay against a full index | | `replay-check-{mast,n8n}.json` |

`alias-check.mjs` asks `resolveTypeContext` for the local name of every aliased specifier in
an index. On n8n (`alias-check-n8n.json`): 655 specifiers, 279 of a package or an unresolved
module, 205 answered from the file the import resolves to, 112 from another file, 59 with
nothing. Before this change the 205 could only be answered by the project-wide fallback, by
the local name (from reading the code; the 1.3.0 build was not run through this script). The 112 are D114 (the lookup does not follow a re-export), reproduced by
`d114-repro.sh`, output in `d114-repro.out.txt`.

## Not measured

- How long the rebuild takes for a user on upgrade, beyond the full-index time already known
  for n8n (85 to 107 s on this machine, under load).
- An old-version `mast serve` left running on a state directory the new version has rebuilt
  (noted under D113).

## D114 fixed (2026-10-08)

Same index, the build with the lookup following re-exports (`alias-check-n8n.fixed.json`): of
the 376, 213 from the file the import resolves to, 62 from a file behind it, 101 nothing.
Before: 205, 112, 59. The script cannot say whether an answer from another file is
right; before the fix such an answer came from a lookup by name, and now it comes from the
re-export walk. The 62 were not read one by one. `d114-repro.fixed.out.txt`: both forms give
`src/types.ts`.
