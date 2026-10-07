# Spike results in one place — incremental graph correctness

Look here first when a question about the graph, barrels, edge loss or incremental cost comes
up. It gives the number, the corpus it came from, and where the script and raw output are.

- **Exploratory.** None of this is a registered experiment under ADR 010. A figure here may
  guide a decision; it may not be quoted as a settled finding. Settled findings are in
  `FINDINGS.md`.
- **Derived.** Each section is copied from that spike's own `RESULTS.md`. If the two disagree,
  the spike's `RESULTS.md` and its raw output win.
- **Adding to it.** A new spike gets a directory (script, raw output, `RESULTS.md`), a row in
  the lookup table, a section below, and a row under "Decisions" if one was taken on it.

Corpora, unless a section says otherwise: **n8n** is a scratch clone of the user's checkout at
`9d9e9bf97e`, default config (test and spec files excluded), 13,985 indexed files. **mast** is
this repository (162 to 193 files, depending on the day). One machine, macOS, often under
other load; where load matters the section says so.

## Lookup: question, answer, spike

| Question | Answer | Spike |
|---|---|---|
| Does an incremental run lose edges into a re-written file? | Yes. n8n, one file: 289 call edges to 0, `stale_files: 0` | S0-R |
| What does an incremental run cost? | Nothing to do: 0.5 to 1.0 s. A typescript file: 20 to 47 ms parse plus write | S0-T |
| How many edges does a full index miss from walk order? | n8n 1,939 of 55,620 (3.5%); mast 0 | S1 |
| How many passes do chained named re-exports need? | 3 on n8n (`RE_EXPORTS` count 3,726, 4,135, 4,168, 4,168) | S1 |
| How far does a replay of real commits drift from a full index? | n8n 2,541 of 53,681 after 200 commits; mast 54 of 669 after 100 (before the fixes) | S2 |
| How many files does a real commit write? | n8n median 2, p90 15, max 93; mast 2, 9, 39 | S2 |
| How often does a modification leave names and re-exports alone? | n8n 71.7%, mast 74.4% | S4 |
| How many files hold an edge into one file? | n8n p99 7, max 1,115; mast max 11 | S3 |
| How far does the same replay drift after the fixes? | Not at all: n8n 0 of 108,281 lines differ after 200 commits; mast 0 of 1,222 after 100 | T12, `eval-suite/replay-check.mjs` |
| How many files import one file's names through barrels? | n8n p99 37, max 5,011; following barrels by file instead: p99 1,881 | S3 |
| What does resolving one file again cost? | 3 to 4 ms by re-parse, 0.3 to 0.8 ms from records | S5 |
| Is the whole-graph name guess for `implements` / `extends` ever right? | n8n: wrong 27 of 27; unique-name guess wrong 21 of 21 | S6 |
| How many import rows use a package's own path alias (D087)? | n8n 4,834 of 51,617 (9.4%), all stored unresolved | S6 |
| How often would a cap on re-resolution be hit? | Near 2 s: about 9 of 143 n8n runs, 0 of 40 mast (an estimate) | S7 |
| Does the importer repair give a full index's graph on n8n? | 0 of 108,288 rows differ after six hand-picked edits | S8 |
| What does a hub file cost to repair? | n8n package barrel: 565 files, 3.3 to 3.6 s; `interfaces.ts`: 1,193 files, 4.5 s | S8 |
| What does a query-time refresh of a hub file cost? | 376 to 712 ms with a 250 ms budget; a leaf file 7 ms | S8 |
| How many call edges came from the name-only guess? | n8n 7 of 30,740, all right; mast 0 of 616 | S9 |
| Do the tests fail when a repair line is removed? | 33 of 35 hand-written mutants fail the gate (25 before eight rows were added) | S10 |
| What does the empty FTS block save for markdown? | `fts_del` 1,021 to 2,215 ms down to 0 to 1 ms per file (n8n, under load) | S11 |
| How often is a name star-ambiguous (D094)? | n8n: 0 real cases, 0 of 51,617 import rows; mast 0 | S12 |
| How common is `export * as ns from`? | n8n: 137 lines in 57 files, against 820 `export * from` lines | S12 |

## Decisions taken on these numbers

| Date | Decision | Numbers it rests on |
|---|---|---|
| 2026-10-06 | Pass 2 in three stages with a fixed point (M1); star rows first alone is not enough | S1: 1,117 of 1,939 still missing with star rows first; 0 with the fixed point |
| 2026-10-06 | Repair by resolving holders and importers again, not by keeping ids (M3a, M3b; M2 rejected) | S3, S4, S5 |
| 2026-10-06 | Never follow barrels by file | S3: 334 n8n files would pull in more than 1,000 others |
| 2026-10-06 | No `implements` / `extends` edge without file evidence (decision 1, option B), with the D086 fix | S6 |
| 2026-10-06 | Stored edge records (M4) held | S5: 5 to 10 times cheaper per file, but a table and a write path |
| 2026-10-06 | The cap is elapsed time: 2 s background, 250 ms at query time, none for `mast index --incremental` (decision 2) | S7, S8 |
| 2026-10-07 | No call edge from the name-only guess (D092) | S9: 7 edges on n8n |
| 2026-10-07 | Recording `const { X } = await import('m')` as an import: held | S9: it would return those 7 edges |
| 2026-10-07 | Eight scenario rows added for repair lines no gate test pinned | S10 |
| 2026-10-07 | The `kind` part of the export surface (mutant I04) left as is | S10: nine probes could not observe it |
| 2026-10-07 | Empty FTS block recorded for a file with no rows (M6, D082) | S11 |
| 2026-10-07 | D094 stays at "lowest path"; "no edge for a star-ambiguous name" not built. Reopen if a corpus shows an import row naming such a name | S12 |
| 2026-10-07 | D087 (per-package path aliases) and aliased imports deferred by the user | S6 |

The mechanism-by-mechanism record is the promotion log in `../PROPOSAL.md`.

## S0-R — do the reported edge losses reproduce? (`s0-reproductions/`, 2026-10-06)

Scratch projects of two to eight files, and the n8n copy. Every incremental run printed
`stale_files: 0`.

| Edit | After incremental | After full index | Defect |
|---|---|---|---|
| `x.ts` gains a name `zc.ts` already imports and calls | no edge | edge | D084 |
| `x.ts` created after `zc.ts`, which imports from it | no edge | edge | D084 |
| `barrel.ts` `export *` re-pointed from `x` to `y` | edge still to `x.ts` | edge to `y.ts` | D084 |
| `x.ts` changes from re-exporting `fn` to declaring it | edge to `impl.ts` | edge to `x.ts` | D084 |
| `type Opts` becomes `interface Opts` | `IMPLEMENTS` gone | present | D081 |
| body of `fn` edited in a file a barrel stars | star row gone | present | D081 |
| `fn` renamed in `x.ts` | no edge | no edge | none |

n8n: `packages/frontend/@n8n/rest-api-client/src/utils.ts` had 289 `POTENTIAL_CALL` edges
into it from other files. After one appended line and an incremental run (`1 indexed, 13984
skipped`, 505 ms): 0. Total `edges` rows 52,506 to 52,217.

Query-time path, two files: `mast_exports` on the edited file took edges from 1 to 0, and the
next incremental run left them at 0 (D080).

## S0-T — cost of an incremental run (`s0-timings/`, 2026-10-06)

n8n, `mast index --incremental --phase-timing`, a fresh process per run, load average 13 to 18.

| Changed files | Run duration, ms (three runs) |
|---|---|
| 0 | 1,035 / 623 / 498 |
| 1 typescript | 748 / 951 / 431 |
| 20 typescript, block recorded | 1,572 / 1,460 / 1,379 |
| 100 typescript, block recorded | 2,851 / 4,237 / 3,235 |
| 1 markdown | 2,024 / 3,032 / 2,420 (`fts_del` 1,276 / 2,192 / 1,548) |

At load average 5, one markdown file, five runs: 724, 355, 368, 489, 367 ms; `fts_del` 382,
26, 29, 133, 43 ms. A reviewer's quiet-machine figures (not re-run): a no-change run 330 to
375 ms; 20 markdown files `fts_del` 741, 539, 1,050 ms.

n8n index: 637 files with a NULL `chunk_fts_lo`, 1,161 with a NULL `ident_fts_lo` (524 of 525
markdown files); `chunk_fts` 73,738 rows, `identifier_fts` 70,254. A full scan by `file_path`
from the `sqlite3` CLI: `chunk_fts` 2.07 s cold, 0.16 s warm; `identifier_fts` 0.61 s, 0.07 s.

## S1 — edges a full index misses from walk order (`s1-walk-order/`, 2026-10-06)

| | n8n | mast |
|---|---|---|
| Star re-export rows | 1,062 | 2 |
| Edges after a full index | 53,681 | 669 |
| Edges with walk order removed | 55,620 | 669 |
| Missing | 1,939 | 0 |
| Same call, different target | 0 | 0 |

n8n missing by kind: `POTENTIAL_CALL`/`import` 1,263 of 8,844 (14.3%); `RE_EXPORTS` 464;
`parameter_type` 95; `field_type` 78; `new_expression` 38; `super_method` 1. They point at 765
declarations from 701 caller files; 429 point into `packages/workflow/src/utils.ts`.

| Pass 2 ordering (n8n) | Edges | Short |
|---|---|---|
| As shipped then | 53,681 | 1,939 |
| Star rows first | 54,503 | 1,117 |
| Star rows, `RE_EXPORTS` once, the rest | 55,152 | 468 |
| Star rows, `RE_EXPORTS` to a fixed point, the rest | 55,620 | 0 |

Seen once, not repeated: `mast index` over the existing n8n index 166 s, `mast init` on an
empty one 61 s (load average 5 to 6).

## S2 and S4 — replaying real commits (`s2-commit-replay/`, 2026-10-06)

Run before any fix. I is the graph after the replay, F a full index of the final tree, R the
walk-order-free graph of S1.

| | n8n, 200 commits | mast, 100 commits |
|---|---|---|
| Commits that changed a file the graph covers | 143 | 40 |
| Distinct such files | 840 | 68 |
| Files written per run: median, p90, max | 2, 15, 93 | 2, 9, 39 |
| Edges I / F / R | 51,579 / 53,681 / 55,620 | 615 / 669 / 669 |
| In F, missing from I | 2,541 (4.7%) | 54 (8.1%) |
| In R, missing from I | 4,098 | 54 |
| In I and R, not in F | 382 | 0 |
| In I, not in R | 57 | 0 |
| Star rows missing from I | 36 of 1,062 | 2 of 2 |
| Runs that lowered the edge count | 56 | 14 |

n8n missing against F by kind: `IMPLEMENTS` 1,110; `import` calls 573; `RE_EXPORTS` 297;
`field_type` 295; `EXTENDS` 140; `parameter_type` 53; `PARENT_OF` 51; `new_expression` 20;
`super_method` 2. 1,112 point into `packages/workflow/src/interfaces.ts`. By the write-order
rule, 2,415 of 2,541 (n8n) and 48 of 54 (mast) are D081.

Structural edges by bare name (D085), n8n full index: 239 of 17,650 `PARENT_OF` edges join a
class to a member of a same-named class in another file; 435 of 3,154 `EXTENDS`/`IMPLEMENTS`
edges target a name more than one file declares.

One live session on this repository (2026-10-06): 17 of 669 edges missing, `stale_files: 0`.

S4, what a change does to a file:

| | n8n | mast |
|---|---|---|
| File changes the graph covers | 1,103 | 152 |
| Added / deleted / modified | 114 / 21 / 968 | 26 / 1 / 125 |
| Modified, names and re-exports both unchanged | 694 (71.7%) | 93 (74.4%) |
| Modified, declared names changed | 228 (23.6%) | 31 (24.8%) |
| Modified, exported names changed | 143 (14.8%) | 19 (15.2%) |
| Modified, re-exports changed | 46 (4.8%) | 1 (0.8%) |
| All changes that alter what other files resolve to | 409 (37%) | 59 (39%) |

## S3 — how many files depend on one file (`s3-importers/`, 2026-10-06)

Counts of other files per file. n8n, 13,460 code files:

| | at 0 | median | p90 | p99 | p99.9 | max | over 100 | over 1,000 |
|---|---|---|---|---|---|---|---|---|
| import it by path (`direct`) | 5,305 | 1 | 3 | 20 | 272 | 4,994 | 26 | 2 |
| through barrels, by file (`via_file`) | 3,881 | 1 | 67 | 1,881 | 5,552 | 5,591 | 1,057 | 334 |
| through barrels, by name (`via_name`) | 3,881 | 1 | 6 | 37 | 434 | 5,011 | 51 | 5 |
| hold a stored edge into it (`edge`) | 10,214 | 0 | 1 | 7 | 53 | 1,115 | 5 | 1 |

2,597 n8n files are re-exported by at least one barrel. Over 1,000 by name:
`packages/workflow/src/index.ts` 5,011; `packages/workflow/src/interfaces.ts` 4,555;
`packages/@n8n/typeorm/src/index.ts` 1,305; `Entity.ts` 1,217; `Column.ts` 1,181.

mast, 83 code files: `direct` max 28, `via_name` max 29, `edge` max 11 (`src/ast/types.ts`).

## S5 — cost of resolving one file again (`s5-reresolve-cost/`, 2026-10-06)

n8n, two runs, load average 4 to 6, one transaction, warm cache.

| Sample | Re-parse, delete, resolve | From records |
|---|---|---|
| 1,115 holders of an edge into `interfaces.ts` | 3,332 / 3,383 ms | 359 / 364 ms |
| 1,000 files with an outgoing edge | 3,835 / 3,802 ms | 754 / 671 ms |

Per file: `parse` median 1.27 to 1.76 ms, p99 18.5 to 21.2 ms; `resolve` median 0.15 to
0.38 ms, p99 1.5 to 4.2 ms. Records per file: median 4 to 6, max 405. mast, 67 files: 260 ms
by re-parse, 37 ms from records.

## S6 — `implements` / `extends` without file evidence (`s6-structural-fallback/`, 2026-10-06)

n8n: 3,424 records, 3,154 edges at the time.

| Evidence for the target name | Records |
|---|---|
| Named import, found in the imported file | 2,532 (192 edges pointed at another file) |
| Declared in the same file | 334 (80 pointed at another file) |
| Named import, name not found through the imported file | 276 |
| Named import, specifier did not resolve | 130 |
| None | 152 |

The 152 with none: TypeScript lib global 118; aliased import 29; default import 3; declared
but not a recorded symbol 2. Whole-graph guess: 27 edges, 0 right. Unique-name guess: 21
edges, 0 right.

`mast_implementors` over 4,360 interface names: 1,758 answers then; 1,747 with evidence and
no guess; 1,784 with the star-then-named gap (D086) also closed.

Found here: **D086** (a star chain did not follow a named re-export; 182 of the 276 found
once followed) and **D087** (path aliases read from the root `tsconfig.json` only; 4,834 of
51,617 n8n import rows in 1,361 files stored as unresolved and external).

Import call records on n8n (one per file and name): 10,971; found 6,891; package or
unresolved specifier 3,652; not found 428, of which 344 unexplained.

mast: 13 records, 8 edges, the same under every option.

## S7 — how often a cap would be hit (`s7-cap-sizing/`, 2026-10-06, an estimate)

Summed from S2's steps and S3's per-file counts; no index was opened.

| Files to resolve again per run | n8n, 143 runs | mast, 40 runs |
|---|---|---|
| p50 / p75 / p90 / p95 / max | 6 / 43 / 103 / 913 / 10,720 | 8 / 25 / 42 / 46 / 56 |
| Runs over 100 / 250 / 500 / 1,000 / 2,500 | 15 / 10 / 9 / 4 / 2 | 0 |

The two largest n8n runs both changed the re-exports of `packages/workflow/src/index.ts`.

## S8 — the importer repair on n8n (`s8-importer-repair-validation/`, 2026-10-07)

Six hand-picked edits in `packages/workflow`, an incremental run after each, then a full index
of the same tree: 108,288 dump lines each (edges, star rows, import rows), `diff` 0 lines.
Edge counts by type on the full index: 55,610 in total; `POTENTIAL_CALL` 30,740; `PARENT_OF`
17,650; `RE_EXPORTS` 4,172; `IMPLEMENTS` 1,797; `EXTENDS` 1,251.

| Edit, no budget | Files resolved again | Pass 2, ms | Run, ms |
|---|---|---|---|
| comment appended to the package barrel `index.ts` | 565 | 3,609 / 3,289 | 4,129 / 3,646 |
| comment appended to `interfaces.ts` | 1,193 | 4,483 | 5,112 |
| function appended to `utils.ts` | 333 | 3,007 | 3,548 |
| `cron.ts` renamed | 6 | 283 | 857 |

With a 2,000 ms budget on the barrel: 229 resolved, 336 left pending and reported by
`mast status`; the next run resolved 336 and left 0. A full index: 60,327 ms.

Query-time refresh, 250 ms budget, two passes:

| File | Refresh, ms | Left waiting | Resolved by the next run |
|---|---|---|---|
| a file nothing holds an edge into | 7, 7 | 0 | 0 |
| package barrel `index.ts` | 376, 513 | 512 | 565 |
| `utils.ts` | 712, 457 | 284 | 333 |
| `interfaces.ts` | 527, 569 | 1,078 | 1,193 |

## S9 — call edges from the name-only guess (`s9-call-fallback/`, 2026-10-07)

| | n8n | mast |
|---|---|---|
| Stored `POTENTIAL_CALL` edges | 30,740 | 616 |
| Distinct records that can reach the guess | 15,016 | 228 |
| Records where the guess ran | 3,312 | 83 |
| Of those, an edge was stored | 7 | 0 |

Where the guess found nothing on n8n: lib global 3,062; default import 93; unknown 62; aliased
import 40; type parameter 24; namespace import 17; declared but not a symbol 7. The 7 edges,
read by hand, are all right, and all come from `const { X } = await import('pkg')` in 3 files.

## S10 — do the tests notice a removed repair line? (`s10-mutation/`, 2026-10-07)

35 hand-written mutants in `edge-repair.ts` and `importer-repair.ts`. Not a mutation score.

| Verdict | At `2a42293` | After eight scenario rows |
|---|---|---|
| Failed the test named for it | 18 | 26 |
| Failed other tests in the ten files | 7 | 7 |
| Failed only on generated seeds 100 to 250 | 7 | 0 |
| Passed everything | 3 | 2 (I04, I14) |
| So `pnpm gate` fails for | 25 | 33 |

Of the 32 mutants that had a named row and failed somewhere, the named row kept passing for
14. Seeds 115, 148 and 218 between them failed all seven seed-only mutants. With interfaces,
`implements` and damaged files added to the generator, seeds 1 to 900 pass and no new defect
was found.

## S11 — the empty FTS block (`s11-fts-empty-block/`, 2026-10-07)

n8n, 525 markdown files, 69,876 `identifier_fts` rows, load average 34 falling to 24. Read
the ratio, not the milliseconds.

| | `fts_del`, NULL block | `fts_del`, empty block |
|---|---|---|
| 20 markdown files, 3 sets | 7,038 / 3,895 / 3,978 ms | 7 to 519 ms over 9 runs, median 17 ms |
| 1 markdown file, 5 files | 2,215 / 1,275 / 1,305 / 1,021 / 1,639 ms | 0 or 1 ms over 10 runs |

Run duration for one markdown file: 2,854 to 3,883 ms before, 822 to 1,344 ms after. An old
index heals one file at a time: 65 of 525 held the empty block at the end, 460 still NULL.

## S12 — star-ambiguous names, and namespace stars (`s12-two-star-names/`, 2026-10-07)

| | n8n | mast |
|---|---|---|
| Files with a star re-export row | 202 | 1 |
| Of those, with a name declared in two files behind their stars | 10 | 0 |
| Such names, matched by spelling | 18 | 0 |
| Of those, behind two `export * from` lines (a real D094 case) | 0 | 0 |
| Import rows | 51,617 | 439 |
| Import rows that resolve to such a barrel and list such a name | 0 | 0 |

All 18 n8n names are behind `export * as ns from` lines, which mast stores as plain stars
(D096, open). Four-file reproduction: a caller's edge goes to the file behind the namespace
star when TypeScript resolves it to the file behind the plain star. n8n has 137 `export * as`
lines in 57 files and 820 `export * from` lines (text search of tracked non-test source).

## T12 — the replay as a standing check (`eval-suite/replay-check.mjs`, 2026-10-07)

Not a spike: an instrument, in `eval/` when these runs were made and moved to `eval-suite/` the
same day. These two results are in `eval/results/replay-check-<name>.json`; later runs write
elsewhere (see `EVAL.md`). Built
CLI from `80168c4`. A line is an edge, a star row or an import row.

| | n8n | mast |
|---|---|---|
| Commits replayed | 200 (`f8941b10f2` to `9d9e9bf97e`, the range S2 used) | 100 (`5ba5150` to `80168c4`) |
| Runs that wrote a file | 144 | 97 |
| Files written: total, most in one run | 1,119, 93 | 510, 39 |
| Lines after the replay / in a full index | 108,281 / 108,281 | 1,222 / 1,222 |
| Missing, extra | 0, 0 | 0, 0 |
| Stale files, pending repairs after the replay | 0, 0 | 0, 0 |

Positive control: with one repair line removed (S10's mutant E01) a 40-commit replay of this
repository fails with 79 missing lines.

Imported names on the final tree (a resolver gap shows here as a number that moves):

| | n8n | mast |
|---|---|---|
| Import call records, one per file and name | 10,971 | 407 |
| — edge stored | 6,977 | 270 |
| — package or unresolved specifier | 3,652 | 136 |
| — import resolved to a file, no edge | 342 | 1 |
| `implements` / `extends` records | 3,424 | 21 |
| — edge stored | 3,048 | 12 |
| — package or unresolved specifier | 130 | 3 |
| — import resolved to a file, no edge | 94 | 0 |
| — no import row lists the name | 152 | 6 |

S6 counted 428 unfound call records on n8n before the D086 fix. mast's one is `sql`, which
`db.ts` re-exports from a package. Equal graphs do not show that either graph is right.

## Not measured anywhere above

- A third corpus. mast has one or two star barrels and hid D083 completely.
- A quiet-machine figure for S11, and for a full n8n index after the fixes.
- Per-save behaviour; a commit is coarser than a save.
- The watcher path inside `mast serve`, beyond its wiring test.
- Test and spec files: outside every index here.
- For D096: `ns.fn()` through a namespace star, and what `mast_exports` and
  `mast_rename_impact` list for such a barrel.
