# HANDOFF — E1-PHASE RUN AND SCORED; the mechanism A/B is next

**Written 2026-08-12 at `497389b`.** Read this first, then `HANDOFF_Q1.md`, then
`IMPLEMENTATION_PLAN.md`, then `MAST_SPEC.md`. This file covers only the E1 track;
`HANDOFF_Q1.md` §5 (instrument defects — **two new entries from this session**) and §6
(methodological rules) remain in force unchanged and are **not** superseded by anything here.

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

### The immediate next action — the mechanism A/B

**A `cache_size` / `mmap_size` A/B at a single rung.** This is the registered discriminator,
committed inside the E1-PHASE registration precisely so it could not be improvised after the
result. It is a **probe, not a remedy.**

Four things constrain it, and none is negotiable:

1. **"No fix before the diagnosis" is now DISCHARGED** — the diagnosis is complete. The A/B
   is explicitly permitted by the registration and does not breach that rule. But **it is
   still a measurement**, so §6's full ceremony applies to it: pre-register in
   `IMPLEMENTATION_PLAN.md` with falsification criteria and a **direction-of-error
   statement**, **commit the registration before running**, commission an adversarial design
   review (Agent tool, model `fable`), **verify its claims against source**, then build, run,
   and commission a results review.
2. **It is a probe. It does not ship anything.** No pragma is set in product code on the
   strength of it.
3. **Any fix that eventually follows is verified by re-running E1's full 9-rung ladder**
   against the committed scorer and the immutable 1.35 threshold — never by re-running
   E1-PHASE, and never by moving a threshold.
4. **A confirmed H1 licenses "write-localised, mechanism unidentified" and nothing
   narrower.** Chunks and DB bytes are perfectly collinear across this ladder, so a
   page-cache cliff, FTS5 trigram segment merges, per-file transaction overhead and B-tree
   depth growth are **indistinguishable on this evidence**. Anyone calling the E1-PHASE
   result "the page-cache cliff" is over-reading it — including the A/B's own registration.

**Read before designing it — and note this reverses what the previous handoff said here.**
That handoff recorded a pre-run fact said to damage the cache-cliff story specifically: *"T1's
database is 21.6 MB against SQLite's ~2 MB default page cache, so the cache is exhausted
before the ladder even begins."* **The ~2 MB figure is wrong.** `better-sqlite3@12.11.1`
compiles the amalgamation with `SQLITE_DEFAULT_CACHE_SIZE=-16000` (`deps/defines.gypi:13`,
confirmed on the shipped object's own compile command line), so **MAST's effective default
page cache is ~16 MB**, and the control arm's own `pragmas:` line now prints `-16000` on every
run as standing proof. Also measured: **`mmap_size = 0` by default** — memory mapping is off,
so an mmap arm is an on/off contrast, not a resize.

At the true default T1 is **1.3×** the cache, not 10×: the ladder *crosses* the cache boundary
near its first rung and reaches 4–6× by T4/T5 — the regime in which a cliff would produce a
knee, which is where E1 measured one. Full reasoning and its three attached limits are in
`IMPLEMENTATION_PLAN.md` § `CORRECTION (2026-08-13)`.

**Do not over-read this either.** It withdraws a piece of counter-evidence; it does not supply
evidence *for* the cliff, and constraint 4 above is untouched — a confirmed H1 still licenses
"write-localised, mechanism unidentified" and nothing narrower. The A/B must still be designed
to be capable of *refuting* the cliff. What changed is only that the cliff can no longer be
dismissed a priori, and that **the arms must be sized against a 16 MB control, not a 2 MB one**
— the control is already a moderately large cache.

### The A/B needs a product change first — decided 2026-08-12, NOT yet built

**The pragma cannot currently be set at all.** `openDatabase(stateDir: string)`
(`src/graph/db.ts:369`) takes only a state dir and sets exactly three pragmas —
`journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`. There is no `cache_size`,
no `mmap_size`, and no parameter through which either could be passed. The E1-PHASE
registration named the A/B without saying how its arms would differ; **that is a gap in the
registration, found before building anything.**

**Owner decision: option A — an explicit optional parameter on `openDatabase`, threaded from
the CLI.** Do not re-decide this. The two rejected alternatives, with the reasons:

- **Env var read inside `openDatabase` — rejected.** A hidden global, and it breaks the
  dependency-injection line the codebase holds elsewhere.
- **A field on `MastConfig` via `resolveConfig` — rejected, and this one is a trap.** It
  **conflicts with the harness's own Gate 1**: `assertConfigPinned` (`eval/e1-common.mjs`)
  fails a run if a corpus-local `mast.config.json` exists or if resolved config deviates from
  defaults, precisely so config cannot act as a free lever over a measurement. Routing the
  A/B's arms through config would require breaching the gate that protects every other
  experiment in this program.

**Red-first test obligations (two, and the second is the load-bearing one):**

1. Given the option, `openDatabase` actually applies it — open a database, read
   `PRAGMA cache_size` back. Deterministic, no mocking, no fixture.
2. **Given no option, the default is unchanged** — no `cache_size` is set and SQLite's own
   default stands. This is what makes arm A provably *the un-pragma'd binary*; without it the
   A/B compares two things we changed.

**A consequence that must go into the A/B's registration, not be discovered afterwards:**
adding the parameter changes `dist`, so **Gate 0's content hash moves and the A/B runs on a
different binary than E1-PHASE's 15-run ladder.** Both arms share that binary, so the A/B is
internally valid — but its absolute timings are **not** comparable to the ladder's, and no
one may read across the two. Both arms re-assert one hash, as E1-PHASE did.

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
- **Instrument reuse requires first fixing that instrument's HANDOFF §5 defects** — and
  E1-PHASE's runner added two of them (see §4).
- **TDD red-first for every behavioural change.** Where an honest red is impossible, say so
  in the plan — **never fake one**. (This session drafted two modules before their tests,
  and recovered the red by parking the implementation and stubbing the module rather than
  claiming a red it had not earned. Do that, or write the test first.)
- Project `CLAUDE.md`: **do not call the Agent tool unless the user requested it** — §6's
  ceremony *is* a standing request for the design/results reviews specifically, and nothing
  else. **Do not use workflows or deep-research unless requested.**
- Global `CLAUDE.md`: stop at ~70% context and ask about compacting. **Never `--no-verify`.**

### Verification baseline — every change must hold

| check | expected |
|---|---|
| `pnpm -F mast test` | green — **796 tests / 52 files** at `497389b` |
| `pnpm -F mast typecheck` | clean |
| `pnpm -F mast lint` | clean |
| `pnpm -F mast build` | clean |
| `pnpm align:check` **from the repo root** | baselined debt **324 → 324 (+0)** |

`align` reports **verdict red**, and that is expected: exactly two pre-existing non-mast
violations (`application/ui/src/views/root-layout.tsx` import cycle;
`application/api/src/domain/spec/fold-build-record-repository.ts` dependency direction). **Do
not attribute those to your changes and do not add new debt.**

> The previous handoff recorded this baseline as "728 tests / 50 files". The test count was
> right; the file count was not — `2e87238` measures 728 / **49**. Trust the numbers above,
> and re-measure rather than inheriting.

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

### Two NEW defects — fix before reusing this instrument (now in HANDOFF_Q1 §5)

- **The VOID queue has no dequeue.** A Gate P/P2 VOID is re-run correctly, but the void
  record stays in `loadJournal`'s map forever, so `scoreable` is **permanently false** once
  anything has ever voided. Unexercised here (0 voids). `e1-run.mjs` shares the pattern.
- **`fitSeries` reports spurious precision on quantized series.** The remainder was fitted
  over 1–14 ms values; ±1 ms moves that exponent across 0.37–0.79, wider than its own printed
  interval. The scorer should emit the caveat; here it had to be added by hand.

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
- **The estimator rules were registered at `ef02ef9`, not `36c2f5a`.** Only the four numeric
  thresholds (1.6 / 1.25 / 0.60 / 1.7529) were in `36c2f5a`. Both are pre-data; the
  distinction matters in a program whose method is commit-ordered provenance.
- **Gate 5's margin was 24 seconds**, and most of the calibration ran pre-commit. Behavioural
  identity was verified (`git diff 6c45422..HEAD -- eval/` empty; the committed schedule
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

## 6. Still open after E1-PHASE

- **The `cache_size` / `mmap_size` A/B** — §1. The live item.
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
- **MAST_SPEC does not document `--phase-timing` / `ENABLE_MAST_PHASE_TIMING`.** It is the
  codebase's first environment flag and sets the convention: `ENABLE_`-prefixed, value is the
  word `true`/`false`, **never** `1`/`0`, compared case-insensitively after trimming, failing
  closed on anything else.
- **Standing**: M2 condition-5 review at organic harvest `n ≥ 67` or 2026-11-05 (`n = 0`).

## 7. Session commits (newest first)

```
497389b  docs(mast): fold the E1-PHASE results review in — H1 stands, three claims around it do not
0ba97ec  fix(mast): correct the E1-PHASE RESULT's Gate 3 record, and quantify the bias
d3ce505  feat(mast/eval): score E1-PHASE — H1 fires, the exponent is in the write phase
6c45422  feat(mast/eval): the E1-PHASE instrument, committed before any scored run
2e87238  docs(mast): hand off the E1 track — E1 scored, E1-PHASE registered and unrun
```

## 8. Artifacts

`eval/results/` — **E1-PHASE**: `e1-phase-verdict.json` (six exponents, shares under both
registered readings, the full condition table, mini-replication), `e1-phase-runs.jsonl`
(15 runs + 18 attempt records), `e1-phase-runs-summary.json`, `e1-phase-calibration.json`
(`c = 15`), `e1-phase-schedule.json` (schedule + binary pin), `e1-phase-attribution.json`
(Gate P's anchor, and the declared peek). **E1**: `e1-verdict.json`, `e1-runs.jsonl` (42 runs
+ 55 attempt records), `e1-runs-summary.json`, `e1-calibration.json` (`c = 23.5`,
**superseded for E1-PHASE**), `e1-tiers.json` (frozen manifest + Gate 1b arithmetic),
`e1-schedule.json`.
