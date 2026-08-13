# DISCARDED — E1-AB runs collected under the retired seeded shuffle

**Nothing in this directory enters any score.** It is retained as evidence, not as data.

Registration: `IMPLEMENTATION_PLAN.md` § E1-AB PRE-REGISTRATION, AMENDMENT 3
(2026-08-13, mid-run, data-informed).

## Why these runs were discarded

AMENDMENT 1 A9 gave T9 a Latin square and left T1 and T5 on a seeded shuffle. The
shuffle happened to give **arm C position 2 in all three blocks** and arm B position
3 or 4 in all three. Arm C is A1's source-contradiction tripwire, so zero positional
variance would have made a positional effect and the arm-C effect perfectly
collinear — a non-inert `rho_C` would have been unreadable.

AMENDMENT 3 extends the Latin square to T1 and T5. A design change made *after*
seeing data is only legitimate if the data collected under the old design is thrown
away, so these seven runs are.

## What is here

| file | what it is |
|---|---|
| `e1-ab-runs.jsonl` | the 7 completed runs (all block 1, T1 and T5), all Gate A clean |
| `e1-ab-schedule.json` | the retired schedule pin, including the dead `seed: 4409` |
| `T9-lock-race-lock-metrics.jsonl` | lock journal from the run that killed the schedule |
| `T9-lock-race-index.json` | that run's `index.json` — see the warning below |

## The T9 lock race

The schedule died at `A/T9/b1` with `No index.json`. The lock journal above records,
5 s into the run:

```json
{"kind":"failed","type":"structure","caller":"index-run","waitMs":5009}
```

`waitMs 5009` matches `src/indexer/index.ts:241` exactly (`maxRetries: 5`,
`retryIntervalMs: 1_000`), and `src/store/lock.ts:107` records `failed` and then
**throws**. An acquisition can only fail if something else holds the lock, so there
were two concurrent `index-run` lock holders in one state dir. The second holder was
never identified and the search was closed by decision; a re-run of the same cell
completed normally in 540,136 ms with a 439,140,352-byte `graph.db`, byte-identical
in size to the known-good `phase-run-T9-r3`, so the fault is a transient race and not
a T9 defect.

**`T9-lock-race-index.json` reports 73,359 chunks and is not evidence the index
landed.** That count is the pre-write counter — the trap already documented at
`eval/e1-common.mjs:489` ("`chunksAdded` is incremented pre-write, so stdout can
report chunks that a failed write never persisted"). The database it describes was
4,096 bytes with a 292,552-byte WAL. Zero pages landed after the first second.

Follow-up, not done here: record the holding **pid** in the lock metrics, which would
identify a competing holder in one line. Note when doing so that `runColdIndex` wipes
the state dir with `rmSync` before every run, so a stale lock inherited from a
previous run in that same dir is not a candidate explanation.
