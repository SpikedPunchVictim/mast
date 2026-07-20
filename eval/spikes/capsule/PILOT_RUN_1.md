# PILOT_RUN_1 — instrumented fold build (attempt 1): failed pre-implement, no telemetry produced

**Date:** 2026-07-18
**Run manager:** Claude (run-manager session; no source edits made)
**Purpose:** First fold build since (1) mast telemetry instrumentation (commit 673091c —
real `tokens_full_file_upper_bound`, new `args_json`/`results_json` columns) and (2) the
`--checker` index pass. The run's `.fold/.mast` metrics store was to be the first
LINKED chain-rate data point for the `mast_capsule` promote/demote decision
(IMPLEMENTATION_PLAN_VEXP.md).

## Verdict

**The build failed fatally in the `decompose` design phase, before any code-mode task ran.
No mast MCP session was ever spawned, so no `.fold/.mast` store exists and zero telemetry
rows were produced. Every instrumentation question this pilot was meant to answer is
unanswered: n = 0.** This document records the run so the next attempt starts informed,
not to settle anything.

## Run parameters

| | |
|---|---|
| CLI | `node packages/workbench/foldv2/cli/bin/run.js build` (repo root, freshly rebuilt `pnpm --filter "@foldv2/*" build`, clean tsc) |
| Architecture doc | `packages/workbench/examples/url-shortener-service.md` (production-grade URL shortener: hexagonal, Postgres, migrations, auth/ownership, analytics) |
| LLM config | `packages/workbench/foldv2/.config/llm.config.kimik27.yaml` → `kimi-k2.7-code:cloud` via `http://host.docker.internal:11434` |
| Workspace | `/Users/spikedpunchvictim/projects/kluster-workbench/apps/ab-fixes-kimik27-url-shortener-fold` |
| Build dir | `<workspace>/.fold` |
| Log | `/Users/spikedpunchvictim/projects/kluster-workbench/apps/ab-fixes-kimik27-url-shortener-fold-build.log` |
| Run id | `9017c1ac-c7c3-4240-b041-d639aa944a9e` |
| Runner image | `kluster/fold-runner:latest` (built 2026-07-18 08:48 UTC; in-image `mast 0.1.0` with `--checker` flag confirmed; `/opt/mast/dist` dated Jul 18) |
| Host mast | `/opt/homebrew/bin/mast 0.1.0`, `mast index --help` lists `--checker` ✓ |

## Outcome

- **Status:** failed (exit 1) at phase `decompose`, after 1 attempt, 0 retries, 1 escalation.
- **Phases completed:** archetype classification (http-service, inferred), scaffold,
  toolchain install, `spec` (43.4 s), `modules` (93.3 s). `decompose` aborted the build.
- **Tasks implemented:** 0/0. **Gates run:** none.
- **Wall time:** 136.7 s. **Tokens:** 63,967 in / 17,718 out / 0 cached (0% hit).
- **Patterns selected:** blob-storage, error-envelope, persistence-concurrency,
  time-series (blob-storage was signal-floor-added — looks like a mis-trigger for a URL
  shortener; advisory observation only, it played no role in the failure).

### Fatal error (verbatim, from the build log)

```
 ›   Error: Build failed at phase "decompose" after 1 attempts:
 ›   frozen entry "apps/api/src/server.ts" imports "apps/api/src/app.ts", but
 ›   no planned module builds it
```

### Diagnosis (evidence, no fix attempted)

- The http-service archetype scaffolds a **frozen** entry stub
  `apps/api/src/server.ts` that imports `./app.js` and `./config.js`
  (dual-entry composition-root convention; see the stub's own comment block).
- The `modules`/`decompose` output (`.fold/modules.json`) planned 44 modules, including
  `apps/api/src/config.ts` and — notably — `apps/api/src/server.ts` **itself** (the frozen
  file), but **no `apps/api/src/app.ts`**. The model appears to have folded the
  `buildApp` composition root into `server.ts` instead of the required `app.ts`.
- The pipeline's frozen-entry validation caught the mismatch and aborted — the validation
  worked as designed; the model's decomposition did not satisfy the scaffold contract.
- The decompose validation permitted only 1 attempt before declaring the build failed.

Artifacts preserved for inspection:
`<workspace>/.fold/9017c1ac-c7c3-4240-b041-d639aa944a9e/{spec.json,modules.json,build-report.json,report.md,selection.json}` and `<workspace>/.fold/{modules.json,entry-expectations.json,smoke-contract.json}`.

## Instrumentation verification — NOT POSSIBLE THIS RUN

| Check | Result |
|---|---|
| `.fold/.mast/graph.db` exists | **No** — directory `.fold/.mast` was never created |
| `tokens_full_file_upper_bound > 0` fraction | n/a (0 rows) |
| `args_json` / `results_json` population | n/a (0 rows) |
| Per-tool call distribution / session count | n/a (0 sessions) |
| Loose chain rate | n/a, n = 0 |
| Linked chain rate | n/a, n = 0 |

Why: the mast MCP server (which writes the metrics table) only runs inside code-mode
runner sessions (contract/implement/refine). The build died in a structured design phase,
so no code-mode session ever started. This is a total absence of the payload, not a
telemetry bug — nothing here bears on the instrumentation's correctness either way.

## Caveats / notes for the next attempt

1. **This failure is upstream of everything the pilot measures.** Do not read anything
   about mast, the checker pass, or the capsule gate into this run.
2. The failure looks decompose-model-specific (kimi-k2.7-code planned the composition
   root into the frozen `server.ts` rather than `app.ts`). Whether a relaunch resamples
   into a passing decomposition, or the phase prompt needs to state the `app.ts`
   obligation explicitly, is a foldv2 question — deliberately not acted on here (run
   manager mandate: no source edits, no unauthorized retries).
3. A phase cache exists at `<workspace>/.fold/cache/` (2 entries: spec + modules). A
   relaunch into the same workspace would reuse the cached modules output and hit the
   identical wall unless `--no-cache` is passed or the workspace is fresh.
4. Preflight facts that held: fold-runner image current (Jul 18) with the
   telemetry-instrumented mast baked in; host `mast --checker` present; foldv2 packages
   rebuilt clean from the uncommitted working tree (mast-bridge checker seam included,
   untouched); disk 85 Gi free; build dir did not pre-exist.

---

# Run 2 — approved relaunch into a fresh workspace: IDENTICAL decompose failure

**Date:** 2026-07-18. One user-approved retry; same arch doc, same kimik27 config, same
invocation, fresh workspace (so no cache replay — the phase cache is per-build-dir,
`FileArtifactCache(join(buildDir, "cache"))`, compositionRoot.ts:73). Run 1's workspace
and cache left untouched as evidence.

## Run 2 parameters (deltas from Run 1 only)

| | |
|---|---|
| Workspace | `/Users/spikedpunchvictim/projects/kluster-workbench/apps/ab-fixes-kimik27-url-shortener-fold-02` |
| Log | `/Users/spikedpunchvictim/projects/kluster-workbench/apps/ab-fixes-kimik27-url-shortener-fold-02-build.log` |
| Run id | `fb882922-c60d-40d0-b482-1121b3b7a497` |

## Outcome

- **Status:** failed (exit 1) at phase `decompose`, after 1 attempt — **verbatim-identical
  error to Run 1**:

```
 ›   Error: Build failed at phase "decompose" after 1 attempts:
 ›   frozen entry "apps/api/src/server.ts" imports "apps/api/src/app.ts", but
 ›   no planned module builds it
```

- Same classification (http-service, different rationale wording), same pattern set
  (blob-storage floor mis-trigger included). Wall 113 s; 62,864 in / 15,632 out tokens.
- Tasks 0/0, no gates, **no `.fold/.mast` store, zero telemetry rows** — again.

## Decompose comparison (the added instruction)

| | Run 1 | Run 2 |
|---|---|---|
| Planned modules | 44 | 39 |
| Plans `apps/api/src/app.ts` | **No** | **No** |
| Plans `apps/api/src/server.ts` (the frozen file) | Yes | Yes |
| Plans `apps/api/src/config.ts` | Yes | Yes |

Run 2's `apps/` module set: `config.ts`, `schemas/url.schemas.ts`, `plugins/auth.ts`,
`plugins/rate-limit.ts`, `error-handler.ts`, `routes/{url,redirect,stats}.routes.ts`,
`server.ts`. Independently sampled, kimi-k2.7-code again folded the composition root into
the frozen `server.ts` and never planned the `app.ts` the frozen stub imports.

## Conclusion (explicit, per the relaunch instruction)

**Two independent decompose samples produced the identical failure: this is evidence of a
systematic decompose-prompt gap, not sampling noise.** The frozen-entry contract — the
scaffolded `server.ts` stub imports `./app.js` and `./config.js`, so a module named
`apps/api/src/app.ts` MUST be planned — is enforced by the pipeline's validation but is
evidently not communicated to the decompose phase strongly enough for kimi-k2.7-code to
satisfy it (it plans `config.ts` reliably, but treats `server.ts` as the composition root
and omits `app.ts` in both samples, and even redundantly plans the frozen `server.ts`
itself). Fixing this is a foldv2 decompose-prompt change (state the app.ts obligation and
the frozen-file exclusion in the phase input), which is outside this run-manager mandate.
No third attempt was made, per instruction.

**Telemetry pilot status after two attempts: still n = 0.** The capsule-gate LINKED
chain-rate question remains unanswered; it is blocked behind the decompose fix.

---

# Run 3 — decompose fix validated; kimi quota death mid-contract; sonnet continuation to AWAITING DECISION; **first real telemetry**

**Date:** 2026-07-18 → 07-19. Workspace
`/Users/spikedpunchvictim/projects/kluster-workbench/apps/ab-fixes-kimik27-url-shortener-fold-03`.
Two runs share this workspace and one `.fold/.mast` store: the kimi run
(`c8f4fbba-60fc-4d82-8061-9c4275faa87c`, log `…fold-03-build.log`) and the user-approved
mid-run model pivot to Sonnet (`4051bf20-e872-4150-877f-83573cc904cb`, log
`…fold-03-resume.log`, config `llm.config.sonnet.yaml`).

## 3a. Kimi leg (decompose fix validation + quota death)

- Post-fix foldv2 (commit 65d8d2c, `frozenEntryImports` threaded into `DecomposeInput`)
  rebuilt and verified in dist before launch.
- **Decompose PASSED: kimi planned `apps/api/src/app.ts`** (42 modules) — the exact
  obligation both pre-fix runs missed. Fix works for kimi: pre-fix 0/2, post-fix 1/1.
- Build then ran ~2.5 h into the `contract` phase and died on quota, verbatim:

```
Error: Build failed at phase "contract" after 3 attempts:
attempt 1: … "API Error: Request rejected (429) · you (qof_4) have reached your weekly
usage limit, upgrade for higher limits: https://ollama.com/upgrade …
```

- 4,269,540 in / 93,625 out (0 cached) · 9127 s. Top phase: interface-api-clock
  (2,422,733 in — a striking outlier for a Clock port interface).
- Quota attribution note: the config's active token is "Sarmad's", yet the 429 named the
  user (qof_4) — the local Ollama daemon's signed-in account is what's billed for
  `:cloud` models, not the YAML token.

## 3b. Model-pivot resume (the scenario under test)

Resume convention (from prior `*-resume.log` evidence): re-run the same `foldv2 build`
into the same workspace/build-dir; a new runId is minted; progress carries via the
per-build-dir content-addressed phase cache; toolchain install is skipped
("toolchain present").

**Finding — the phase cache does not survive a model switch.** The cache key embeds the
model id (`orchestrator/src/runPhase.ts:21`:
`sha256(\`${phase.name}@${phase.version}|${modelId}|${stableStringify(input)}\`)`), so
every kimi-era entry (including the validated decompose, and the `cacheable: true`
contract/implement tasks) missed, and Sonnet regenerated the design phases from scratch
(confirmed empirically: modules.json sha changed). The coordinator's expectation that
decompose would be reused is not satisfiable in current fold. Kimi evidence was
snapshotted first (sha `51772ceb…`) and survives in the immutable run-scoped dir.

- **Decompose fix, second model: Sonnet also planned `apps/api/src/app.ts`** (26 modules
  — a much leaner decomposition than kimi's 42; flat apps/ layout). Fix now 2/2 across
  models post-fix.
- **No observable model-switch friction**: Sonnet re-ran the full pipeline over the
  workspace containing kimi's partial contract-phase output without schema/format errors;
  the run proceeded through contract, implement, and 2 refine rounds.

## 3c. Sonnet leg outcome

- **Terminal state: ⚠ AWAITING DECISION (exit 2)** after 29,860 s (~8.3 h) — the first
  attempt in this series to reach a reviewable end state. 9 decision items, verbatim: 1×
  `vetting-escalation` (`ua-parser-js: license AGPL-3.0-or-later not in allowlist` —
  same library the June url-shortener-W1M run escalated), 1× `refine-stalled` (`refine
  round 2: gate failures did not decrease (18 → 18: smoke=1, vitest=10, ac-coverage=7)`),
  7× `ac-uncovered` (C1#7, C2#1, C2#3, C2#5, C3#4, C4#2, C4#7).
- Tokens: **149,423 in / 461,665 out / 27,760,792 cached (99% hit)** ·
  `claude-sonnet-5` via api.anthropic.com (subscription OAuth — a different quota pool
  than the exhausted ollama account; this is why the pivot could run at all). The 99%
  cache hit vs kimi's structural 0% is the starkest single number of the pilot.
- One new warning class: task token outlier (`test-services` 78,678 tokens, >3× median —
  absolute scale ~30× smaller than kimi-era outliers). 25 pattern-fragment budget
  advisories suppressed per reporting-threshold instruction (persistence-concurrency/core
  and time-series/persistence, cap 8000 bytes).
- Generated app state: compiles and largely tests green through refine, but 18 residual
  gate failures (1 smoke, 10 vitest, 7 ac-coverage) — review needed, not shippable as-is.

## 3d. Telemetry verification — the instrumented-pilot payload (FIRST REAL DATA)

Store: `<workspace>/.fold/.mast/graph.db` (analyzed on a copy; original untouched).
**89 rows · 12 sessions · all `status=ok`** · span 2026-07-18 19:43 → 07-19 09:37 UTC.
Era split (resume launched 01:26:57 UTC): **kimi 9 rows / 5 sessions · sonnet 80 rows /
7 sessions** — mixed-model store, segmented below.

### tokens_full_file_upper_bound (the historical constant-0 bug)

| tool | rows | ub>0 | fraction |
|---|---|---|---|
| mast_signature | 47 | 47 | **1.00** |
| mast_exports | 23 | 23 | **1.00** |
| mast_search | 7 | 6 | 0.86 |
| mast_project_skeleton | 12 | 9 | 0.75 |

**The fix is confirmed working.** All 4 zero-ub rows are legitimately empty payloads
(3 skeleton calls returning 1 token; 1 search with 0 results) — there is no file to
upper-bound. Every content-bearing row has a real positive upper bound. By era: kimi
5/9 (zeros = the empty rows), sonnet 80/80 = 1.00.

Efficiency-ratio spread (tokens_returned / upper_bound, rows with ub>0):

| tool | n | min | avg | max |
|---|---|---|---|---|
| mast_signature | 47 | 0.048 | **0.107** | 0.281 |
| mast_exports | 23 | 0.0004 | 0.449 | 0.846 |
| mast_search | 6 | 0.365 | 0.520 | 0.785 |
| mast_project_skeleton | 9 | 0.036 | 0.055 | 0.079 |

mast_signature's ~0.11 average = ~9× cheaper than reading the whole file — the first
measured (not assumed) efficiency figure for the flagship tool.

### args_json / results_json population

| tool | rows | args_json | results_json |
|---|---|---|---|
| mast_signature | 47 | 47 | 47 |
| mast_exports | 23 | 23 | 23 |
| mast_search | 7 | 7 | 7 |
| mast_project_skeleton | 12 | **0** | **0** |

100% for every parameterized tool; project_skeleton records neither (it takes no
meaningful arguments — worth confirming upstream that null-for-skeleton is intended
rather than a capture gap, since its results_json could still be populated).

### Per-tool call distribution by era

kimi (9): project_skeleton 8, search 1. sonnet (80): **signature 47, exports 23,
search 6, skeleton 4**. Chain behavior is strongly model-dependent, as the capsule
analysis predicted: kimi barely touched mast before dying; sonnet leaned hard on
signature/exports. Session mixes range from 1 call to 28 (11 signature + 17 exports,
0 search — a refine-phase session).

### Chain rates (the capsule-gate number)

Definition: for each mast_search row with results_json, a later mast_signature/
mast_exports row **in the same session**; LINKED additionally requires the later call's
args_json to name a symbol or file present in that search's results_json
(substring-tolerant, path-basename-aware matching; verified by hand on session 24c35549).

- **Loose chain rate (old, argument-blind): 3/7 = 0.43**
- **Linked chain rate (argument-aware): 0/7 = 0.00** · n = 7 searches (6 sonnet, 1 kimi)

The gap is the finding. Manual inspection shows why: sonnet works **signature-first** —
it already has symbol names from fold's interface IR context, calls mast_signature on
them directly, and uses mast_search afterwards for field-shape questions whose results
do not feed later tool arguments. The loose metric counted temporal coincidence as
chaining; the linked metric shows genuine search→refine chains were absent in this
run. n = 7 is small — a first data point, not a verdict — but it points the same
direction as the capsule analysis's skepticism.

### Caveats

1. n = 7 searches / 12 sessions / 1 spec / 2 models — directional only.
2. The fold BUILD path injects rich IR context, which suppresses search-led discovery;
   chain rates from this population may underestimate chaining in a context-poor
   update/reconcile setting (where the checker seam actually fires).
3. Timestamps have sub-second resolution and correctly order intra-session calls
   (verified: pre-search signature calls were not counted as follow-ups).
4. Era attribution is by timestamp (resume launch 01:26:57 UTC); session ids don't
   encode the model.

---

# Run 4 — plan-coverage seam validation run: killed mid-contract by an API connectivity outage; plan phase never reached

**Date:** 2026-07-19. Fresh workspace
`/Users/spikedpunchvictim/projects/kluster-workbench/apps/ab-fixes-sonnet-url-shortener-fold-04`,
log `…fold-04-build.log`, run id `09233777-cf49-4fce-beed-dfde6b75f20e`,
config `llm.config.sonnet.yaml` (claude-sonnet-5, api.anthropic.com, subscription OAuth).
Purpose: first live test of the committed plan-coverage seam fixes (plan module-coverage
obligation w/ prompt v3, DeclarationGate, empty-write quarantine — commit 8c6a35e).
Dist rebuilt and fix files verified present per-file before launch
(moduleCoverage.js, declarationGate.js, plan.js, buildPipeline.js all newer than src).

## Outcome

- **Status: failed (exit 1) at phase `contract` after 3 attempts — API connectivity,
  not quota and not a fold bug.** Verbatim (attempts 2 and 3 identical in kind):

```
Error: Build failed at phase "contract" after 3 attempts:
attempt 1: fold-runner exited 1: fold-runner: run failed: claude exited 1:
 …"result":"API Error: Unable to connect to API"… ("api_error_status":null)
```

- Wall 6,019 s (~1.7 h) · 42,234 in / 88,716 out / 3,588,779 cached (99% hit).
- Progress before death: classification/scaffold/install fine (same http-service +
  pattern set, 4th consecutive identical classification); decompose fine; **11 interface
  artifacts completed** (core-entities, core-errors, core-ports, core-result, 2 usecases,
  core-valueobjects, http-config, http-errorhandler, http-schemas, persistence-schema)
  before the network died mid-contract. 9 pattern-fragment advisories (suppressed class);
  no other warning classes; 0 quarantines.

## The asks vs what this run could answer

1. **Plan-coverage fix live test: NOT REACHED.** Plan runs *after* the contract phase in
   this pipeline; the run died mid-contract, so no plan.json exists and the coverage
   obligation was never exercised. No evidence either way about the fix.
2. **DeclarationGate / decision-packet comparison: NOT REACHED** (no verification ran).
3. **Telemetry:** store exists but tiny — **2 rows, 1 session, both mast_signature**,
   100% args/results populated, 100% ub>0 (ratios 0.05/0.06). No searches → chain-rate
   n = 0 this run. Consistent with Run 3's population insight: contract-phase sessions
   barely touch mast (rich IR context); the heavy usage came from implement/refine
   sessions, which this run never reached.

## Resume-relevant facts (for the next decision)

- The per-build-dir cache holds the completed design phases AND the 11 finished
  interface tasks with workspace-file snapshots (`cache/*:files.json`) — a SAME-model
  re-run into this workspace replays them and continues from the first unfinished
  contract task. (A model switch would again invalidate everything — runPhase.ts:21.)
- The failure is environmental ("Unable to connect to API", `api_error_status: null` —
  connection-level, not an HTTP rejection); nothing in fold or the fixes is implicated.
  fold's 3 retry attempts spanned ~15 minutes of the outage before giving up.

## Run 4b — authorized same-model resume: cache replayed, plan-coverage fix VALIDATED, first full build to AWAITING DECISION with real telemetry

**Date:** 2026-07-19 → 07-20. Same workspace, same sonnet config (no model switch, so the
cache survives). Log `…fold-04-resume.log`, continuation run id
`d61e057c-cb2f-496b-ace2-5d402eae930e`.

### Cache replay (verified)

- "toolchain present — skipping install" + a burst of **11 `per-task commit failed
  (non-fatal)`** warnings — one per cached interface task whose restored file was
  byte-identical to the workspace, so `git commit` found nothing to commit. This is the
  visible fingerprint of the replay: the 11 contract tasks finished in run 4a were
  restored from cache, not re-generated. (New warning class this run; 11 total, tallied.)
- No LLM re-spend on completed design/contract work: the run went straight into the
  remaining contract tasks and then implement. Cache did its job.

### Plan-coverage fix — VALIDATED (the headline)

`plan.json`: **27 tasks for 27 modules — 27/27 covered, zero uncovered.** Every module,
including the wiring modules that run 3 left implicit (http-app, http-routes,
http-config, http-adapters, http-middleware, persistence-database, persistence-migrations,
the service layer), is owned by a task. Contrast run 3's **7 tasks** for a comparable
module set. The v3 prompt + module-coverage obligation produced full ownership on the
first plan attempt (no coverage-violation rejection was needed — the plan was born
covered).

### Terminal state — AWAITING DECISION, 2 items (down from run 3's 9)

- 27/27 tasks implemented, 0 quarantined, `notVerified=false`, 2 refine rounds.
- Decision packet shrank from 9 → **2, both dependency-vetting escalations**:
  `ua-parser-js` (AGPL-3.0, as predicted) and `@pglite/kysely` (**package not found on
  registry** — sonnet named a non-existent package for the test Postgres). Run 3's 7
  `ac-uncovered` items and its `refine-stalled` item are **gone** — the ac-coverage gate
  now reports 0 failures, the direct downstream benefit of full plan+implement coverage.
- Tokens: 201,899 in / 583,575 out / **64,766,802 cached (99.7% hit)** · 32,859 s
  (~9.1 h) · claude-sonnet-5. 40 pattern-fragment advisories + 11 commit-failed + 2
  token-outlier warnings, all suppressed/tallied.

### DeclarationGate — fired; the one hit is a FALSE POSITIVE

- Gate result: **FAIL, 1 finding** — `apps/api/src/middleware/index.ts (line 42):
  unimplemented "declare" stub "fastify"`. Inspected directly: line 42 of index.ts is a
  real function (`extractBearerToken`), and the only `declare` construct anywhere in the
  shipped tree is the idiomatic **`declare module "fastify"`** request-type augmentation
  in the sibling `apps/api/src/middleware/fastify.d.ts` (adds `bearerToken`/`authProvider`
  to `FastifyRequest` — standard Fastify decorator typing). The gate's heuristic flags the
  `declare` keyword without distinguishing a module augmentation from a leftover
  declaration-only signature stub. **No real unimplemented stub survived** — a full-tree
  grep found none in source (the only `throw new Error("not implemented")` hits are inside
  `.test.ts` fakes). So implement coverage was genuinely complete; the DeclarationGate
  needs to exempt `declare module`/`declare global` augmentation blocks to avoid this
  false positive. (Filed as an observation, not fixed — run-manager mandate.)
- Note on the gate cascade: `tsc`/`smoke`/`vitest`/`deps` also fail, but the proximate
  cause is the two un-vetted, uninstalled dependencies (`@pglite/kysely` doesn't exist;
  `ua-parser-js` blocked) — code importing them can't compile or boot. These are
  downstream of the pending dependency decision, not independent quality defects. The
  build is legitimately AWAITING DECISION on those two escalations.

### Telemetry — the payload (pure sonnet; workspace-04 never touched by kimi)

Store: 159 rows · 17 sessions · all `status=ok` · span 2026-07-19 22:42 → 07-20 13:26 UTC.
No era segmentation needed (single model).

Upper bound (the historical constant-0 bug): **150/159 = 0.943 nonzero**; the 9 zeros are
empty payloads (skeleton/0-result). Per tool: signature 100 calls (94 ub>0), search 40
(38), exports 16 (16), skeleton 3 (2). **args_json/results_json: 100% populated on all
three parameterized tools** (signature 100/100, search 40/40, exports 16/16); skeleton
0/3 (no args — same as prior runs).

Efficiency ratio (returned / upper_bound, ub>0): signature avg 0.31, search avg 0.84,
exports avg 0.72, skeleton avg 0.06. A few ratios exceed 1.0 (signature max 2.32, search
max 1.54, exports max 1.39) — the "upper bound" is a full-file token estimate, and a
multi-symbol signature/exports result can legitimately exceed a single small file's size;
worth confirming upstream whether ratios >1 are expected or signal an estimate that
undershoots for barrel/multi-file results.

**Chain rates (n = 40 searches — ~6× run 3):**
- Loose (argument-blind: any signature/exports later in the same session): **15/40 = 0.38**.
- Linked (strict: a follow-up call's argument is exactly a `symbol_name` or `file_path`
  present in the search's results): **7/40 = 0.18**. All 7 are file_path chains (search
  returns a file, model then requests a signature/exports for that file); zero were
  symbol-name chains.

  *Methodology honesty:* an initial fuzzy matcher (substring, len≥4) reported 15/40 linked
  — it over-counted by matching incidental substrings; the strict symbol/file-exact
  matcher gives 7/40 and is the number to trust. Hand-verified all 7 are genuine
  search→lookup chains.

Interpretation: with a real n, the linked rate is **0.18 — well below the loose 0.38**,
confirming across both models that the argument-blind "loose" metric roughly doubles the
true chaining rate. It is *higher* than run 3's 0/7, but run 3's n was too small to
distinguish from zero; run 4's 7/40 is the first credible linked-chain estimate. Even so,
0.18 means ~82% of searches in a context-rich fold BUILD do **not** feed a subsequent
symbol/file lookup — consistent with the capsule analysis's skepticism that search-led
chaining dominates. Caveat unchanged: the BUILD path's rich IR context suppresses
search-led discovery; the update/reconcile path (where the checker seam fires) may chain
differently and is the population the capsule gate ultimately cares about.

### Net for the capsule decision

First end-to-end data point with a usable n: instrumentation is fully working
(upper-bound 94% nonzero, args/results 100%), tool mix is signature-dominated
(100/159), and **linked chain rate = 7/40 = 0.18** vs loose 0.38. Single spec, single
model, BUILD path — a real point, not the verdict.
