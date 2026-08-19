# HANDOFF — Q1 / M2 track, as of 2026-08-03 (post Q1/DECLEX RESULT, evidence `43c5c2d`)

> **SUPERSEDING SESSION STATE (2026-08-12, `6082361`): read
> [`HANDOFF_E1PHASE.md`](./HANDOFF_E1PHASE.md) FIRST.** E1 is complete and scored —
> **SUPER-LINEAR REGRESSION, `b = 1.7529`, HC3 CI [1.6599, 1.8458]** against the
> pre-registered 1.35 threshold — and **E1-PHASE is now RUN, scored and reviewed:
> outcome H1, the exponent is in the WRITE phase** (`b_write = 1.9685`, `b_parse = 1.0144`,
> write's share of the clock at T9 **94.01%**). It licenses *"write-localised, mechanism
> unidentified"* and nothing narrower. The §5 instrument-defect list and the §6
> methodological rules below remain in force unchanged — **§5 has two new entries from the
> E1-PHASE results review**; only the SESSION STATE section immediately following is stale.
> Baseline is now **796 tests / 52 files**. (The count this block previously carried,
> "728 tests / 50 files", was wrong in the file half: `6f46af5` measures 728 tests /
> **49** files.)

---

## ⚡ SESSION STATE (2026-08-11, paused mid-track) — resume here

**Committed this session:** `4eca05b` (D8 — the shipped sweep was not the running
tool) → `9b12159` (Q6 RESCOPE) → `35d9704` (results-review corrections; the WAL
withdrawal grounded in measurement) → `218fb0a` (D8a — `schema_version` on
`mast_status`) → `fbfce48` (session state + confirmed E1/E2 scope) → `1d63696` (D8
restart loop closed) → **the E1/E2 pre-registration**. Baseline: **629 tests / 45
files**, typecheck/lint/build clean, align 324→324 (+0). Tree clean for
`packages/mast`.

**Operator restart: DONE 2026-08-11.** `mast serve` was restarted and `mast_status`
returned `schema_version: "1.3.0"` — the field's mere presence is the proof, since the
pre-D8a binary omits it entirely. The D8 loop is closed end to end (rebuild → restart →
verified in-product). Index at that point: 1,830 files / 14,610 chunks, `stale_files:
0`, `index_fresh: true`. **No operator action outstanding.**

**E1/E2 PRE-REGISTRATION: WRITTEN AND COMMITTED 2026-08-11**, before any measurement,
per §6. It lives in IMPLEMENTATION_PLAN.md as the last Stage 4 block ("E1/E2 — the
scaling ladder and call-graph denominators: PRE-REGISTRATION"). The owner-confirmed
scope it encodes: all five rungs, E2 folded in on the same corpora and the same builds.
What it fixes, and what a resuming session must NOT re-decide:
- **Five pin SHAs**, committed with the registration. The remembered file counts (902 /
  2,047 / 3,600 / 7,021 / 12,641) have **no provenance in the plan** and today's
  checkouts give 1,059 / 2,153 / 4,895 / 7,645 / 19,056 — the x-axis is the count
  `runIndex` actually indexes at the pin, read from `graph.db`, never stdout.
- **Decision-bearing test, E1:** growth exponent `b`, exposure = **chunk count** (not
  files), threshold **b = 1.35** — the one figure unchanged across all three amendments.
  Sized to detect a quadratic regression, NOT to resolve b=1.0 vs b=1.2 — that limitation
  is registered. *(The original's BCa CI and 1.12 `N log N` figure are superseded — see
  AMENDMENTS 1 and 3: OLS+HC3 primary with a Webb wild-cluster sensitivity, `b_eff ≈ 1.10`
  over the amended 20× chunk span.)*
- **Decision-bearing test, E2:** §10.3.1's 60–80% band. *(The original's "all five rungs
  must miss" rule is superseded — AMENDMENT 1 made `nest` the sole decision-bearing corpus,
  AMENDMENT 3 softened a miss to NOT ATTAINED.)*
- **Gate 0 is the D8 gate** — build first, record `schema_version`, invoke the binary by
  absolute path, void any run whose version disagrees. Every `eval/*.mjs` imports from
  `../dist/` directly, so the harness carries D8's exact exposure.

**AMENDMENT 1 DONE (`c60cbbf`) — design review answered, registration revised in place.**
Twelve findings, every code claim verified against source before acceptance; five ran
toward the investigator's priors. **Two structural reversals, both owner-confirmed:**
- **E1's decision-bearing axis is no longer the five repos.** It is a seeded **nested tier
  ladder inside n8n** (T1⊂…⊂T5, seed 811) — Q1/SCALE's recipe, because five unrelated
  repos confound content with scale. The five repos are now a **replication panel that
  carries no verdict**. Escalation on AMBIGUOUS is more tiers/reps, **never** another
  corpus.
- **E2's decision-bearing corpus is `nest` @ `f7fffd6` alone.** §10.3.1's band is scoped to
  Fastify+DI and none of the five repos depends on fastify. P1–P5 are external validity and
  license no spec change.
Also amended: Gate 2 drops edge count (structurally impossible); BCa→OLS+HC3 + wild-cluster
sensitivity; fitted clock = `durationMs`, with a 10-run empty-corpus calibration for `c`;
Gate 3 = `max(5%, 500 ms)`, retakes capped at 2; R5 → 1,500 ms + per-corpus idle baseline,
T1 **and** T5, ≥400 calls; new Gate 6 fixes R3/R4/E2-before-R5 ordering.

**AMENDMENT 2 (`61e166d`)** added Gate 7 — known-answer scorer tests, in the normal suite
(`vitest.config.ts` already includes `eval/**/*.test.mjs`). Self-found: the registration
defined its decision-bearing test and registered nothing verifying the code that evaluates
it, which is the `ab-score.mjs` defect class.

**SECOND design review DONE (fable, against `61e166d`) → AMENDMENT 3 WRITTEN AND
COMMITTED.** 3 fatal + 9 material + 5 cosmetic, every code claim verified against source
first. **All three fatals were fix-induced** — none is present in `5b16b4d`; AMENDMENT 1's
repairs broke new ground, and two of the three sat inside passages AMENDMENT 1 explicitly
certified as "verified and unchanged." The registration block now carries the full
discharge table; do **not** re-derive it from this summary.

**What AMENDMENT 3 changed, in one paragraph.** The ladder is **9 rungs, cut on chunks** as
geometric fractions `f_i = 20^{−(9−i)/8}` of realized `C_total` (20× span, exactly even in
`ln N`) — FATAL-2 was that the rungs were *stated* in files and *cut* in chunks, and that
every published figure came from the raw-`find` anchor AMENDMENT 1 had itself disavowed.
Trigger 1 is re-derived onto **lack of fit** — `F(7,18)` at α = 0.05 on the adjusted fit,
jointly with a **5% endpoint-departure floor** benchmarked against `N log N`'s own 0.69%
curvature — because the old `ms/chunk` monotonicity trigger fired on the *expected healthy*
signature (FATAL-1). The prerequisite full-n8n build is now **run P0**, under Gates 0/1,
excluded from every fit, **with the peek declared** and neutralised by committing this
amendment before it runs (FATAL-3). Also: Webb 6-point weights + restricted/unrestricted
residuals + studentized CI; **both** σ ceilings published with the cluster-level one named
as honest (`σ_tier < 0.28`, vs `σ < 0.56` at run level); n8n dropped as panel rung P5;
E2's sub-60% consequence softened to **NOT ATTAINED**; R5 gets a corpus-derived payload, a
write-overlap requirement for scored calls, and an absolute 250 ms excess bar replacing the
vacuous 2× multiplier; **new Gate 1b** (re-derive the power analysis from the frozen
manifest) and **new Gate 8** (E2 harness fidelity — `extractFile` takes no `onCallSite`, so
E2 cannot ride a product build); Gate 7 extended with E1's own table, the point-estimate
killer, and trigger 1's cases.

**Arithmetic in the amendment was independently recomputed before commit** — fractions,
`Sxx` at both levels, both σ ceilings, the 5-rung counterfactual (`σ_tier < 0.165`, the
quantitative case for widening), `b_eff` across plausible `C_total`, the 2.853×/20× cost
multipliers, the 0.69% curvature benchmark, and the ≈13 t / 2.4× cost. All reproduce.

**Owner decisions already taken — do not re-ask:** 9 tiers (not 5, not 7); E2 stays `n = 1`
on nest with the softened consequence.

**THEN — build the instrument, then run. Nothing has been measured.** Order: pin the five
worktrees → **run P0** (full n8n) under Gates 0/1 → freeze the 9-rung manifest → **Gate 1b**:
re-derive and commit the reachability arithmetic from realized counts → commit scripts,
scorer and Gate 7's tests (Gate 5; **every script ships a working CLI entry point** — that
class has already recurred twice) → Gate 0 rebuild → calibration → the shuffled 42 runs →
R5 last per Gate 6. Then the adversarial **results** review.

**Carry this forward, it is the lesson with four data points behind it:** a repaired
registration is a **new** registration and inherits none of the old one's verification.
Re-certifying a passage as "verified and unchanged" while the passages around it move is
exactly how FATAL-1 survived a review that had already checked its arithmetic.

---

## ⚡ READ FIRST (2026-08-11) — the tool you are running may not be the code you are reading

**`pnpm -F mast build` is part of the verification baseline.** The installed `mast`
binary is a symlink into this repo's own gitignored `packages/mast/dist/`, and on
2026-08-11 it was found **three days and one schema version stale** (built 08-07 at
`1.2.0`; source was at `1.3.0`). Every agent session — including the MCP `mast_*`
tools — had been running a build that predated the entire 08-08..08-10 sweep: F5, F4,
F3, F10, M6, C1, F9 and D6's flags were in source and absent from the tool. Nothing
caught it because the whole baseline is source-level (`vitest` transforms TS, `tsc
--noEmit` emits nothing, `eslint src` and `align` read source) and `dist/` is
gitignored, so it never appears in a diff. See IMPLEMENTATION_PLAN.md's **D8 result**
for the full finding and why a product-level detector was rejected.

**Consequence for E1 and any future measurement:** an instrument driven through `mast
query` or the MCP surface measures whatever is in `dist/`, not HEAD. Rebuild and record
the built schema version in the registration's evidence before running any tier, or the
evidence is attributed to the wrong code version.

**Rebuilt and verified 2026-08-11**: `dist` at `1.3.0`; the `1.2.0 → wipe → full
reindex → 1.3.0` migration was exercised against a *copy* of the live state dir (never
race a live one across a schema change while a server holds it open); `mast metrics
--locks` and F5's qualified `Class.method` lookup both confirmed live on the rebuilt
binary. The live `.mast` has since migrated — `index.json` read `1.3.0` at
`2026-08-11T04:06:57Z` (1,830 files / 14,607 chunks).

🔴 **REBUILD ≠ RESTART — action outstanding.** A `mast serve` (PID 38988) started
**2026-08-10 17:08:03**, *before* the 18:58 rebuild, and still holds the live
`graph.db` open (5 fds). Node caches modules at startup, so it is executing the
**1.2.0 / pre-F11** image against a state dir that has since migrated to 1.3.0 — the
exact stale-code-vs-new-schema hazard §7.4's startup guard exists to prevent, which
the guard cannot catch because it only runs at startup. **Restart the MCP server
before trusting any `mast_*` result**, and pair every future migration with a restart.
Artifact evidence also settles what that binary contained: `dist/store/lock.js` was
re-emitted by the 18:58 build and F11 is the only commit that ever touched
`src/store/lock.ts`, so **the binary every agent used 08-07→08-10 was pre-F11** — the
post-F11 JIT topology has had almost no operational hours, which is why the Q6 RESCOPE
treats HEAD as unmeasured.

**Two facts surfaced in passing, both recorded in D8, neither fixed:**
- The M2 condition-5 organic harvest is **n = 0** — the `metrics` table held 11 rows,
  all predating the 08-07 clock start, none with `declex_json` set. The review fires
  n ≥ 67 or **2026-11-05**; on this trajectory it lands on n = 0.
- MAST_SPEC §14.3 claims batched metrics writes ("flushed every 1s or every 100 rows");
  `recordToolCall` is a direct awaited insert. Same spec-drift class as the
  `--session`/`--global` P3 item, and should be decided with it.

**First lock data from D6's summarizer** (`mast metrics --locks`; 680 `index-run`
cycles at last reading, count grows as runs accumulate): hold **p50 64 ms, p95 585 ms,
max 1,802 ms**, against round 2's 485–755 ms Arm B envelope on nest. That max sits
inside Q6's 1.7–3 s stall band. It is **unattributed** — a cycle is per *batch*, not
per run (`runIndex` takes `structure.lock` at four sites), so it is consistent with
bulk batch work, but round 1's own record links large batch holds to "WAL-checkpoint
stalls landing inside a batch transaction" and that is not excluded. The five largest
holds are 1,802 / 1,370 / 1,147 / 1,115 / 1,024 ms, and **#2 and #3 are isolated
single events on different days** — only #1/#4/#5 form the one burst. Cite it neither
as a surviving Q6 nor as dismissed; see the plan's Q6 RESCOPE block.

---

## ⚡ WORK QUEUE (2026-08-10) — refreshed after the remediation sweep; start here

The remediation backlog is CLOSED except E1. Stages 1, 2, 3, 3.5, 4.5-S1 and all of
Stage 4 except E1 are Complete (20 commits, `409ed59..1ce593f`; per-item result
blocks with red-first evidence live in IMPLEMENTATION_PLAN.md — that file is the
detailed record; this queue is only the pointer). What remains, prioritized:

**P1 — E1/E2, the scaling ladder + call-graph denominators (Stage 4)** — the only
open Stage 4 item and the only one with a formal ceremony. **Pre-registration WRITTEN
and COMMITTED 2026-08-11** (IMPLEMENTATION_PLAN.md, last Stage 4 block), so the §6
"registered before any run" obligation is discharged. Remaining ceremony: adversarial
**design** review (Agent tool, model "fable" — then verify its claims yourself),
in-place amendment, then build → run → adversarial **results** review. Five pinned
rungs (otel / langchainjs / strapi / backstage / n8n, SHAs in the registration); E2
rides the same corpora and the same builds via D7's `onCallSite` seam. See the SESSION
STATE block at the top for what the registration fixes and must not be re-decided.

**P2 — Stage 4.5 scale levers and Stage 5 open questions**: ~~Q6~~ **RESCOPED
2026-08-11 and no longer a standalone item** — round-1's stall signature is measured
absent, but that null is itself pre-F11 and round 1's own suspect is alive at HEAD, so
what remains (checkpoint cost at scale + a HEAD-topology probe under concurrent
readers) MOVED into E1; see the plan's Q6 RESCOPE block. Q2, Q3, Q5 unblocked;
E5 (`--checker` value); E6 (cross-language silent drop).

**P3 — small recorded decisions awaiting an owner**: MAST_SPEC §14.6 documents
`--session`/`--global` options `mast metrics` never implemented (found by D6,
recorded not fixed — implement or trim the spec), and §14.3 documents batched
metrics writes that `recordToolCall` does not implement (found by D8 — decide
both together, they are one spec-drift class); the D7 corpus oracle's
self-corpus distribution (866/2,155 ≈ 40% edge yield) is a baseline worth
re-recording after any extractor change.

**Standing obligations (do not let these pass):** the M2 condition-5 review —
organic harvest **n ≥ 67** or **2026-11-05**, whichever first (n = 0 then is itself
a finding forcing a monitoring re-decision); `metrics.declex_json` is the
accumulating signal. Any instrument reuse must first fix the §5 defects below. Do
NOT reopen the settled questions in §3 or the retired experiments — re-entry to
vectors goes through the tag + a fresh A-vs-C benchmark, per the memo. The
2026-08-07 note about `.claude/CLAUDE.md`'s stale "semantic + keyword" wording is
RESOLVED — the owner fixed it.

---

## ⚡ UPDATE 2026-08-10 — REMEDIATION SWEEP COMPLETE; what changed and what to know

Twenty commits (`409ed59..1ce593f`, 2026-08-07 → 2026-08-10) closed the backlog.
Verification baseline is now **627 tests / 45 files**, tsc clean, lint clean,
`pnpm align:check` **324→324 (+0)** (same 2 pre-existing non-mast violations —
still do not attribute them). **`CURRENT_SCHEMA_VERSION` is now `1.3.0`** (F5) —
any pre-existing state dir wipes and reindexes on first serve.

**Product-surface changes an agent will notice:**
- `mast query <tool> [json] [path]` exists (D0) — CLI parity with every MCP tool by
  construction (shared handlers via `registerAllTools`); the old throwaway MCP
  harness scripts under `~/temp/mast-bench/` are obsolete.
- Confidence signals are unified (C1; spec §9.0 table is the single reference):
  `stale` (stat-and-flag, mast_search/mast_implementors),
  `file_busy_returning_stale_cache` (JIT tools only), `index_empty` (M6),
  `potential_truncated` (F10), plus `resolution` gained `this_method`/`super_method`
  (F4). `mast metrics` gained `--json`, `--locks`, and p50/p95 columns (D6).
- JIT no longer touches `structure.lock` (F11): `populateFile` runs BEGIN IMMEDIATE
  with a dedicated 200ms busy_timeout; coarse writers keep proper-lockfile. The
  full option-(d) overlay remains DEFERRED per E7-r2 — do not build it without
  scale evidence (E1's n8n rung).
- Multi-row SQL is batched under the 32,766-parameter ceiling everywhere (S1,
  8 sites) — whale files index correctly now.

**Load-bearing decisions, briefly (full reasoning in the plan's result blocks):**
stat-and-flag (not refresh) for multi-file tools; identical-output-by-construction
for the CLI; whole-class fixes over named-site fixes (S1); narrow-role locking with
the overlay deferred on the record; honour-not-delete for init flags with a
path-portability picked-keys rule (persisted absolute paths must never merge back —
shared-volume hazard); two-part empty-state honesty (refuse only the
never-fillable combination); qualified identifier compounds derived from
already-computed edges (no parallel resolution mechanism); drop-don't-guess for
super_method resolution.

**Standing instruments added this sweep (use them, don't rebuild them):**
- D7's `onCallSite` diagnostics seam + self-corpus oracle (closed 4-outcome union;
  2,155 call sites / 866 edges baseline on mast's own src) — E2's hook.
- D3's `spec-conformance.test.ts` — spec↔code drift fails the suite; add one
  assertion per future finding.
- D4's `assertion-rule.test.ts` — `unknown[]`/bare-`unknown` response annotations
  in tests fail the suite unless allowlisted with a written reason.
- D6's `mast metrics --locks` + percentiles — the lock-hold and latency
  observability rows of the rescoped metric table.

**Process note for whoever manages sub-agents:** implementation was done by managed
sonnet agents with designs fixed up front by the managing session; every diff was
reviewed and independently verified before commit. Two agents stalled mid-task with
an off-topic final message while their working tree was fine (S1, F9) — inspect
`git status` before trusting a completion report, and resume the same agent with a
remaining-work checklist; both completed cleanly on resume. Red-first was enforced
on every behavioral change; where an honest red was impossible (D1's arbitrary
pre-fix ordering), the plan says so explicitly rather than claiming one.

---

## ⚡ WORK QUEUE (2026-08-07) — SUPERSEDED by the 2026-08-10 queue above; kept as the completion ledger

The Q1/M2 program is CLOSED (memo → F18 → deletion, Stages 6–7 complete). What remains
is the pre-M2 remediation backlog plus the memo's standing obligations. Plan stage
statuses were refreshed 2026-08-07 (Stage 2 complete; Q1 answered; Q4 moot; Q5
unblocked). Priorities:

**P0 — staleness honesty gaps (Stage 1, In Progress):**
- **F14**: `mast_signature` drops the busy flag when the symbol query returns 0 results
  (`signature.ts:55` vs `:76`) — a stale index reads as "symbol doesn't exist". Small. —
  **DONE 2026-08-07**
- **F7**: staleness stat-and-flag for `mast_search` / `mast_implementors`. —
  **DONE 2026-08-07**
- **F11**: advisory-locking redesign — E7 FALSIFIED fail-fast per-batch locking (X2:
  pure reader-vs-reader JIT traffic hits 35%/70%/88.5% JIT failure at N=2/4/8);
  urgency downgraded by E7-r2, design verdict unchanged. Read both E7 results in the
  plan before designing. — **DONE 2026-08-07**

**P0-adjacent — scale write correctness (Stage 4.5 S1, added 2026-08-07):** batch
`replaceChunksForFile`'s single multi-row INSERT (`sqliteChunkStore.ts:82`) —
SQLite's 32,766-parameter ceiling silently caps a file at ~2,979 chunks for
orchestration that gates on exit code only. — **DONE 2026-08-07**

**P1 — force multiplier first (Stage 4 sequencing note): D0**, the CLI query surface
(`mast query <tool> <json>`) — do it BEFORE Stage 3; it multiplies every verification
task and removes the A/B Bash-surface caveat. — **DONE 2026-08-07**. Then **Stage 3.5** (F8: skeleton call
costs ~28 s, 99% in the telemetry counterfactual — **DONE 2026-08-07**; F9: init flags parsed-and-ignored — **DONE 2026-08-08**;
M6: empty-state serve answers `[]` instead of failing fast — **DONE 2026-08-09**; C1: unify confidence
signals — **DONE 2026-08-09**) (Stage 3.5 complete) and **Stage 3** (call-graph: F3 await-unwrap — DONE 2026-08-09, F4 `this.`/`super.` resolution — DONE 2026-08-09,
F5 qualified names in `identifier_fts` — DONE 2026-08-09, F10 `potential_truncated` — DONE 2026-08-09) (Stage 3 complete).

**P2 — Stage 4 hygiene (D1, D6 — DONE 2026-08-10, D7, E1, D3–D5), Stage 4.5 scale levers, Stage 5 open
questions** (Q6 — the 1.7–3 s WAL auto-checkpoint stall — is the most user-visible;
Q2, Q3, Q5 unblocked, E5 `--checker` value, E6 cross-language silent drop).

**Standing obligations (do not let these pass):** the M2 condition-5 review —
organic harvest **n ≥ 67** or **2026-11-05**, whichever first (n = 0 then is itself a
finding forcing a monitoring re-decision); `metrics.declex_json` is the accumulating
signal. Any instrument reuse must first fix the §5 defects below. Do NOT reopen the
settled questions in §3 or the retired experiments — re-entry to vectors goes through
the tag + a fresh A-vs-C benchmark, per the memo.

---

## ⚡ UPDATE 2026-08-07 — VECTOR STORE DELETED; the M2 review clock is LIVE

Stage 7 (IMPLEMENTATION_PLAN.md) is complete and committed. The vector subsystem no
longer exists at HEAD: `mast_search` is lexical BM25 + declaration-exact (F18) under
RRF — L+D exactly as measured. `@lancedb/lancedb` / `@huggingface/transformers` /
`apache-arrow` removed; `mode` / `similarity_score` / embedding config keys / embedding
status fields removed; `hybridSearch` renamed `fusedSearch`; startup cleans orphaned
vector state; Docker model-prewarm steps (which would have BROKEN the image build
post-deletion) removed from claude-runner and fold-runner.

**Operational facts for any future session:**
- Verification baseline: **448 tests / 35 files**; align at 324→324 (+0 — the old +3
  was the deleted files' own unresolved specifiers).
- The pre-deletion system — vector arms, instruments, the H baseline — lives at git tag
  **`mast-pre-vector-delete`**. Five eval instrument test files are excluded by name in
  `vitest.config.ts` because their import chains reach deleted modules; do NOT re-enable
  them at HEAD, and do NOT "fix" their imports — re-entry checks out the tag.
- **The M2 memo condition-5 review clock started 2026-08-07 (deletion ship):** the
  re-entry review fires at organic harvest **n ≥ 67** or on **2026-11-05**, whichever
  comes first. Organic n = 0 at that review is itself a finding — the standing
  instrument has no data source — and forces an explicit re-decision of the monitoring
  plan. Do not let that date pass silently.
- `metrics.declex_json` is live and accumulating: D fire rate and window-displacement
  effects on real queries are queryable from `graph.db` (never open it
  `?mode=ro&immutable=1` — WAL-blind, §7 below).
- Known open item (user-owned): `.claude/CLAUDE.md` still calls `mast_search`
  "semantic + keyword discovery" — awaiting the project owner's one-line fix.

---

## ⚡ UPDATE 2026-08-06 — M2 DECIDED (delete), F18 SHIPPED; read this before the rest

The sections below describe the state as of 2026-08-03 and remain accurate as history.
What changed since:

1. **The M2 decision memo (§4a below) is WRITTEN, adversarially reviewed
   (SURVIVES-WITH-REQUIRED-CHANGES, all 7 changes applied; review verbatim at
   `eval/results/m2-memo-review.md`), COMMITTED, and ratified: arm D — delete the vector
   store, ship F18.** See IMPLEMENTATION_PLAN.md § "M2 DECISION MEMO (2026-08-04)" for
   the decision, its five confronted gaps, conditions, and re-entry criteria.
2. **F18 is productized (IMPLEMENTATION_PLAN.md Stage 6, complete 2026-08-06):**
   ranker D ported to `src/search/declex.ts` (primary arm only — the escape variant is
   NOT shipped, measured harmful); fused into `hybridSearch` as a third RRF input behind
   `MastConfig.declaration_exact_ranker` (default ON in product config; ABSENT-MEANS-OFF
   at the `HybridSearchConfig` layer so eval instruments reconstructing measured arms
   stay uncontaminated); D-fire telemetry persisted to the additive
   `metrics.declex_json` column (dual-fusion window diff — the kill-switch and
   re-entry-criteria input signal); Gate B fixtures promoted to a permanent regression
   suite (`src/search/__tests__/declex.test.ts`).
3. **Verification baseline is now 644 tests / 44 files** (was 597/41). align:check
   still red at the same pre-existing +3 baseline (324→327, "provisional") — unchanged
   by Stage 6; still do not attribute it to new changes.
4. **YOUR NEXT ACTION is the vector-store deletion stage (memo condition 4):** remove
   `@lancedb/lancedb`, `vectors.lance`, `embedder.ts`/`background-embedder.ts` + fork,
   `vectors.lock`, embed cache, model-weights Docker layer, seed Phase 2, the `mode`
   discriminator and cold-start ladder's embed half. AST/graph/FTS tools untouched.
   Post-delete search = L+D exactly as measured. The honest post-delete `mode` surface
   is an open product-design point (memo condition 4). The memo condition 5 review
   clock (organic harvest n ≥ 67 or 90 days, whichever first) **starts when the
   deletion ships** — schedule it then.
5. §4b's productization guidance below is now DONE; §5's defect list and §6's rules
   remain fully in force for any future instrument reuse.

---

You are taking over an evidence-first investigation in `packages/mast`. Branch `ui`, tree
clean, suite green. Read this file first, then `IMPLEMENTATION_PLAN.md`.

---

## 1. The question, and the state change this session

**Q1: is MAST's vector store justified at all, or does lexical BM25 suffice?** It gates
**M2** — Lance+IVF-PQ vs sqlite-vec, or deleting the vector store entirely, which drops a
91 MB dependency, a ~7 h embed, and 470 MB RAM at the 153k-chunk scale target.

**Q1's retrieval-level question is now effectively ANSWERED at registered scope.** What
changed this session: Q1/DECLEX — the declaration-exact ranker, freshly pre-registered after
Q1/IDFUSE's bag-ranker rejection — **ran and CLOSED the S-ident scale gap** (verdict
`DECLEX_GAP_CLOSED_HARM_UNTESTED`; see `IMPLEMENTATION_PLAN.md`, "Q1/DECLEX RESULT"). The one
thing that has kept vectors alive since Q1/SCALE — the S-ident scale caveat — is
**DISCHARGED**: lexical + declaration-exact (F18, WITHOUT the escape variant, which is measured
harmful) holds `in_window@10` flat T1→T4 on a fresh, never-scored 150-query set (efficacy over
plain lexical +14.67 pp [+9.33, +20.0]; decision-contrast Δ′ vs H not significant, all-n BCa CI
[−5.33 pp, 0]). **The M2 delete arm is RE-OPENED.**

**M2 is now the live decision**, and it must confront, explicitly, the gaps DECLEX scoped out
rather than discharged (§2 item 6, §4a):
- harm on identifier-free queries — UNTESTED at the primary construction (the realistic
  shipped-D harm surface, mixed-case prose mentioning non-target identifiers, lies outside
  every stratum);
- the S-prose T4 LEVEL gap vs H (92/100 vs 82/100) and the kluster-normal H−L baseline —
  unconfronted, and fresh-set descriptives point the same way (L+D −7.7/−7.25 pp below H
  off-stratum, seed-robust);
- generalization limited to symbol-shaped-token queries on this one corpus;
- the outcome-at-scale question — still **Reserve**, nothing measured here touches agent
  outcomes.

Commits: Q1/SCALE registration `80cb9bd` → AMENDMENT 1 `8420cac` → instrument `a313926` →
gates + scored evidence `8868404` → Q1/IDFUSE registration `8db1672` → AMENDMENT 1 `692f6f0`
→ instrument `3b0cc46` → gates + scored evidence `5a34b9b` → Q1/IDFUSE RESULT + AMENDMENT 2 +
handoff update → Q1/DECLEX registration `b90465b` → AMENDMENT 1 `f8af0da` → instrument
`b05f7ac` → gates + scored evidence `43c5c2d` → this commit (Q1/DECLEX RESULT + AMENDMENT 2 +
handoff update).

Do **not** skip to M2's A-vs-C backend benchmark without first writing the M2 decision memo
(§4a) — confronting the scoped-out gaps is now the gating step, not a benchmark run.

---

## 2. The state of the argument — four independent lines now converge

This is the single most important thing to inherit. Each was pre-registered before running.

1. **Q1/OUTCOME (the task-outcome A/B).** 30 runs, 12 tasks × 2 arms + 6 noise-floor.
   Hybrid vs lexical produced **byte-identical `(file, symbol)` answers on 12/12 tasks**,
   including every failure. b = 0, c = 0, McNemar p = 1.000. Effort non-significant on both
   metrics. Six queries were issued verbatim by both arms; **all six returned different
   ten-result windows (overlap 3–9 of 10) and every one led to the same answer.**
2. **Arm V (equalised).** The vector ranker *alone* is statistically indistinguishable from
   the shipped fusion on all three gold sets (V−H: |t| < 0.8 everywhere). The lexical half
   contributes nothing detectable on prose queries.
3. **Q4 (win-class labelling).** Hybrid's advantage is *flat* — no nameable query class
   carries it (short +0.125 vs long +0.130). And **only 2 of 59 gold queries across all
   three sets are identifier-bearing**: 97% of the ranking evidence base is prose.
4. **Q1/SCALE (the 153k rank scale-out, this session).** On the identifier-bearing stratum
   ONLY, lexical's `in_window@10` degrades more than hybrid's as the corpus grows 15k → 138k:
   direction confirmed at retrieval level, **+6.7 pp [+1.3, +11.3] CI**, hit-rule-sensitive
   between CONFIRMED (p=0.021) and AMBIGUOUS (p=0.096) depending on whether the AMENDMENT-1
   dedup-counterpart hit rule is applied. State the weight honestly: this is a marginal,
   identifier-stratum-specific, sub-materiality retrieval effect, not an established
   outcome-relevant one — S-approx (split-identifier queries) and S-prose show **no**
   significant scale differential. Mechanism verified in code: `hybridSearch`'s lexical path
   (`src/search/hybrid.ts`) ranks only via trigram `chunk_fts`; `identifier_fts` exists
   (`src/search/fts.ts`) but is consulted only for zero-result suggestions, never for ranking
   — exact identifiers get no exact-token lexical anchor and dilute with scale, while the
   vector arm anchors on the declaration embedding regardless of corpus size.
5. **Q1/IDFUSE (the identifier_fts fusion lever, this session).** Folding `identifier_fts`
   into RRF as an OR-bag ranker was the cheapest attack on item (4)'s mechanism finding — it
   **REJECTED as constructed**: INERT-LEVER (efficacy CI [−0.67, +4.67] pp; Δ′ significant the
   WRONG way, θ̂ = +7.33 pp, CI [+2.0, +12.67]) and independently harmful off-stratum (−7 to
   −12 pp, every tier, both non-identifier strata). **Weight it honestly**: this is one
   lexical construction failing, not lexical-in-general failing — the review's mechanism
   analysis projects a **declaration-exact** counterfactual (query token == the chunk's own
   `symbol_name`) at T4 S-ident **.98–.99** with **zero** off-stratum harm, against this run's
   L+I of .86 and H's .93. That projection is **post-hoc and unregistered** — selection risk
   applies, it is not evidence yet, only a reason the vector niche should not be treated as
   settled. Vectors' scale advantage survived its first lexical challenger; whether it survives
   a better one is untested.
6. **Q1/DECLEX (the declaration-exact ranker, this session).** Freshly pre-registered per item
   (5)'s Reserve promotion condition. Verdict `DECLEX_GAP_CLOSED_HARM_UNTESTED` on the FRESH,
   never-scored 150-query S-ident set (the original 400 re-score is descriptive-only, mined-
   from data — never verdict-bearing): efficacy PASS +14.67 pp [+9.33, +20.0] vs plain lexical;
   decision Δ′ vs H not significant, all-n BCa CI [−5.33 pp, 0], seed-invariant across 50
   alternative seeds; `in_window@10` flat T1→T4 (.9867 → .9867, the same 148 queries in-window
   at both endpoints). **Weight it honestly**: this closes the S-ident SCALE caveat
   specifically, not general harm-safety — both off-strata were HARM-NULL (D fire rate < 1%),
   so harm is UNTESTED, not disproven. Four caveats travel with the result and must not be
   dropped: (i) the escape variant (D+esc) is measured HARMFUL off-stratum at every cap and is
   not part of what closed — F18 ships WITHOUT it; (ii) the decision Wilcoxon's ns leg was
   statistically degenerate (146/150 ties, ~4 informative pairs) — closure rests on the
   seed-stable BCa upper bound of 0, not on the significance test; (iii) 23/148 (15.5%) of
   L+D's window hits are shell-counterpart credits, not exact-target retrievals — ".9867 > H"
   is not exact-hit superiority; (iv) the registered a-fortiori prediction (Δ′ −2..−4 pp)
   missed — observed −1.33 pp, plain CLOSED, milder than predicted — and the S-prose LEVEL gap
   vs H (92 vs 82 per 100) remains unconfronted.

**Joint conclusion: ranking metrics on prose gold sets cannot settle Q1, and the scale-out
does not settle it either — it narrows the caveat instead of discharging it.** Items (3) and
(4) of the old order [Q4, the harvest] are retired as sources of a verdict; the scale-out
(item 5 of the old order) is now measured and is ALSO retired as a further verdict source —
see §3. Do not re-open any of them hoping for one.

**The load-bearing mechanism, measured:** agents never search using the question's wording —
**0 of 147** logged searches did. They rewrite into code-token shorthand first. A reader who
can rephrase their own query is largely insulated from ranking quality. That is why rank
moved and outcomes did not.

---

## 3. Settled — do NOT re-run these

- **F15 (shipped):** FTS OR-join in `toFtsMatch` (`search/fts.ts`). Fixing one line more than
  halved the measured value of vectors. Lexical levers move these numbers a lot.
- **F16 is CLOSED. `rrf_k` stays 60.** Both hypotheses falsified under full embeds. Arm V's
  raw means briefly suggested reopening it; the paired CIs said no (|t| < 0.8). Do not
  reopen on a point estimate.
- **Identifier-decomposition Design Reserve: DISCHARGED.** Both registered constructions
  tested, both rejected on measured grounds. RESERVE-1 harmful (−0.1661, Recall 1.000→0.727,
  RRF vote-dilution); RESERVE-2 a measured null.
- **The shipped trigram tokenizer is doing real work.** W−L significantly *negative* on both
  kluster sets. **Do not "modernise" `chunk_fts` to unicode61.**
- **Authoritative ranking baseline** (`q1-final.mjs`, full embeds, paired CIs):
  kluster-normal H−L = 0.1669 [0.028, 0.306] SIG; kluster-anti 0.1313 [0.068, 0.195] SIG but
  **one-directional** (may kill vectors, never justify them); nest-external 0.1003
  [−0.058, 0.259] NOT SIG.
- **Counter-evidence to carry forward:** under a leave-one-out-selected lexical baseline,
  kluster-normal *loses* significance (t = 2.206 vs crit 2.228). The defensible claim is
  "the home-field result is not robust to the choice of lexical baseline," **not** "vectors
  are dead."
- **The 153k scale-out (Q1/SCALE, this session).** Pre-registered `80cb9bd`, adversarial
  design review `8420cac`, instrument `a313926`, gates + scored evidence `8868404`. Verdict:
  row 1, SCALE CAVEAT CONFIRMED (marginal — see §1, §2). **Do not re-run this hoping for a
  cleaner verdict.** The registered escalation path on an AMBIGUOUS-adjacent result is
  "increase n," never "reinterpret" or "re-score" — and this result is not AMBIGUOUS, it is a
  hit-rule-sensitive CONFIRMED with an honestly marginal magnitude. The marginal result is
  what it is; treat a request to re-run it as a sign the reader wants a different answer, not
  a more accurate one.
- **IDFUSE-as-constructed (Q1/IDFUSE, this session).** Pre-registered `8db1672`, AMENDMENT 1
  `692f6f0`, instrument `3b0cc46`, gates + scored evidence `5a34b9b`. The OR-bag
  `identifier_fts` ranker folded into RRF is **REJECTED on measured grounds**: INERT-LEVER on
  the decision-bearing contrast, AND −7 to −12 pp harm at every tier of both non-identifier
  strata. **Do not re-propose the bag construction** (whole-identifier-bag OR-join, unicode61,
  no field boost) — it is a tested and rejected mechanism, not an unexplored one. The
  mechanism analysis behind the rejection is what motivates the **declaration-exact** variant
  in §4 — that variant is a different construction (field-boosted to the chunk's own
  `symbol_name`), not a re-run of this one.
- **DECLEX-as-constructed (Q1/DECLEX, this session).** Pre-registered `b90465b`, AMENDMENT 1
  `f8af0da`, instrument `b05f7ac`, gates + scored evidence `43c5c2d`. Verdict
  `DECLEX_GAP_CLOSED_HARM_UNTESTED` — the declaration-exact ranker (F18, WITHOUT escape) closes
  the S-ident scale caveat on the fresh set. **Do not re-run this hoping for the registered
  a-fortiori prediction** (Δ′ ≈ −2..−4 pp) — the observed −1.33 pp plain CLOSED is the honest,
  seed-robust result; a request to re-run it is a sign the reader wants a different answer, not
  a more accurate one. **Do not ship, or re-test, the escape variant (D+esc) without a new
  registration** — it is measured harmful off-stratum at every cap (cap 20 s_prose
  −13.5 pp [−19.75, −8.25]; every cell excludes 0 in the harmful direction). **The bag
  construction (Q1/IDFUSE's OR-bag `identifier_fts` fusion) stays rejected** — DECLEX does not
  reopen it; DECLEX is a different, symbol-gated declaration-exact construction.

---

## 4. YOUR NEXT ACTION — the M2 decision memo

**Both lines that were live at the top of this file are now resolved as measurement.** The
153k scale-out (§3) and the identifier_fts fusion lever (§3) were done and rejected last
session; **Q1/DECLEX (this session) ran and CLOSED** the remaining live line — see §1, §2 item
6, §3. **Nothing under this heading is a new measurement task.** The next action is a
decision, not an experiment.

### (a) Write the M2 decision memo — do this first

Confront, explicitly and in writing, each gap DECLEX left scoped out rather than discharged
(§1's list, §2 item 6's four caveats):
- the S-prose T4 LEVEL gap vs H (92/100 vs 82/100) and the kluster-normal H−L baseline —
  unconfronted by DECLEX, which tested D_loss scale only;
- the harm-untested surface — D fired on < 1% of both off-strata, so identifier-free /
  mixed-case-prose harm (the realistic shipped-D exposure) has never been measured;
- the outcome-at-scale question — still Reserve, unmeasured;
- the 15.5% counterpart-credit composition and the symbol-shaped-token-only generalization
  limit.

Then choose, on the record:
- **delete** — ship F18 (ranker D, WITHOUT escape) and remove the vector store, accepting the
  scoped-out gaps as an explicit bet; or
- **keep-architecture** — the vector store stays justified, and M2 proceeds to its own
  question: Lance+IVF-PQ vs sqlite-vec vs a late-embedding architecture (standing Design
  Reserve entries).

### (b) If delete is chosen

F18 productization (ranker D in shipped `hybridSearch` + a config flag) ships with its own
regression suite — Gate B's fixtures (dotted `Class.method` segment match, camelCase full
match, case-insensitivity, the high-multiplicity-segment ordering fixture) become the
regression baseline, not throwaway instrument tests. **Any escape-like extension (the
lowercase-token recovery variant) requires a fresh pre-registration** — it is measured harmful
as constructed and does not ship on this evidence.

**The organic harvest remains the only instrument for real-query evidence** (unchanged from
before this session) — every stratum in this program, including Q1/SCALE's and Q1/DECLEX's
S-ident/S-approx/S-prose, is synthetic/TSDoc-derived, not agent-authored. If M2 chooses
keep-architecture, the harvest is still the standing gap to close on real queries eventually.

**Reserve (pre-thought, NOT commitments, carried from before plus Q1/SCALE's own reserve):**
a `--no-embeddings` container A/B; shipping D0 (a real `mast search` CLI) so the A/B harness's
Bash-surface caveat disappears; a fifth tier at ~30k if the dose–response curve needs
resolution between 15k and 50k; the directory-based tier partition as a sensitivity analysis;
multi-seed T1 sensitivity.

---

## 5. Known defects — fix before any repeat, do not grade around them

- **Harvester/prompt mismatch (confirmed, `eval/ab-agent-prompt.md`).** The agent prompt asks
  agents to "find the code this describes"; `ab-build-tasks.mjs:88-104` grades against the
  *first uniquely-resolving backticked identifier* — a symbol the line *mentions*, not the
  one it is *about*. This made T01/T04/T06 false failures. Align one to the other and
  pre-register a referent-ambiguity rule. (`b = c = 0` is unaffected — both arms gave
  identical answers, so no regrading can create a discordant pair.)
- **`ab-score.mjs` never implemented Wilcoxon** (registered as co-primary B's primary test);
  it used a sign test on *total* calls instead of calls-to-first-sighting. Both corrected in
  AMENDMENT 3; implement Wilcoxon before reusing the scorer.
- **McNemar:** the registration's worked example is one-sided, the implementation two-sided.
  Moot at b = c = 0; fix the registration text before the next run.
- **`hybrid.ts:55`** defaults `chunkStore` to the RETIRED Lance chunk table. Any new caller
  omitting it gets zero results with no error. Always pass it explicitly.
- **`hybrid.ts:102-104`** swallows embedder failure and silently returns `mode: "lexical"`.
  Any hybrid-arm harness must assert `mode` per call or it can decay mid-experiment.
- **`runSelfCheck` (Q1/SCALE instrument) under-counts its own mismatch tally** — it excludes
  reconstruction failures and mode-integrity failures from the count it reports. Gate 2's
  reported 80/80 relied on a wider criterion computed externally by the runner, not by the
  instrument itself. Fix `runSelfCheck` to count what Gate 2 actually requires before reuse.
- **`scale-rank-check.mjs` and `scale-score.mjs` ship with no working CLI entry points** for
  the scored sweep / self-check / scorer their own header comments document. The working
  invocation is the three runner-authored driver scripts committed at `8868404`
  (`scale-run-selfcheck.mjs`, `scale-run-measure.mjs`, `scale-run-score.mjs`) — use those, not
  the instrument files directly, until CLI entry points are added.
- **`RESULTS_DIR` in `eval/paths.mjs` resolves to `~/.cache/mast-eval/results/`, not the
  repo's `eval/results/`.** `scale-embed-tiers.mjs`'s Gate 0(c)/(d) output writes there by
  default; it was copied into `eval/results/` by hand for the committed record. Any script
  that imports `RESULTS_DIR` from `paths.mjs` needs its output copied in the same way, or the
  gate evidence silently lives outside the repo.
- **`sqliteChunkStore.replaceChunksForFile` (`src/store/sqliteChunkStore.ts:55-70`) issues one
  unbatched multi-row `INSERT`** for all of a file's chunks. At 11 columns/row, SQLite's
  32,766-parameter ceiling caps a single file at ~2,979 chunks; a larger file's insert rolls
  back **entirely** — loud (`write_errors` increments, CLI exit code 1), not silent, but
  **orchestration that gates only on exit code and not on `write_errors` would still silently
  drop the file's chunks.** Found via vscode's two whale fixture files (146,620-line and
  11,190-line). Not fixed in this program — batch the insert before trusting a corpus with
  files anywhere near that size. [FIXED 2026-08-07 — Stage 4.5 S1; batched under the
  parameter ceiling, whole class: chunks/symbols/imports/fts/edges + insertEdges
  IN-lists]
- **`idfuse-score.mjs` ships with no CLI entry point** — the `scale-rank-check.mjs`/
  `scale-score.mjs` defect class (above), **second occurrence**, despite the builder brief
  requiring working CLIs. The working invocation is the runner-authored
  `eval/idfuse-run-score.mjs`, not the instrument file directly (line-level clean per the
  results review, orchestration only). **Treat this as a class, not a one-off** — fix it
  before authoring any third scoring instrument.
- **`scoreIdfuse` does not wire consistency-trigger-3 (monotonicity) into `evaluateVerdict`.**
  Moot on the INERT-LEVER path (trigger clauses attach only to CLOSED/SURVIVES); latent gap if
  a future run on this instrument reaches CLOSED or SURVIVES. Fix before reuse.
- **The probes/probe key mismatch the Q1/IDFUSE builder logged**: `scale-queries.json` keys
  the probe stratum as `"probes"` (plural) while every `ResultRow`/CLI-facing label uses the
  singular `"probe"` (`validateResultRow`'s stratum enum). `idfuse-rank-check.mjs` maps this
  explicitly (`jsonKey = stratum === 'probe' ? 'probes' : stratum`) — any new script reading
  `scale-queries.json` by naive key needs the same mapping or it silently resolves an empty
  query list.
- **`eval/e7-round2.json`'s P3 narrative call counts do not reconcile with its own per-N
  tables** (found 2026-08-11 by the Q6 RESCOPE's adversarial review).
  `prediction_verdicts.P3_wal_checkpoint_stalls` states "2,367 Arm A + 5,340 Arm B";
  the per-N tables sum to **3,000** and **4,800** (non-busy subsets: 2,741 / 4,340).
  No split reconstructs the narrative figures. The zero-outlier verdict is unaffected —
  `arm_A_no_reindex.variance_note` independently reports 0 at every N — but **cite the
  per-N tables, never the P3 prose numbers**, and treat this as another instance of the
  §5 class "the summary field and the data disagree".
- **`declex-score.mjs` omits the registered esc-arm harm contrast from its output** — it emits
  only fire rates + a match-count distribution for the escape sweep (`computeEscapeCapSweep`,
  `declex-score.mjs:488-507`), not the registration's promised "reported descriptively in its
  place" harm contrast for when both off-strata are HARM-NULL. The adversarial results review
  computed it by hand with the registered per-query block bootstrap — every cell came back
  harmful (see §2 item 6, caveat i). **Fix the scorer to emit this contrast natively before
  reusing the instrument.**
- **`e1-phase-run.mjs`'s VOID queue has no dequeue** (found 2026-08-12 by the E1-PHASE
  results review, RR6). A Gate P or Gate P2 VOID is journalled and the pair *is* correctly
  re-run on the next invocation — but `loadJournal` keeps the void record in its map
  forever, so `summarise`'s `voids.size === 0` clause leaves `scoreable` **permanently
  false** once any run has ever voided, even after the re-run succeeds. A4-MAT-7 calls this
  a "re-run queue"; nothing dequeues it. **Unexercised on the E1-PHASE data (0 voids), so it
  contaminated no result — fix before any reuse.** `e1-run.mjs` shares the pattern and
  should be checked with it. Note this is the *opposite* failure to E1's `scoreable` flag
  being too strict on Gate 3 findings: one flag, two independent defects.
- **`fitSeries` reports spurious precision on millisecond-quantized series**
  (E1-PHASE results review, RR4). It fitted the unattributed remainder over values spanning
  **1–14 ms**, and a ±1 ms perturbation moves that exponent across **0.37–0.79** — wider
  than the HC3 interval it printed. The qualitative reading (sub-linear, share falling) is
  robust to every perturbation; the point estimate and its interval are not. **A series
  whose values approach the clock's resolution needs the caveat emitted by the scorer, not
  added in prose afterwards** — the E1-PHASE RESULT had to add it by hand.

---

## 6. Methodological rules — non-negotiable, learned the hard way here

- **Pre-register in `IMPLEMENTATION_PLAN.md` and commit the registration BEFORE running**,
  including falsification criteria. Amendments are appended with a timestamp, a reason, and
  **which direction the error ran**.
- **Report confidence intervals, not point estimates.** This has now caught two false leads
  (an "external replication" 9× smaller than its own SE; arm V appearing to beat H).
- **A result that flatters the thing you are testing deserves MORE scrutiny.** Multiple
  verdicts here were harness artifacts, all found by asking "is this too clean?"
- **"Reports success wrongly" is severity zero.** Hunt the whole class, fix together, codify
  an invariant.
- **Check the artifact, not its neighbour.** Four errors in this program came from grading
  against the wrong artifact.
- **Validate any reimplemented pipeline against the shipped one before believing new arms**
  (`q1-reserve2.mjs` self-check, 0 mismatches — reuse it).
- **Commission an adversarial review, of the design AND of the results.** Use a Fable agent
  (`Agent` tool, `model: "fable"`). On the design it caught a fake-null path, broken
  blinding, and a decision rule firing at p ≈ 0.27. On the results it caught five errors,
  **four of which ran in the investigator's own favour**. Verify its claims — it has been
  wrong before, and it withdrew several of its own findings on checking.

---

## 7. Operational

- **Run every script from `packages/mast`**, never the repo root.
- **Verification baseline is `test` + `typecheck` + `lint` + `align:check` + `build`.**
  The first four are source-level and cannot see the artifact agents actually run;
  `pnpm -F mast build` refreshes the gitignored `dist/` the installed `mast` binary
  symlinks to. Omitting it is what produced the D8 finding (2026-08-11).
- **`build` is not enough on its own — restart `mast serve` too.** Node caches modules
  at startup, so a running server keeps executing the image it booted with no matter
  what `dist` now holds (D8: PID 38988 ran the 1.2.0/pre-F11 image for hours after the
  rebuild, attached to a 1.3.0 index). Pair any rebuild or schema migration with a
  server restart before trusting `mast_*` output.
- **Copy `graph.db` + `-wal` + `-shm` together** when snapshotting a state dir for
  analysis. Copying only the `.db` silently drops WAL contents — the same class of trap
  as `?mode=ro&immutable=1` below, and the `ab-state` snapshot in `eval/ASSETS.md`
  documents it costing a session a false "the write path is broken" conclusion.
- **A large `graph.db-wal` is a high-water mark, not a backlog** (measured 2026-08-11,
  Q6 RESCOPE): passive checkpoints reset and reuse the file without truncating it, and
  a single large transaction produces an oversized WAL with no reader and nothing
  deferred. To read actual backlog use `PRAGMA wal_checkpoint`'s columns, and note the
  reader-block signal is `checkpointed < log`, **not** `busy` (which stays 0).
- **Off-repo assets: see `eval/ASSETS.md`** — what each contains, which experiment needs it,
  rebuild cost. ~590 MB of embedded state (pre-Q1/SCALE assets) = ~45 min compute; the
  Q1/SCALE vscode assets add substantially more — see `ASSETS.md`'s new entries (~7.4 h embed
  measured for the full corpus). Remove worktrees with `git worktree remove`, never `rm -rf`.
  `~/.cache/mast-eval/ab-wt` (1.5 GB) is disposable.
- **Never** open `graph.db` with `?mode=ro&immutable=1` for metrics reads — WAL-blind,
  reports `metrics` as empty. This cost a session a false conclusion.
- `MAST_EVAL_STATE` required by nearly every script; `MAST_EVAL_R2=1` required by
  `build-corpus.mjs` or you rebuild the void v1 corpus.
- **Evidence is committed** under `eval/results/` — all 30 Q1/OUTCOME run outputs, the
  147-call search log, the sealed arm manifest, all Q1/SCALE gate + measure + score JSON, the
  Q1/SCALE results review, `idfuse-gateA-selfcheck.json`, `idfuse-gateD-reproducibility.json`,
  `idfuse-measure-raw.json` (8,000 rows), `idfuse-score-output.json`,
  `q1-idfuse-design-review.md`, `q1-idfuse-results-review.md`, and (this session)
  `declex-gateA-selfcheck.json`, `declex-gateA-smoke-t1.json`, `declex-reproducibility.json`,
  `declex-measure-raw.json` + its fresh/original/esc-cap variants (19,200 rows total),
  `declex-score-output.json`, `q1-declex-design-review.md`, and
  `q1-declex-results-review.md`; the instrument itself lives under `eval/`
  (`declex-build-queries.mjs`, `declex-queries.json`, `declex-rank-check.mjs`,
  `declex-ranker.mjs`, `declex-score.mjs`). `eval/README.md` is STALE.
- Verification baseline: `pnpm -F mast test` → **597 tests / 41 files** (was 505/38 before
  Q1/DECLEX); `typecheck`; `lint`; `pnpm align:check`. **align reports red at +3 baselined
  debt (324→327) — PRE-EXISTING**, identical at `99c02ae`, self-reported "provisional". Do
  not attribute it to your changes.
- Session commits: `3a26e71` (registration) → `6319161` (instrument+gates) → `cffd467`
  (outcome) → `eb65b8c` (AMENDMENT 3) → `46f6bf8` / `446cc96` (arm V) → `4ae97db` (prompt
  record + evidence) → `b33dcc7` (Q4 + assets) → `70cf239` (cold-start handoff) → `80cb9bd`
  (Q1/SCALE registration) → `8420cac` (Q1/SCALE AMENDMENT 1) → `a313926` (Q1/SCALE instrument)
  → `8868404` (Q1/SCALE gates + scored evidence) → `8db1672` (Q1/IDFUSE registration) →
  `692f6f0` (Q1/IDFUSE AMENDMENT 1) → `3b0cc46` (Q1/IDFUSE instrument) → `5a34b9b` (Q1/IDFUSE
  gates + scored evidence) → Q1/IDFUSE RESULT + AMENDMENT 2 + handoff update → `b90465b`
  (Q1/DECLEX registration) → `f8af0da` (Q1/DECLEX AMENDMENT 1) → `b05f7ac` (Q1/DECLEX
  instrument) → `43c5c2d` (Q1/DECLEX gates + scored evidence) → this commit (Q1/DECLEX RESULT
  + AMENDMENT 2 + handoff update).

---

## 8. Two things I would flag about this handoff

It leads with the **state change** section rather than a fresh open question, because the
biggest risk to you is re-opening Q4, the harvest, the scale-out, the identifier_fts OR-bag
lever, or DECLEX itself, hoping for a cleaner verdict. All are retired as verdict sources — Q4
and the harvest structurally, the scale-out and the OR-bag lever because they are measured and
resolved (marginal-CONFIRMED / REJECTED, §3), and DECLEX because it is now measured and CLOSED
(harm untested) at registered scope. The only live line left is §4's M2 decision memo — a
synthesis of what is already measured, not a new experiment.

It carries the **counter-evidence prominently**, so the memo in §4a does not have to go
digging for it. Carry-forward flags, one line each:
- **Pro-delete:** the DECLEX closure itself — efficacy +14.67 pp [+9.33, +20.0],
  `in_window@10` flat T1→T4 on the fresh set, decision-contrast CI upper bound exactly 0,
  seed-invariant across 50 alternative seeds — plus the mechanism-verified, review-confirmed
  construction (48/48 end-to-end reconstructions exact; the F-R2 projection's zero divergence
  delta on the original-400 re-score is mechanism-explained, not a same-code-path artifact).
- **Anti-delete:** the S-prose T4 LEVEL deficits vs H, seed-robust (s_approx −7.67 pp
  [−13.0, −3.17], s_prose −7.25 pp [−13.5, −2.75]); the harm-UNTESTED surface (D fired on
  < 1% of both off-strata — the realistic shipped-D exposure, mixed-case prose mentioning
  non-target identifiers, has never been measured); the 15.5% counterpart-credit composition
  (23/148 of L+D's window hits are shell credits, not exact-target retrievals); and the
  outcome-at-scale question, which retains its Reserve standing regardless of how DECLEX
  landed.

This program's failures have all been biases favouring a conclusion someone already held. An
inherited summary that buried the anti-delete flags to make the delete decision easier would
recreate exactly that.
