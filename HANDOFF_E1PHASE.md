# HANDOFF — E1-PHASE, registered and reviewed, NOT YET RUN

**Written 2026-08-12 at `ef02ef9`.** Read this first, then `HANDOFF_Q1.md`, then
`IMPLEMENTATION_PLAN.md`, then `MAST_SPEC.md`. This file covers only what changed in the
E1 track; `HANDOFF_Q1.md` §5 (instrument defects) and §6 (methodological rules) remain in
force unchanged and are **not** superseded by anything here.

---

## 1. Where the work stands

**E1 is complete and scored.** Verdict **SUPER-LINEAR REGRESSION**: adjusted `b = 1.7529`,
HC3 95% CI `[1.6599, 1.8458]`, against the pre-registered threshold of 1.35. Raw and the
wild-cluster bootstrap agree, so none of the routes to AMBIGUOUS were taken. HOLDS was
arithmetically reachable — realized cluster `σ = 0.1851` against Gate 1b's committed
`0.28188` ceiling — and was rejected. An adversarial results review was commissioned,
every load-bearing claim recomputed and confirmed, and its seven items were folded into the
RESULT block. **M1's O(N) claim does not extend past ~5k files; Stage 2 reopens as a scale
defect.**

**E1-PHASE is registered, design-reviewed, its findings discharged — and has not been run.**
It is the mechanism localisation: which phase of the build carries E1's exponent. Everything
needed to run it exists except the runner script itself.

### The immediate next action

1. Build `eval/e1-phase-run.mjs` (the runner does not exist yet — see §4).
2. Re-calibrate `c` (10 empty-corpus runs; **do not reuse E1's 23.5 ms** — the binary
   changed at `c71d59c`).
3. Run the 15 scored runs (~35 min, plus any Gate 3 retakes).
4. Score, write the RESULT block, then commission the adversarial **results** review and
   **verify its claims against source** before acting on any of them.

---

## 2. Binding constraints — carried forward, still in force

These are inherited from the original brief and are **not** negotiable:

- **Read order:** `HANDOFF_Q1.md` → `IMPLEMENTATION_PLAN.md` (read the result block for any
  subsystem BEFORE touching it) → `MAST_SPEC.md`.
- **Ceremony for measurements (§6):** pre-register in `IMPLEMENTATION_PLAN.md` (hypothesis,
  tiers, pinned-corpus plan, falsification criteria, **direction-of-error statement**) and
  **COMMIT the registration before any run**; commission an adversarial design review AND
  later a results review (Agent tool, model `fable`) and **VERIFY the reviewer's claims — it
  has been wrong before**; only then build and run the instrument.
- **Never open `graph.db` with `?mode=ro&immutable=1`** (WAL-blind; cost a session a false
  conclusion).
- **Run every script from `packages/mast`, never the repo root.**
- **Remove worktrees with `git worktree remove`, never `rm -rf`.**
- **Do NOT reopen settled questions** (HANDOFF §3): Q4, harvest-as-verdict-source, Q1/SCALE,
  IDFUSE, DECLEX, and the vector deletion itself.
- **The ranker-D escape variant is measured harmful** — never ship or re-test without a fresh
  registration. Option (d)'s lock-free-read/write-behind overlay is DEFERRED per E7-r2 until
  scale evidence — do not build it early.
- **Instrument reuse requires first fixing that instrument's HANDOFF §5 defects.**
- **TDD red-first for every behavioural change.** Where an honest red is impossible, say so
  in the plan (D1's result is the precedent) — **never fake one**.
- Project `CLAUDE.md`: **do not call the Agent tool unless the user requested it** — note the
  §6 ceremony above *is* a standing request for the design/results reviews specifically, and
  nothing else. **Do not use workflows or deep-research unless requested.**
- Global `CLAUDE.md`: stop at ~70% context and ask about compacting. **Never `--no-verify`.**

### Verification baseline — every change must hold

| check | expected |
|---|---|
| `pnpm -F mast test` | green — **728 tests / 50 files** at `ef02ef9` |
| `pnpm -F mast typecheck` | clean |
| `pnpm -F mast lint` | clean |
| `pnpm -F mast build` | clean |
| `pnpm align:check` **from the repo root** | baselined debt **324 → 324 (+0)** |

`align` reports **verdict red**, and that is expected: exactly two pre-existing non-mast
violations (`application/ui/src/views/root-layout.tsx` import cycle;
`application/api/src/domain/spec/fold-build-record-repository.ts` dependency direction). **Do
not attribute those to your changes and do not add new debt.**

---

## 3. Operational gotchas that cost time this session

- **Bash working directory persists between calls.** `cd /path && cmd` leaves you at
  `/path` for every later call — this silently pointed a `grep IMPLEMENTATION_PLAN.md` at
  the repo-root file (311 lines) instead of the mast one (7,700+). Run root-level commands in
  a **subshell**: `( cd /Users/spikedpunchvictim/projects/kluster && pnpm align:check )`.
- **`dist/` is gitignored and the installed binary symlinks into it (D8).** A stale build
  once served three days of sessions. Every `eval/*.mjs` imports from `../dist/` directly, so
  **run `pnpm -F mast build` before any measurement**, and Gate 0's `dist` content hash is
  what proves which binary ran.
- **Never write a test that spawns `src/cli/index.js`** — it does not exist under vitest, the
  spawn returns empty stdout, and negative assertions pass on that emptiness. This produced a
  false green this session; the fix was extracting a pure predicate (`isPhaseTimingEnabled`).
- **Long runs must be launched genuinely detached** — `spawn(..., {detached: true, stdio:
  ['ignore', out, out]})` then `.unref()`. Two E1 launches were killed by tool timeouts (10
  min and 2 min), which is how the interrupted-attempt defect was discovered.
- Publishing/committing: commit messages end with the `Co-Authored-By` trailer per the repo
  convention; see `git log` for the house style (why, not what).

---

## 4. Instrument state — what exists and what does not

### Exists and is tested

| file | role |
|---|---|
| `eval/e1-common.mjs` | Gate 0 (`assertGate0`, dist content hash), corpus pinning, `runColdIndex` (spawnSync, `NODE_OPTIONS` stripped, sets `ENABLE_MAST_PHASE_TIMING=true`), `parseDurationMs`, **`parsePhaseMs`**, `readIndexedPaths`, `writeResult` |
| `eval/e1-schedule.mjs` | pure decision logic: `buildSchedule`, `gate3Verdict`, `retainStateDir`, `median`, `orphanedAttempts`, `remainingAttempts`, **`selectFitted`** — 24 tests |
| `eval/e1-score.mjs` | `scoreE1`, `combineE1Verdict`, triggers 3/4/5 — 56 known-answer tests. **Committed at `4b49bc1` before scored run 1** |
| `eval/e1-stats.mjs` | OLS, HC3, CR1, Webb wild-cluster bootstrap, lack-of-fit F |
| `eval/e1-run.mjs` | the E1 42-run driver (resumable, journalled) |
| `eval/e1-report.mjs` | `selectRuns`, `realizedSigma`, the scoring entry point — 11 tests |
| `eval/e1-phase-attribution.mjs` | Gate P's anchor measurement (already run) |
| `src/indexer/index.ts` | `IndexResult.phaseMs` — walk / parse / write / edges / finalise |
| `src/cli/index-cmd.ts` | `isPhaseTimingEnabled`, the `phases:` output line |

### Does NOT exist — this is the build task

**`eval/e1-phase-run.mjs`.** Model it on `eval/e1-run.mjs`, which already implements every
inherited gate. What differs:

- **5 rungs, not 9**: T1, T3, T5, T7, T9 from the frozen manifest (`eval/results/e1-tiers.json`).
- **Its own journal and its own seeded shuffle over the 15 pairs.** Do not append to
  `e1-runs.jsonl` — that file is E1's record and its 42 runs must stay exactly as scored.
- **Gate P**: `Σ phase_ms ≥ 0.95 × durationMs` per scored run, else VOID into the
  A4-MAT-7 queue.
- **VOID on `phase_ms == null` or any phase `≤ 0`** — `parsePhaseMs` returns null by design
  so the harness can still read E1's history; on an E1-PHASE run a null is a defect.
- **Recalibrate `c`** — `--recalibrate` semantics as in `e1-run.mjs`.
- Reuse `selectFitted` so the clock and its decomposition come from **one attempt**.

The tier hardlink trees are still materialised at `~/.cache/mast-eval/e1/tiers/` (T1 verified
at 656 files), so `materialiseTiers` should reuse rather than rebuild them — the sidecar
manifest check already handles this.

### Known instrument facts worth not rediscovering

- On a **thrice-failing Gate 3 run**, the record's `gate3` field is the **last** attempt's
  verdict while `duration_ms` is the **first** attempt's value. Registered (A4-MAT-6),
  every attempt preserved in `gate3_attempts` — but the two fields do not correspond and
  must not be divided by one another.
- `e1-runs-summary.json` carries a `scoreable` flag that is **stricter than the
  registration**: it demands zero findings, whereas A4-MAT-6 says a thrice-failing Gate 3 run
  is logged and retained, never a blocker. Left as-is deliberately rather than edited after
  seeing data. The registered blockers are VOID runs and chunk-count nondeterminism.
- `walk` contains `openDatabase` and the schema DDL (they precede the walk stamp), so they
  are inside `c`. Measured at **1.27–1.47%** of `durationMs` at T1.
- The unattributed remainder is `db.destroy()`'s WAL close-time checkpoint — 2–3 ms at T1
  (0.09%), and the one **size-coupled** cost outside every phase.

---

## 5. E1-PHASE's registration in one page

Full text: `IMPLEMENTATION_PLAN.md`, `### E1-PHASE PRE-REGISTRATION (2026-08-12)`. Read it
in full before running. Summary:

**It is a DIAGNOSTIC.** It cannot confirm, overturn or soften E1's verdict, and no result may
be reported as doing so.

**Design.** T1/T3/T5/T7/T9 × 3 reps = 15 runs, still exactly even in `ln N`
(`d = 0.7482`, `Sxx_cluster = 5.598`). Measured quantity: `b_phase` from OLS of
`ln(phase_ms)` on `ln(chunk_count)`, plus each phase's share of `durationMs` at T9.

| | fires if |
|---|---|
| **H1** write-localised | `b_write ≥ 1.6` **and** `b_parse ≤ 1.25` **and** write's T9 share `≥ 60%` |
| **H2** edge/symbol resolution | `b_edges ≥ 1.6` **and** strictly rising share |
| **H3** parse | `b_parse ≥ 1.6` |
| **H4** diffuse | no phase reaches 1.6 |
| **H0** residual | all of H1–H4 refuted → "localised, unclassified", escalate as H4 |

**Comparisons are on HC3 point estimates; CIs are context only and refute nothing.** Shares
come from each tier's **median** run. A confirmed H1 licenses **"write-localised, mechanism
unidentified"** and nothing narrower — chunks and DB bytes are collinear across this ladder,
so a cache cliff, FTS5 segment merges and per-file transaction overhead are indistinguishable
here. The registered discriminator is a `cache_size`/`mmap_size` A/B at one rung, run **after**
this diagnostic and **before** any shipped fix.

**Direction of error, stated because it is unfavourable:** H1 is the previous agent's own
hypothesis. The originally-claimed three-condition compensation was **largely theatre** and
is corrected in the registration: because phases tile `durationMs`,
`b_total = Σ share_i · b_i`, so given E1's 1.904 upper-half slope only **one** condition is
substantively free — write's T9 share. A fact recorded before the run already damages H1's
*mechanism* story: T1's DB is 21.6 MB against a ~2 MB default cache, so the cache is
exhausted before the ladder starts and cannot produce E1's T4/T5 knee.

**A declared peek:** the Gate P attribution runs revealed T1's phase shares. Every threshold
they could have tuned — including the 60% share condition — was committed at `36c2f5a`
beforehand, and those runs are excluded from every fit.

**No fix before the diagnosis.** Do not set a pragma, do not defer index creation. Any fix
that follows is verified by re-running **E1's full 9-rung ladder** against the committed
scorer and the immutable 1.35 threshold.

---

## 6. Still open after E1-PHASE

- **R2 — parse-only pass + Gate 2** (registered by A4-MAT-8): file/chunk/symbol counts must
  equal the full index's exactly; edge count deliberately excluded.
- **E2 + Gate 8**: `extractFile` takes no `onCallSite`, so E2 needs its own harness pass with
  file/chunk/symbol equality and `edge_emitted ≥ POTENTIAL_CALL`.
- **R5, last, per Gate 6**: K=4 readers, ≥400 scored calls overlapping write activity, 250 ms
  pacing, T1 and T9.
- **P3 spec drift (unowned)**: `MAST_SPEC` §14.6's `--session`/`--global` flags and §14.3's
  batched-metrics-writes claim.
- **MAST_SPEC does not yet document `--phase-timing` / `ENABLE_MAST_PHASE_TIMING`.** It is
  the codebase's first environment flag and sets the convention: `ENABLE_`-prefixed, value is
  the word `true`/`false`, **never** `1`/`0`, compared case-insensitively after trimming, and
  failing closed on anything else.
- **Standing**: M2 condition-5 review at organic harvest `n ≥ 67` or 2026-11-05 (currently
  `n = 0`).

---

## 7. Session commits (newest first)

```
ef02ef9  fix(mast/eval): apply the E1-PHASE design review before any scored run
36c2f5a  docs(mast): register E1-PHASE before any run
c71d59c  feat(mast): per-phase index timing behind --phase-timing / ENABLE_MAST_PHASE_TIMING
3f7b1fa  fix(mast/eval): persist interrupted attempts — A4-MAT-3 was never implemented
227cf17  feat(mast/eval): score E1 — SUPER-LINEAR REGRESSION at b = 1.75
a310378  docs(mast): withdraw A4-C2 — the Gate 3 floor is load-bearing after all
```

## 8. Artifacts

`eval/results/` — `e1-verdict.json` (verdict, both fits, panel, triggers, reachability),
`e1-runs.jsonl` (42 runs + 55 attempt records), `e1-runs-summary.json` (4 findings: 2
INTERRUPTED, 2 Gate 3), `e1-calibration.json` (E1's `c = 23.5`, **superseded for E1-PHASE**),
`e1-tiers.json` (frozen manifest + Gate 1b arithmetic), `e1-schedule.json`,
`e1-phase-attribution.json` (Gate P's anchor).
