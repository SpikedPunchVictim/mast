# S2 and S4 — replaying real commits through incremental runs (2026-10-06, exploratory)

**S2.** After replaying the last N commits one at a time through `mast index --incremental`,
how far is the graph from a full index of the final tree, and why?
**S4.** What does a real change do to a file: body only, or names and re-exports too?

**Script.** `s2-replay.mjs <dist> <scratch-clone> <N> <out-dir>`. It checks out the commit N
back on the first-parent line, runs `mast init`, then for each later commit: checks it out,
runs `mast index --incremental`, and records what changed. At the end it dumps three graphs by
name (`type | resolution | caller file | caller symbol | callee name | target file`):

- **I** — the stored graph after the replay;
- **F** — a fresh full index of the final tree;
- **R** — the ordered graph of S1 for the final tree (walk order removed).

Raw output per corpus: `summary.json`, `steps.json` (one row per commit, with each changed file
and its class), `missing-vs-full-index.txt`, `missing-vs-ordered.txt`, `not-in-ordered.txt`.

| | n8n (`n8n-200/`) | mast (`mast-100/`) |
|---|---|---|
| Commits replayed | 200 (`f8941b10f2` to `9d9e9bf97e`, about four working days) | 100 (`b5cf281` to `d062339`) |
| Commits that changed a file the graph covers | 143 | 40 |
| Distinct such files changed | 840 | 68 |
| Files written per run: median, p90, max | 2, 15, 93 | 2, 9, 39 |

## S2 — the graph after the replay

| | n8n | mast |
|---|---|---|
| Edges: I / F / R | 51,579 / 53,681 / 55,620 | 615 / 669 / 669 |
| In F, missing from I | **2,541** (4.7% of F) | **54** (8.1% of F) |
| In R, missing from I | 4,098 (7.4% of R) | 54 |
| In I and R, not in F | 382 | 0 |
| In I, not in R | 57 | 0 |
| Star re-export rows missing from I | 36 of 1,062 | 2 of 2 |
| Runs after which the edge count was lower than before | 56 | 14 |
| `mast status` after the replay | `stale_files: 0`, `index_fresh: true` | the same |

Missing from I against F, by kind — n8n: `IMPLEMENTS` 1,110, `POTENTIAL_CALL`/`import` 573,
`RE_EXPORTS` 297, `field_type` calls 295, `EXTENDS` 140, `parameter_type` 53, `PARENT_OF` 51,
`new_expression` 20, `super_method` 2. mast: `import` calls 49, `RE_EXPORTS` 3, `IMPLEMENTS` 1,
`EXTENDS` 1.

1,112 of the 2,541 point into one file, `packages/workflow/src/interfaces.ts`, which the replay
re-wrote.

### Why each edge is missing

A rule applied to each missing edge, from the step at which the replay last wrote the caller's
file and the target's file. It is an approximation, not a trace.

| Rule | n8n | mast |
|---|---|---|
| Target file written after the caller's; target name was declared there at the start. The edge existed and the re-write deleted it (D081). | 2,415 | 48 |
| Target file written after the caller's; target name not declared there at the start. Deleted the same way, or never created (D081 or D084). | 63 | 6 |
| Caller's file written at or after the target's. | 63 | 0 |
| Also missing from F (walk order, D083) — counted only against R | 1,557 | 0 |

The 63 in the third row were not traced one by one. 32 are `PARENT_OF` edges (see D085 below); the rest are re-export edges and calls into files
reached through barrels.

### Two other things the replay showed

**Touching a file repairs D083 for that file.** 382 edges are in I and in R but not in F: the
replay re-wrote their caller, and by then the barrel rows existed.

**Structural edges resolve by bare name across the whole graph (new, filed as D085).** The 57
edges in I that R does not have are 37 `EXTENDS` and 20 `PARENT_OF`. 36 of the `EXTENDS` point at
`UnexpectedError` in `packages/workflow/src/errors/base/unexpected.error.ts`; F points the same
classes at a different declaration with the same name. `insertEdges` picks the first symbol
row with that name anywhere, and an incremental re-write changes which row is first. On the
fresh full index of n8n, 239 of 17,650 `PARENT_OF` edges join a class to a member of a
same-named class in another file, and 435 of 3,154 `EXTENDS`/`IMPLEMENTS` edges target a name
that more than one file declares. So even with D081, D083 and D084 fixed, "incremental equals
full" would not hold for these edges.

## One real session

This repository's own index (`.mast/`), kept up through the session of 2026-10-06 by the
running server and CLI runs while `src/indexer/index.ts`, `src/cli/prime-cmd.ts`,
`src/cli/status.ts` and others were edited, against a fresh full index of the same tree built
into a scratch state directory: **17 of 669 edges missing**, none extra, `stale_files: 0`,
`index_fresh: true`. Among the 17: four callers of `runIndex` and four of `loadIndexMeta`. Files in `live-session/`. Which of the session's writes deleted each edge was
not traced.

## S4 — what a change does to a file

Per changed file per commit, comparing mast's own extraction before and after.

| | n8n | mast |
|---|---|---|
| File changes the graph covers | 1,103 | 152 |
| Added | 114 | 26 |
| Deleted | 21 | 1 |
| Modified | 968 | 125 |

Of the modified:

| | n8n | mast |
|---|---|---|
| Declared names and re-exports both unchanged | 694 (71.7%) | 93 (74.4%) |
| — of which nothing the extractor reports changed (`body_only`) | 318 | 36 |
| Declared names changed | 228 (23.6%) | 31 (24.8%) |
| — exported names changed | 143 (14.8%) | 19 (15.2%) |
| Re-exports changed | 46 (4.8%) | 1 (0.8%) |
| Same names, different order or kind | 8 | 4 |

Counting additions and deletions as name changes, 409 of 1,103 file changes on n8n (37%) and
59 of 152 on mast (39%) alter what other files' edges can resolve to.

## What this shows

- D081 is the bulk of the damage in practice: by the first row of the rule, 2,415 of 2,541
  (95%) of the edges the replay lost against a full index on n8n, and 48 of 54 (89%) on mast.
- The loss is not rare or slow: it showed in 56 of 143 n8n runs that touched the graph, and in
  one working session on this repository.
- A fix that only keeps edges across a body edit covers about 72 to 74% of modifications. The
  rest change names or re-exports and need other files resolved again.
- D083 and D085 make a full index a moving target; both must be settled before "equal to a
  full index" can be tested.

## Limits

- A commit is coarser than a save. A session saves many times per commit, so the share of
  body-only writes per save is probably higher than per commit. Not measured.
- CLI only, apart from the one live session. No query-time re-parses in the replay.
- Squash-merged commits (n8n) bundle many files; run sizes are larger than an editor's.
- The cause rule looks only at file write order; it cannot tell D081 from D084 for the 63 + 6.
- Timings were taken with other runs going and are not reported as findings (n8n: median
  402 ms per run, p90 990 ms, max 2,215 ms).
- Default config: test and spec files are outside both graphs.
