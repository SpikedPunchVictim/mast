# HANDOFF — E1-AB COMPLETE, SCORED AND REVIEWED; the successor probe is next

**Rewritten 2026-08-13 at `e86999e`.** Read this first, then `HANDOFF_Q1.md`, then
`IMPLEMENTATION_PLAN.md`, then `MAST_SPEC.md`. This file covers only the E1 track;
`HANDOFF_Q1.md` §5 (instrument defects) and §6 (methodological rules) remain in force
unchanged and are **not** superseded by anything here.

---

## 1. Where the work stands

**E1 is complete and scored.** Verdict **SUPER-LINEAR REGRESSION**: adjusted `b = 1.7529`,
HC3 95% CI `[1.6599, 1.8458]`, against the pre-registered threshold of 1.35. HOLDS was
arithmetically reachable and was rejected. **M1's O(N) claim does not extend past ~5k files;
Stage 2 is reopened as a scale defect.**

**E1-PHASE is complete, scored, and its adversarial results review is folded in.** Outcome
**H1 — the exponent is in the WRITE phase.**

| condition | registered | measured | |
|---|---|---|---|
| `b_write` | ≥ 1.6 | **1.9685** [1.8800, 2.0569] | pass |
| `b_parse` | ≤ 1.25 | **1.0144** [0.9930, 1.0359] | pass |
| write's share of `durationMs` at T9 | ≥ 0.60 | **94.01%** | pass |

H2 (`b_edges = 1.4360`, non-monotone share), H3 and H4 are each refuted. 15/15 runs,
0 VOID, 0 interrupted, Gate P attribution 99.85–100%.

**E1-AB is complete, scored, and its adversarial results review is folded in.** Outcome
**CACHE_IMPLICATED / PARTIAL** with **EXPONENT_REDUCED**. The lever it needed
(`OpenDatabaseOptions` on `openDatabase`, threaded from two CLI flags) shipped at `2127ef7`.
**The immediate next action is the successor probe** — see §1a.

### 1a. E1-AB — complete, scored, reviewed. What it settled and what it did not.

**The question was:** is the SQLite page cache the mechanism behind write's super-linearity?
It was a **probe, not a remedy**, and that framing held: no pragma was shipped, E1's verdict is
untouched, and **H1 — write-localised, mechanism unidentified — still stands.**

**Outcome.** 30/30 runs, 0 voids, Gate A clean on every run, Gate P2 identical within every
rung. `MECHANISM = CACHE_IMPLICATED`, level `PARTIAL`; `EXPONENT = EXPONENT_REDUCED`.

| statistic | value |
|---|---|
| `rho_B` (write) at T1 / T5 / T9 | 0.9774 / 0.6871 / **0.5132** |
| `rho_D` (write) at T1 / T5 / T9 | **1.2123** / 1.0085 / **0.8486** |
| `rho_C` at T5 | **0.6921** — fired A1's source-contradiction tripwire |
| `b_write` A / B / D | 1.9331 / **1.7127** / 1.8243 |
| `b_hi` (T5→T9) A / B | 2.1197 / **1.8965** |
| duration-basis `b` A / B | 1.7625 / **1.5498** (E1's own `b` = 1.7529) |

**The two things that survived review, and are the result:**

1. **The write phase is coupled to cache size, with a monotone dose–response** — `rho_B` 0.98 →
   0.69 → 0.51 as the database goes 1.32× → 5.81× → 26.8× the default cache.
2. **That coupling does NOT explain the super-linearity.** With eviction physically impossible
   (arm B's cache is 2.45× the whole T9 database) the slope is still 1.7127, and 1.5498 on E1's
   own duration estimand — above the immutable 1.35 either way. Removing eviction removes about
   a fifth of the excess exponent.

**The three things a reader must not take from it:**

1. **This is not a residency result.** `rho_D(T9) = 0.8486` — a 2 MiB cache *beat* the default at
   T9 — makes the T9 response to cache size **non-monotone**, which no residency model produces
   and which A4's own arithmetic predicted against (`rho_D(T9) ≈ 1.03`). The registered reading
   is "cache-size-coupled pager mechanism, **channel unresolved**" between read-miss volume and
   spill/eviction policy. A8's spill caveat applies to arm B as well as D: at 1 GiB, mid-
   transaction spill is structurally impossible, so B moves two things at once.
2. **`EXPONENT_REDUCED` fired by 0.0204** on a 0.20 bar whose own docstring calls it
   "deliberately blunt … a bar that can only fire on an obvious effect" (σ ≈ 0.0085, so the
   *outcome* is ~2.4σ, not the bar's ~20σ). A3's corroborating curvature reading fires by 0.0232
   and **fails in block 2**. Claim 2 does not rest on either — `b_hi(B)` and the duration-basis
   cross-check carry it.
3. **`rho_D(T9)` carries no registered flag.** A4 demoted it to an unthresholded probe and the
   scorer keys `D_HELPS_ANOMALY` to T1 only (`eval/e1-ab-score.mjs:224`), so the verdict prints
   `findings: []` while the most model-breaking number in the run sits unflagged. Gap in the
   rule set, recorded, not retroactively repaired.

**The tripwire paid for itself — this is the finding to carry forward.** `rho_C(T5) = 0.6921` ≈
`rho_B(T5) = 0.6871`. A1's source reading was **correct but incomplete**: write cursors do get
`curPagerFlags = 0` (`sqlite3.c:77886`), but the next branch gives read cursors
`PAGER_GET_READONLY` (`:77889`), and FTS5's `fts5DataRead` reads segment blocks through
`sqlite3_blob_open(..., 0, &p->pReader)` (`:251470`) — a **read-only** blob handle, mmap-eligible
*inside a write transaction*. Arm C was never inert. Both arms are accelerating the same
traffic: **FTS5 segment merge reads, not B-tree insertion traversals.**

**The successor probe therefore has a target the last three rounds lacked:** isolate FTS5
segment-merge read traffic, and build an instrument carrying **WAL, spill and RSS counters** so
the two candidate channels can be told apart. `rho_D(T9) < 1.0` is its second target and needs an
explanation before any cache story is published.

**The pre-registered prior was roughly right.** §1a's honest prior said CACHE-INERT was more
likely than CACHE-DOMINANT. The result landed between them at PARTIAL. Recorded because the
prior was written down before the data and should be scored, not quietly forgotten.

**AMENDMENT 3's prediction was satisfied, not falsified** — the first write-up said otherwise and
was wrong in direction. Every comparable block-1 statistic moved toward 1.0 as registered
(`rho_C` 0.6720 → 0.6921, `rho_B(T5)` 0.6710 → 0.6871, `rho_B(T1)` 0.9279 → 0.9774). All moves
are ≤0.05, inside block spread — directionally satisfied, quantitatively empty, and too weak to
adjudicate anything.

Full RESULT: `IMPLEMENTATION_PLAN.md` § E1-AB RESULT. Adversarial review:
`eval/results/e1-ab-results-review.md`. Data: `eval/results/e1-ab-{verdict,runs}.json*`.
Discarded pre-AMENDMENT-3 runs, quarantined not deleted: `eval/results/discarded-amendment3/`.

---

## 2. Binding constraints — carried forward, still in force

- **Read order:** `HANDOFF_Q1.md` → `IMPLEMENTATION_PLAN.md` (read the result block for any
  subsystem BEFORE touching it) → `MAST_SPEC.md`.
- **Ceremony for measurements (§6):** pre-register and **COMMIT the registration before any
  run**; adversarial design review AND results review (Agent tool, model `fable`); **VERIFY
  the reviewer's claims — it has been wrong before.** On this session's results review every
  load-bearing claim reproduced, but three of its findings were narrative rather than
  arithmetic, and the distinction only became visible by checking.
- **Never open `graph.db` with `?mode=ro&immutable=1`** (WAL-blind; cost a session a false
  conclusion).
- **Run every script from `packages/mast`, never the repo root.**
- **Remove worktrees with `git worktree remove`, never `rm -rf`.**
- **Do NOT reopen settled questions** (HANDOFF §3): Q4, harvest-as-verdict-source, Q1/SCALE,
  IDFUSE, DECLEX, and the vector deletion itself.
- **The ranker-D escape variant is measured harmful** — never ship or re-test without a fresh
  registration. Option (d)'s lock-free-read/write-behind overlay is DEFERRED per E7-r2.
- **Instrument reuse requires first fixing that instrument's defects** — see §4 for what is
  fixed and what is still open.
- **TDD red-first for every behavioural change.** Where an honest red is impossible, say so —
  **never fake one**. Two techniques this track has actually used: stub the new function with
  the OLD (defective) behaviour so the red is an assertion failure rather than a missing
  import; and for a brand-new pure module, where the only available red is "module not found",
  say so plainly and **mutation-test instead**. The E1-AB session ran 11 mutations across two
  new modules and one survived — a within-block slope test using a uniform multiplier, which a
  slope is mathematically blind to, so it passed even when the function ignored its `block`
  argument. That gap was invisible on a reading.
- Project `CLAUDE.md`: **do not call the Agent tool unless the user requested it** — §6's
  ceremony *is* a standing request for the design/results reviews specifically, and nothing
  else. **Do not use workflows or deep-research unless requested.**
- Global `CLAUDE.md`: stop at ~70% context and ask about compacting. **Never `--no-verify`.**

### Verification baseline — every change must hold

| check | expected |
|---|---|
| `pnpm -F mast test` | green — **898 tests / 58 files** at `e86999e` |
| `pnpm -F mast typecheck` | clean |
| `pnpm -F mast lint` | clean |
| `pnpm -F mast build` | clean |
| `pnpm align:check` **from the repo root** | baselined debt **324 → 324 (+0)** |

`align` reports **verdict red**, and that is expected: exactly two pre-existing non-mast
violations (`application/ui/src/views/root-layout.tsx` import cycle;
`application/api/src/domain/spec/fold-build-record-repository.ts` dependency direction). **Do
not attribute those to your changes and do not add new debt.**

> Re-measure rather than inheriting. Two previous handoffs recorded a file count that was
> wrong (728/50 for an actual 728/49; 796/52 which was right, then left stale through
> +102 tests). The numbers above were measured at `e86999e`.

---

## 3. Operational gotchas that cost time

- **Bash working directory persists between calls.** `cd /path && cmd` leaves you at `/path`
  for every later call. Run root-level commands in a **subshell**:
  `( cd /Users/spikedpunchvictim/projects/kluster && pnpm align:check )`.
- **`dist/` is gitignored and the installed binary symlinks into it (D8).** Every
  `eval/*.mjs` imports from `../dist/` directly, so **run `pnpm -F mast build` before any
  measurement**, and Gate 0's `dist` content hash is what proves which binary ran.
- **Never write a test that spawns `src/cli/index.js`** — it does not exist under vitest, the
  spawn returns empty stdout, and negative assertions pass on that emptiness.
- **Long runs must be launched genuinely detached** — `spawn(..., {detached: true, stdio:
  ['ignore', out, out]})` then `.unref()`. **This worked cleanly for E1-PHASE's 35-minute
  schedule.** What still fails is *waiting*: a background poll-until-exit was killed by tool
  timeout **twice**, while the detached run itself continued unharmed both times. **A dead
  waiter is not a dead run — check `kill -0 <pid>` before concluding anything.** A launcher
  is at `scratchpad/launch.mjs`; the pattern is three lines and worth re-creating.
- **Reconcile `attempt_start` records against completed attempts** after every schedule. This
  session's RESULT block first claimed "16 attempt records, one Gate 3 miss"; the journal had
  **18 and two**. The arithmetic (18 starts = 18 completions, 0 orphans) is what proved
  A4-MAT-3's interruption class did not occur.
- Commit messages end with the `Co-Authored-By` trailer; see `git log` for house style
  (why, not what).

---

## 4. Instrument state

### E1-PHASE's instrument — exists, tested, committed before its own scored runs

| file | role |
|---|---|
| `eval/e1-phase-schedule.mjs` | 5-rung schedule, Gate P, the `ln(0)` guard, state-dir namespacing — 20 tests |
| `eval/e1-phase-score.mjs` | every threshold, the six series' fits, H1–H4/H0, mini-replication — 43 tests |
| `eval/e1-phase-run.mjs` | the 15-run driver (resumable, journalled) |
| `eval/e1-phase-report.mjs` | the journal→scorer seam — 5 tests |

E1's own modules were **not** modified; what E1-PHASE inherits unchanged it imports
(`gate3Verdict`, `orphanedAttempts`, `remainingAttempts`, `selectFitted`, `median`). E1's
`eval/e1-{common,schedule,score,stats,run,report}.mjs` are untouched and its 42-run record
stands exactly as scored.

**State dirs are namespaced `phase-run-*`.** `runColdIndex` wipes its state dir before every
run, and Gate 6 sequences R3/R4/E2/R5 to read E1's retained `run-T9-r3` — reusing the names
would have destroyed those artifacts on the first T9 run. Pinned by a test.

### E1-AB's instrument — built and committed BEFORE its own scored runs (Gate 5)

| file | role |
|---|---|
| `eval/e1-ab-schedule.mjs` | arms, Latin-square T9 ordering, Gate A, state-dir namespacing — 22 tests |
| `eval/e1-ab-score.mjs` | every registered threshold, the bands, the 2×2, the slopes — 32 tests |
| `eval/e1-ab-report.mjs` | `foldJournal` (RR6's dequeue), `planPending`, `selectAbRuns`, Gate P2 — 22 tests |
| `eval/e1-ab-run.mjs` | the 30-run driver |

**`foldJournal` and `planPending` live in the REPORT module, not the driver.** RR6 survived the
E1-PHASE review precisely because it was driver-private and nothing could reach it. Do not move
decision logic back into a driver.

**`eval/e1-common.mjs` and `eval/e1-schedule.mjs` were touched — both additively, both pinned by
tests.** `buildIndexArgs` is extracted so the no-extra-args argv is asserted byte-for-byte as
what E1's 42 and E1-PHASE's 15 runs were spawned with; `orphanedAttempts` takes an optional key
function because its hardcoded `corpus#rep` would have collapsed every E1-AB record into one
`undefined#undefined` bucket. E1's and E1-PHASE's scored records are untouched and unre-scored.

### Defect status — one fixed, one still open

- **The VOID queue has no dequeue (RR6) — FIXED for E1-AB**, in `foldJournal`, with a
  void → re-run → `scoreable: true` test. ⚠️ **`e1-phase-run.mjs` and `e1-run.mjs` still carry
  the defect** and must be fixed before either is reused.
- **`fitSeries` reports spurious precision on quantized series — STILL OPEN.** The remainder was
  fitted over 1–14 ms values; ±1 ms moves that exponent across 0.37–0.79, wider than its own
  printed interval. Does not affect E1-AB (no OLS on a quantized series; its slopes run over
  1.4 s–500 s values), so it was not fixed here.

### Known instrument facts worth not rediscovering

- On a **thrice-failing Gate 3 run**, `gate3` is the **last** attempt's verdict while
  `duration_ms` is the **first** attempt's value — registered (A4-MAT-6), every attempt in
  `gate3_attempts`, but the two fields do not correspond and must not be divided.
- `walk` contains `openDatabase` and the schema DDL, so they are inside `c`. Measured at
  **1.40% of `durationMs` at T1, falling to 0.05% at T9.**
- E1-PHASE's `c = 15 ms`, re-measured. It **fell** from E1's 23.5 ms across a change that
  *added* timing stamps. **That is unexplained** — do not repeat the first RESULT's claim
  that it was the stamps' own cost, which is impossible in that direction.

---

## 5. The E1-PHASE result in one page

Full text: `IMPLEMENTATION_PLAN.md` § `#### E1-PHASE RESULT (2026-08-12)` and the
`##### E1-PHASE RESULTS REVIEW` beneath it. Read both before designing the A/B.

| series | `b` | T9 share |
|---|---|---|
| walk | 0.6019 | 0.05% |
| parse | 1.0144 | 4.33% |
| **write** | **1.9685** | **94.01%** |
| edges | 1.4360 | 1.56% |
| finalise | 1.2623 | 0.05% |
| remainder | 0.5504 | 0.002% |

Write's share climbs 52% → 94% across the ladder while parse's collapses 43% → 4%. Parse is
essentially exactly linear.

**Carry these caveats with the result — they are what the review corrected:**

- **The 60% share condition was far less of a risky test than it looks.** The declared T1
  attribution peek had already shown write at **51.7–56.2%**, so clearing 60% at T9 was close
  to foreordained. The informative content is the localisation (parse at 1.0144, write's
  climb), **not** that a bar was cleared by 34 points.
- **The estimator rules were registered at `5f7ef33`, not `0298a98`.** Only the four numeric
  thresholds (1.6 / 1.25 / 0.60 / 1.7529) were in `0298a98`. Both are pre-data; the
  distinction matters in a program whose method is commit-ordered provenance.
- **Gate 5's margin was 24 seconds**, and most of the calibration ran pre-commit. Behavioural
  identity was verified (`git diff e69020a..HEAD -- eval/` empty; the committed schedule
  builder reproduces the pin bit-for-bit), but do better next time: commit, *then* launch.
- **The coupling looks DB-wide, not write-exclusive.** `edges` (1.436) and `finalise` (1.2623)
  both exceed the near-linear growth of the items they process. At a 1.6% share this changes
  no fix priority, but the A/B's design should not assume write is the only affected phase.
- **Write is itself a mixture** — split-half `b_write` is 1.8378 (T1–T5) and 2.0627 (T5–T9).
- **T5's repetition spread is 12.5%** (27,105 / 29,649 / 30,498 ms) against ≤2.7% elsewhere.
  Unexplained. Dropping T5 leaves `b_write` at 1.9685.
- The mini-replication (`b = 1.7768`, HC3 [1.6693, 1.8843], covering E1's 1.7529) is
  **consistent** and **adjudicates nothing** in either direction.

---

## 6. Still open

- **The E1-AB successor probe** — §1a. The live item. Two targets: isolate FTS5 segment-merge
  read traffic (the tripwire finding), and explain `rho_D(T9) = 0.8486`. Needs an instrument
  carrying **WAL, spill and RSS counters** — the current one has none, which is exactly why
  E1-AB cannot separate read-miss volume from spill/eviction policy.
- **Rule-set gaps E1-AB exposed, for the successor's registration** — three, all recorded in the
  RESULT and none repaired retroactively: (a) `D_HELPS_ANOMALY` is keyed to T1 only
  (`eval/e1-ab-score.mjs:224`), so `rho_D(T9) <= 0.90` passes unflagged; (b) A5's INTERFERENCE
  text says "any arm", which collides with D's positive-control role — the scorer's B-only
  reading is post-hoc; (c) `spread_finding` is written to the verdict JSON and printed nowhere
  by the reporter, so D/T1's 0.412 spread was invisible at the console.
- **`SLOPE_MATERIAL_DELTA` is a fire/no-fire bar with no interval behind it.** E1-AB's outcome
  cleared it by 0.0204. Either publish an interval for the block-slope median or stop reporting
  the classification as though it were a test.
- **`MAST_SPEC` does not document `--cache-size-mib` / `--mmap-size-mib`** (added `2127ef7`),
  and still does not document `--phase-timing` / `ENABLE_MAST_PHASE_TIMING`. Settle together.
- **R2 — parse-only pass + Gate 2** (A4-MAT-8): file/chunk/symbol counts must equal the full
  index's exactly; edge count deliberately excluded. **Note E1-PHASE partly overtakes its
  motivation** — R2 existed to split parse cost from write cost, which is now measured
  directly. Re-decide whether it still earns its keep before building it.
- **E2 + Gate 8**: `extractFile` takes no `onCallSite`, so E2 needs its own harness pass with
  file/chunk/symbol equality and `edge_emitted ≥ POTENTIAL_CALL`.
- **R5, last, per Gate 6**: K=4 readers, ≥400 scored calls overlapping write activity, 250 ms
  pacing, T1 and T9.
- **P3 spec drift (unowned)**: `MAST_SPEC` §14.6's `--session`/`--global` flags and §14.3's
  batched-metrics-writes claim.
- The `ENABLE_MAST_PHASE_TIMING` convention, for whoever writes that spec section: the
  codebase's first environment flag — `ENABLE_`-prefixed, value is the word `true`/`false`,
  **never** `1`/`0`, compared case-insensitively after trimming, failing closed on anything else.
- **Standing**: M2 condition-5 review at organic harvest `n ≥ 67` or 2026-11-05 (`n = 0`).

## 7. Session commits (newest first)

2026-08-13 — the E1-AB session:
```
e86999e  chore(mast/eval): pin E1-AB's binary and schedule before any run
d5b7e6c  feat(mast/eval): the E1-AB driver, and AMENDMENT 2 — a gap the tests found in A6
b99e66c  feat(mast/eval): E1-AB's arms, schedule and scorer — plus the Gate A fix the review earned
3b32560  docs(mast): amend E1-AB after the adversarial design review — one arm dies, one statistic is replaced
315272d  docs(mast): register E1-AB — is the page cache the mechanism, or not
65d4822  docs(mast): withdraw the 2 MB page-cache claim at all three sites that made it
bba6a78  docs(mast): correct the default page-cache figure — 16 MB, not 2 MB
2127ef7  feat(mast): make cache_size/mmap_size reachable, so the A/B has a lever
```

2026-08-12 — the E1-PHASE session:
```
6082361  docs(mast): fold the E1-PHASE results review in — H1 stands, three claims around it do not
952f691  fix(mast): correct the E1-PHASE RESULT's Gate 3 record, and quantify the bias
e24e6ed  feat(mast/eval): score E1-PHASE — H1 fires, the exponent is in the write phase
e69020a  feat(mast/eval): the E1-PHASE instrument, committed before any scored run
6f46af5  docs(mast): hand off the E1 track — E1 scored, E1-PHASE registered and unrun
```

## 8. Artifacts

`eval/results/` — **E1-AB**: `e1-ab-schedule.json` (schedule + binary pin, committed pre-run),
`e1-ab-runs.jsonl` (the journal), `e1-ab-runs-summary.json`, `e1-ab-verdict.json` (written by
`e1-ab-report.mjs`). **E1-PHASE**: `e1-phase-verdict.json` (six exponents, shares under both
registered readings, the full condition table, mini-replication), `e1-phase-runs.jsonl`
(15 runs + 18 attempt records), `e1-phase-runs-summary.json`, `e1-phase-calibration.json`
(`c = 15`), `e1-phase-schedule.json` (schedule + binary pin), `e1-phase-attribution.json`
(Gate P's anchor, and the declared peek). **E1**: `e1-verdict.json`, `e1-runs.jsonl` (42 runs
+ 55 attempt records), `e1-runs-summary.json`, `e1-calibration.json` (`c = 23.5`,
**superseded for E1-PHASE**), `e1-tiers.json` (frozen manifest + Gate 1b arithmetic),
`e1-schedule.json`.
