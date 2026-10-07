# S0-T — cost of an incremental run (2026-10-06, exploratory)

n8n copy, 13,985 files. `mast index --incremental --phase-timing`, a fresh CLI process per run.
"dur" is the `duration:` the CLI prints; "wall" includes Node startup. The machine was shared
with other work; the load average is given per block because it changed the numbers.

## Run 1 — `time-incr.sh`, load average 13.1 at start, 14.0 at end

Files picked pseudo-randomly from all typescript files, so some had no FTS block (see D082).

| changed | wall ms | dur ms | walk | parse | write | edges | finalise | fts_del |
|---|---|---|---|---|---|---|---|---|
| 0 | 1971 | 1035 | 450 | 0 | 0 | 0 | 455 | 0 |
| 0 | 1365 | 623 | 429 | 0 | 0 | 0 | 92 | 0 |
| 0 | 1136 | 498 | 348 | 0 | 0 | 0 | 83 | 0 |
| 1 | 1556 | 748 | 396 | 142 | 108 | 16 | 57 | 32 |
| 1 | 1600 | 951 | 503 | 89 | 14 | 7 | 325 | 2 |
| 1 | 981 | 431 | 268 | 63 | 21 | 1 | 70 | 1 |
| 5 | 6449 | 5545 | 505 | 119 | 4348 | 50 | 501 | 4277 |
| 5 | 1542 | 800 | 370 | 115 | 186 | 24 | 86 | 29 |
| 5 | 1722 | 716 | 369 | 100 | 64 | 5 | 162 | 9 |
| 20 | 6071 | 5368 | 373 | 283 | 4030 | 95 | 513 | 3419 |
| 20 | 8028 | 6941 | 483 | 325 | 5758 | 48 | 284 | 5037 |
| 20 | 5653 | 4681 | 517 | 193 | 3659 | 20 | 268 | 3301 |
| 100 | 5046 | 4362 | 415 | 428 | 3200 | 107 | 200 | 2126 |
| 100 | 6784 | 5886 | 469 | 597 | 4455 | 74 | 200 | 3040 |
| 100 | 6384 | 5434 | 399 | 1016 | 3660 | 148 | 201 | 2696 |

The `fts_del` figures of 2 to 5 seconds are what led to D082.

## Run 2 — `time-kind.sh`, load average 14.2 at start, 18.5 at end

| kind of changed file | n | dur ms | parse | write | edges | fts_del |
|---|---|---|---|---|---|---|
| typescript, block recorded | 1 | 559 / 725 / 457 | 102 / 96 / 77 | 31 / 25 / 18 | 2 / 6 / 6 | 3 / 0 / 1 |
| markdown | 1 | 2024 / 3032 / 2420 | 3 / 1 / 4 | 1296 / 2234 / 1567 | 5 / 6 / 3 | 1276 / 2192 / 1548 |
| typescript, block recorded | 20 | 1572 / 1460 / 1379 | 223 / 284 / 176 | 708 / 361 / 213 | 50 / 21 / 61 | 61 / 26 / 27 |
| typescript, block recorded | 100 | 2851 / 4237 / 3235 | 477 / 875 / 807 | 1547 / 2177 / 1249 | 97 / 128 / 112 | 161 / 253 / 156 |

A typescript file with no chunks, given only a comment, was skipped as unchanged (`0 indexed`),
so that row measured nothing and is left out.

Parse plus write per file, from the 20- and 100-file rows: 47, 32, 19 ms and 20, 31, 21 ms.

## Run 3 — by hand, same session, load not recorded (between runs 2 and 4)

| kind | n | dur ms | write | fts_del |
|---|---|---|---|---|
| markdown | 5 | 5940 | 4558 | 4426 |
| markdown | 20 | 3251 / 3830 | 2461 / 3035 | 2245 / 2842 |
| typescript, had no chunks, gains one | 1 | 4264 | 3452 | 3422 |
| typescript, had no chunks, gains one | 5 | 2288 | 1738 | 1709 |
| typescript, had no chunks, gains one | 20 | 8856 | 8025 | 7799 |

## Run 4 — by hand, load average 5.0, after a reviewer could not reproduce the markdown figures

One changed markdown file, five runs: dur 724, 355, 368, 489, 367 ms; `fts_del` 382, 26, 29, 133, 43 ms.

Reviewer, on its own copy at load 3 to 4 (not re-run by the author): one markdown file, six runs,
`fts_del` 874.8, 26.7, 23.8, 27.9, 23.9, 29.1 ms; 20 markdown files 741.4, 538.5, 1050.4 ms; with
the identifier block set by hand to an empty block (`lo=1, hi=0`), 20 markdown files 5.2, 7.1,
8.1 ms and one file 0.7, 0.3, 0.4 ms; a no-change run 330 to 375 ms.

## Counts on the n8n index

- NULL `chunk_fts_lo`: 637 files when first counted, 611 at the recount (the probes in run 3
  gave 26 of them a chunk). None owns a chunk.
- NULL `ident_fts_lo`: 1161 when first counted, 1135 at the recount; 524 of 525 markdown files.
- `chunk_fts` rows: 73,738 then 74,127. `identifier_fts` rows: 70,254 at the first count.
- A full scan by `file_path` from the `sqlite3` CLI: `chunk_fts` 2.07 s then 0.16 s;
  `identifier_fts` 0.61 s then 0.07 s (first run cold, second warm).

## What these do and do not show

- A run with nothing to do costs about 0.5 to 1.0 s here (0.33 to 0.375 s on a quiet machine,
  reviewer's figure), mostly the walk and the finalise phase.
- An ordinary typescript file costs roughly 20 to 47 ms of parse plus write.
- The multi-second `fts_del` values are a cold or contended file cache; warm, the scan fallback
  costs roughly 25 to 45 ms per markdown or chunkless file.
- Not measured: the watcher path inside `mast serve`, a forced cold cache, any corpus other
  than n8n, and a full re-index over an existing index.
