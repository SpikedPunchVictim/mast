# Stage 2.1 — Evidence Baseline: Does the search → signature/exports Chain Occur?

**Date:** 2026-07-15 (v2 — extended same day with the kluster-workbench pool)
**Plan:** `IMPLEMENTATION_PLAN_VEXP.md` Feature 2 / Stage 2.1

**Verdict (v2, supersedes v1): INDETERMINATE for promotion — the loose
upper-bound chain rate clears the 10% gate on the workbench build pool
(21.36%) and combined (19.58%), but the tight (result-linked) chain rate the
plan actually gates on is not derivable from the shipped telemetry schema.
Missing instrumentation is named in §2. The v1 kluster-repo-only DEMOTE is
preserved below as Pool A for provenance; it was an artifact of an incomplete
data inventory.**

Read-only analysis; nothing under `packages/mast/src/`, the plan file, or
`FABLE_FEEDBAK.md` was touched. Script: `aggregate.mjs` (throwaway, imports
`better-sqlite3` — an existing mast dependency — directly against real
`graph.db` files, `readonly: true`). Raw aggregates: `results.json` (per-pool
and combined).

## 0. Version history (do not collapse — the correction is the finding)

- **v1 (earlier today):** inventory covered only the kluster repo (Pool A: 24
  non-empty stores, 126 rows, 46 sessions). Loose chain rate 6.52% → mechanical
  DEMOTE.
- **v2 (this version):** the coordinator surfaced
  `/Users/spikedpunchvictim/projects/kluster-workbench/apps` — real agent
  build sessions (a0-*, align-*, echo-*, study-intake-*, ecommerce,
  file-vault), each with a `.fold/.mast` state dir, built with recent builds
  of the same mast source (the global `mast` binary npm-links to
  `packages/mast/dist`, so the §2 schema ground truth applies unchanged).
  Pool B is ~16× larger than Pool A and flips the gate. The v1 verdict was
  measured correctly on the data it saw; the data it saw was incomplete.

## 1. Data inventory

### Pool A — kluster repo (v1 inventory, preserved verbatim)

Searched the repo (excluding `node_modules`) for every `.mast` state dir; 91
exist, **24 contain metrics rows**.

| Store | Sessions | Rows | Span | Tools seen |
|---|---|---|---|---|
| `/.mast` (repo root, interactive dev) | 10 | 24 | 2026-06-02 → 2026-07-11 | search, exports(1), implementors(1), project_skeleton |
| `packages/workbench/sdd/apps/kluser-kinetic-01/.kluster/.mast` | 14 | 58 | 2026-05-14 → 2026-05-15 (~9.3h) | search, signature(3), exports(2), project_skeleton |
| 22× `packages/workbench/sdd/apps/{fold-echo-test,fold-echo-test-2}/.build/**/.kluster/.mast` (per-task-role ephemeral) | 1 each | 1–4 each (54 total) | 2026-06-01 – 2026-06-03 | search only, or search + project_skeleton |

**Pool A totals: 126 rows, 46 sessions, 2026-05-14 → 2026-07-11.** Tool
counts: search 104, project_skeleton 15, exports 3, signature 3,
implementors 1, callers 0, dependencies 0.

### Pool B — kluster-workbench builds (v2 addition)

`find /Users/spikedpunchvictim/projects/kluster-workbench/apps -maxdepth 4
-path "*/.mast/graph.db"` → 19 stores, **11 with metrics rows** (echo-glm52-01,
a0-glm-01, fold-url-shortener-02, study-intake-05/06/07, notify-worker-W1,
url-shortener-W1M empty). Every store also carries a populated `metrics_daily`
roll-up table (1–8 rows each), noted per §14.3/§14.4 — the roll-up path runs
in these builds.

| Store | Sessions | Rows | Span | signature | exports | search | skeleton | deps | callers |
|---|---|---|---|---|---|---|---|---|---|
| align-kimik27-01 | 78 | 560 | 2026-07-12 | 223 | 132 | 117 | 81 | 6 | 1 |
| align-kimik27-02 | 85 | 501 | 2026-07-14 | 242 | 80 | 94 | 80 | 4 | 1 |
| a0-minimax3-01 | 48 | 323 | 2026-07-10→11 | 142 | 60 | 80 | 41 | 0 | 0 |
| align-kimik27-03 | 58 | 291 | 2026-07-15 | 92 | 42 | 77 | 69 | 9 | 2 |
| a0-deepseekv4flash-01 | 24 | 91 | 2026-07-11 | 43 | 4 | 29 | 15 | 0 | 0 |
| a0-sonnet-01 | 14 | 89 | 2026-07-09 | 49 | 20 | 14 | 6 | 0 | 0 |
| a0-kimik27-01 | 14 | 61 | 2026-07-11→12 | 31 | 10 | 5 | 15 | 0 | 0 |
| echo-kimi-01 | 13 | 58 | 2026-07-09→10 | 21 | 13 | 22 | 2 | 0 | 0 |
| ecommerce-W1 | 1 | 10 | 2026-06-25 | 0 | 8 | 0 | 2 | 0 | 0 |
| file-vault-W1 | 1 | 5 | 2026-06-24 | 0 | 3 | 1 | 1 | 0 | 0 |
| study-intake-02 | 1 | 1 | 2026-06-19 | 0 | 1 | 0 | 0 | 0 | 0 |

**Pool B totals: 1,990 rows, 337 sessions, 2026-06-19 → 2026-07-15.** Tool
counts: **signature 843 (42.4%)**, search 439 (22.1%), exports 373 (18.7%),
project_skeleton 312 (15.7%), **dependencies 19 (1.0%)**, **callers 4 (0.2%)**.

**Combined: 35 stores, 2,116 rows, 383 sessions, 2026-05-14 → 2026-07-15.**

**Population note (matters for interpretation):** Pool B sessions are
automated SDD/fold build-pipeline agents; Pool A is mostly interactive dev
plus tiny per-task ephemeral indices. The tool-usage profile inverts between
pools: interactive usage is search-dominated (104 of 126 calls), build agents
are **signature-dominated** (843 of 1,990 — `mast_signature` is their single
most-used tool, ahead of search). A capsule tool would serve both populations;
the chain behaviour differs sharply between them (see §3).

## 2. Schema capability — what CAN and CANNOT be established

Ground truth is the code (`src/telemetry/metrics.ts`), matching MAST_SPEC
§14.3 exactly, and it applies to both pools (the workbench builds run the
same npm-linked `packages/mast/dist`). Persisted `metrics` columns: `id,
tool_name, call_timestamp, tokens_returned, tokens_full_file_upper_bound,
duration_ms, mode, session_id, status`. Both pools also persist the
`metrics_daily` roll-up (day, tool_name, calls, token totals, avg duration) —
same columns, no argument/result identity either.

**Can establish:** tool call order within a session (`session_id` +
`call_timestamp`); approximate token counts (`@anthropic-ai/tokenizer`,
claude-2 era — approximate for current models, ratios are the robust number,
§14.5); duration; status.

**Cannot establish:** tool *arguments* (no query text, symbol name, or file
path is persisted — `_stats.files_referenced` from §14.2 is returned to the
caller but is **not** written by `recordToolCall`); result identity (which
files/symbols a search returned); therefore **whether a follow-on
`mast_signature`/`mast_exports` call targeted a symbol the search returned is
not derivable from any persisted column, in either pool.**

**Consequence:** only the *loose* (sequential, argument-blind) chain
definition is measurable — an upper bound on the true, symbol-linked rate.
The missing instrumentation, named precisely: **per-call persisted arguments
(query/symbol/file) and per-call result identity (returned file paths and/or
symbol ids) on the `metrics` row** — an additive schema change per §7.4 —
or equivalently an instrumented pilot that logs both.

### Anomaly (both pools, report verbatim)

**`tokens_full_file_upper_bound = 0` in every one of the 2,116 rows across
all 35 stores in both pools — including the newest builds (align-kimik27-03,
2026-07-15, same day as this analysis).** `estimateFullFileBound()` in
`src/telemetry/tokenizer.ts` is a stub ("Stage 6 implementation — returns 0
until lance reads are wired up"), so `efficiency_ratio` computes to 0 for
every recorded call ever made, on every build vintage observed. §14's
headline "defensible savings number" is not computable from any real data
collected to date, and any Stage 2.3-style adoption argument that cites
`efficiency_ratio` movement would be citing a constant.

## 3. Question 1 — does the chain occur, and at what rate?

**Definition (loose upper bound, unchanged from v1):** within one session, a
`mast_search` call followed later (by `call_timestamp`) by a `mast_signature`
or `mast_exports` call, regardless of argument/result overlap.

| Pool | Sessions w/ ≥1 chain | Total | Rate | Eligible-only (≥2 rows) | Gate (<10% ⇒ demote) |
|---|---|---|---|---|---|
| A (kluster repo, v1) | 3 | 46 | **6.52%** | 7.89% | fails — demote *on this pool alone* |
| B (workbench builds) | 72 | 337 | **21.36%** | 24.32% | **passes** |
| Combined | 75 | 383 | **19.58%** | 22.46% | **passes** |

Pool B detail: 158 chain instances across 72 sessions; chains-per-session
min 0 / median 0 / max 11; follow-on tool split: signature 106, exports 52.
Chain legs are tight: median gap 1.5 calls / 4.7 s between the search and the
follow-on (max 343.6 s) — consistent with (though, per §2, not proof of) a
genuine "search found it, now get its signature" round-trip.

Per-store chain rates inside Pool B vary sharply **by model**: echo-kimi-01
46.15%, a0-minimax3-01 39.58%, a0-sonnet-01 28.57%, align-kimik27-03 20.69%,
align-kimik27-01 19.23%, align-kimik27-02 17.65%, a0-kimik27-01 7.14%,
**a0-deepseekv4flash-01 0% (0 of 24 sessions)**. The chain is a real
behaviour of most build agents but not all — anomaly reported verbatim:
deepseekv4flash made 43 signature calls in 91 rows yet never once in a
session where a search preceded them.

**Chain token cost** (search + follow-on `tokens_returned`; approximate
tokenizer, ratios robust): Pool B median **2,100.5 tokens**, p90 **4,295**;
Pool A median 2,438, p90 5,441; same order of magnitude in both pools.

### Mechanical verdict (re-applied per pool, as instructed)

- **Pool A alone: DEMOTE** (6.52% < 10%) — the v1 verdict, correct for that
  pool, preserved for provenance.
- **Pool B: the loose rate 21.36% clears the 10% gate. Combined: 19.58%,
  also clears.** Per the plan's pre-decided rule for exactly this case ("if
  the loose version is ≥10% but you cannot establish the tight version, say
  the result is indeterminate and name exactly what instrumentation is
  missing"): **the Stage 2.1 result is INDETERMINATE — the v1 DEMOTE is
  overturned, but this is not a promotion.** The tight, result-linked chain
  rate the gate is really about cannot be computed from the shipped schema
  (§2). Missing instrumentation, named: persisted per-call arguments and
  result file/symbol identity on the `metrics` row (additive columns), or an
  instrumented pilot capturing the same.
- **Population split, stated plainly:** chain behaviour differs sharply
  between pools — interactive kluster-repo usage chains at ~6.5%, automated
  build-pipeline agents at ~21.4% (and up to 46% for some models). The
  capsule tool would serve both populations; the demand evidence comes
  almost entirely from the build population.

### Reserve-trigger side-finding (`mast_path`, §R)

Requested explicitly: across all 2,116 combined rows, `mast_callers` was
called **4 times** (0.19%) and `mast_dependencies` **19 times** (0.90%) —
all 23 in the three align-* stores; zero in Pool A. No session shows
`mast_callers` chained ≥2 hops. The §R trigger for `mast_path` ("agents
manually chaining mast_callers hops ≥2 levels in ≥10% of sessions") is
**nowhere near met** on n=383 sessions — negative evidence, now with a much
larger n than v1's.

## 4. Question 2 — what would a capsule have saved?

Unchanged discipline from v1: **full reconstruction is not possible** (no
query text, no result identity — §2), so the plan's bounded-estimate fallback
applies: `capsuleTokens = min(token_budget, chainTotalTokens)` — an explicit
**upper bound**, not a measurement.

| Pool | Budget | Chains | Requiring truncation | Median "saving" |
|---|---|---|---|---|
| B (workbench) | 2,000 | 158 | 82 | 4.8% |
| B (workbench) | 4,000 | 158 | 21 | 0% |
| A (kluster, v1) | 2,000 | 18 | 9 | 19.3% |
| A (kluster, v1) | 4,000 | 18 | 5 | 0% |

**Honest conclusion (unchanged, now on 158 chains instead of 18): these
numbers do not demonstrate a real token saving.** Where a chain fits the
budget the bound correctly reports 0% (a capsule cannot cost less than the
content it must include, and no redundancy is measurable). Where it exceeds
budget, the "saving" is an artifact of truncation, not deduplication — we
cannot tell whether the search and signature outputs overlapped at all. At a
4k budget the median saving is 0% in both pools. The real Question-2 number
requires an instrumented side-by-side (chain vs. real capsule call on the
same query), which is exactly what a Stage 2.2-pilot would produce.

## 5. Suggested Promotion Log row (v2, supersedes the v1 suggestion)

| Date | Mechanism | Decision | Evidence |
|---|---|---|---|
| 2026-07-15 | `mast_capsule` (Feature 2) — search→signature/exports chain telemetry baseline (v2: kluster + kluster-workbench pools) | **INDETERMINATE — hold; do not build Stage 2.2 yet, do not demote.** Prerequisite work: chain-linking instrumentation (persist per-call args + result file/symbol identity on `metrics`, additive per §7.4) or an instrumented pilot; re-gate on the tight chain rate. | Pool A (kluster repo, 126 rows/46 sessions, mixed interactive+ephemeral): loose chain rate 6.52% — below gate; v1 demoted on this pool alone before the workbench data surfaced. Pool B (kluster-workbench builds, 11 stores, 1,990 rows/337 sessions, 2026-06-19→07-15, same npm-linked mast source): loose rate **21.36%** (24.32% among ≥2-row sessions), 158 chains, median 2,100 tk/p90 4,295 tk per chain (approx tokenizer, §14.5), median gap 1.5 calls/4.7 s; combined 19.58%. Gate clears on the loose UPPER BOUND only — tight (result-linked) rate not derivable: `metrics` persists no arguments or result identity (`src/telemetry/metrics.ts`). Chain rate is model-dependent (0%–46% per store) and population-dependent (builds ~21% vs interactive ~6.5%). Q2 bounded estimate shows 0% median "saving" at 4k budget in both pools — no measurable redundancy; truncation artifacts only. Side-findings: `mast_callers` 4 / `mast_dependencies` 19 of 2,116 calls — §R `mast_path` trigger not met; `tokens_full_file_upper_bound=0` in all 2,116 rows (stub `estimateFullFileBound`) — `efficiency_ratio` is a constant 0 on all real data to date. Detail: `eval/spikes/capsule/REPORT.md`, `results.json`. |

## 6. What would change this verdict

To resolve INDETERMINATE in either direction: add the chain-linking
instrumentation (additive `metrics` columns for call arguments and returned
file/symbol identity — no schema-version bump per §7.4) or run an
instrumented pilot over ≥1 real build (the align-*/a0-* pipeline generates
~300–560 rows per build, so one build supplies more evidence than everything
Pool A collected in two months). Then re-compute the tight chain rate and
gate on it. If the tight rate holds anywhere near the loose 21%, Feature 2's
Stage 2.2 has its promotion evidence; if linking collapses it below 10%, the
demotion becomes final with clean provenance. Separately and regardless of
the capsule decision: `estimateFullFileBound` should stop returning 0 — every
efficiency number MAST reports today is vacuous, which undermines the §14
telemetry thesis this entire plan leans on.
