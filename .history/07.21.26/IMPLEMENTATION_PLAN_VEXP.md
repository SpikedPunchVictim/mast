# Implementation Plan — vexp-Inspired Retrieval Improvements

Evidence-first plan for porting the features from the vexp.dev comparison (2026-07-15)
that survived scrutiny. Four features made the cut; three are **gated on measured
evidence**, one is defensive and ships on correctness tests alone. Everything else
vexp offers is in the Design Reserve (§R) or rejected outright (§X).

**Prime directive for the executing agent:** replace speculation with the cheapest
possible empirical test. Every stage below names its empirical questions *before*
its build steps. If a gate fails, the feature is demoted to the reserve with its
numbers recorded in the Promotion Log (§P) — that is a successful outcome, not a
failure.

**Ground rules (from MAST_SPEC.md and CLAUDE.md):**
- TDD per CLAUDE.md §5 — failing test first for every behavioural change.
- Schema discipline per MAST_SPEC §7.4: additive `ALTER TABLE … ADD COLUMN` needs
  no `CURRENT_SCHEMA_VERSION` bump; anything that breaks reading an old table does.
- All Phase-1 writes acquire `structure.lock`; long-running background work follows
  the forked-child pattern of the embedder (`src/indexer/background-embedder.ts`).
- The eval harness (`eval/README.md`) is the arbiter for ranking changes. vexp's
  own published numbers (73% SWE-bench, ±8.7pp) are vendor marketing and are
  **not evidence** for any decision in this plan.

**Baseline numbers to cite (do not re-derive):** N1 bake-off, run 2026-07-10
(`FABLE_FEEDBAK.md`, `eval/results/`): incumbent jina hybrid ungated NDCG@10 =
0.580 on the frozen 28-query/43-target gold set. Gold-set resolution separates
tiers (±30%+), **not** near-ties (±5%) — every ranking gate below is written
with that limitation in mind.

---

## Feature 1 — Type-Checker-Verified Call Edges

**What:** Use the TypeScript compiler API to resolve call edges the tree-sitter
heuristic resolver (`src/graph/local-type-env.ts`, MAST_SPEC §10.3) cannot link,
upgrading `potential_matches` (agent-review-required, paid for in tokens every
refactor) into `verified_callers` (safe to act on).

**Why this is the biggest win:** §10.3 coverage is partial *by design* — factory
patterns, DI lookups, inferred types, and dynamic dispatch all land in
`potential_matches`, and `mast_rename_impact` marks every one a mandatory review
site. Each upgraded edge deletes an agent review round-trip forever.

### Stage 1.1: Spike — cost and payoff measurement (throwaway)

**Goal**: Answer the empirical questions below with measured numbers before any
production code exists. Quarantined under `eval/spikes/checker-edges/` (plain
`.mjs`, imports from `dist/`, never shipped).

**Empirical questions (write answers into the Promotion Log):**
1. What is the current verified:potential ratio on this monorepo? Query
   `graph.db` directly: `SELECT COUNT(*) FROM edges WHERE edge_type='POTENTIAL_CALL'`
   grouped by `resolution`, vs. a sampled `identifier_fts` potential count for the
   top-50 most-called exported symbols. *(Baseline — cite it in every later claim.)*
2. How long does `ts.createProgram` (or a `ts.LanguageService` per tsconfig
   project) take to build over the kluster monorepo, and what is peak RSS?
   Measure cold and warm. If >5 min or >2 GB RSS, the always-on design is dead
   and the feature becomes an opt-in `mast index --checker` pass — decide from
   the number, not from taste.
3. On a random sample of 50 current potential matches (sample script, seeded),
   how many does the checker resolve to a definite edge? This is the payoff
   number. If <20% resolve, the feature is demoted to reserve — the residue is
   genuinely dynamic and no checker will fix it.
4. Does the checker agree with the existing heuristic edges? Run it over the
   symbols behind `src/graph/__tests__/verified-callers.test.ts` fixtures — any
   heuristic edge the checker *contradicts* is a severity-zero finding (a false
   "verified" is a false-green; see gate below).

**Success Criteria**: All four questions answered with numbers; go/no-go decision
recorded in §P.
**Tests**: None (throwaway spike; correctness of the spike itself is not the point).
**Status**: Complete — verdict **GO, reshaped as opt-in `mast index --checker`**
(2026-07-15; Q2 RSS gate failed at 2.45 GB so always-on is dead; Q3 passed at
38% monorepo / 56% foreign corpus. See §P and
`eval/spikes/checker-edges/REPORT.md`)

### Stage 1.2: Checker enrichment pass (build — 1.1 promoted with reshape)

**Goal**: An **opt-in `mast index --checker` CLI pass** (NOT the always-on
background worker — the spike killed that shape: 2.45 GB peak RSS > the 2 GB
gate) that upgrades edges in `graph.db`. Cold cost is acceptable (21.8 s for
25 projects / 762 files), so an explicit pass the SDD pipeline or a developer
invokes after indexing is the right shape.

**Spike-mandated requirements (from `eval/spikes/checker-edges/REPORT.md`):**
- **Prerequisite fix first (severity zero, ships before/with this feature):**
  `src/graph/populate.ts` `insertEdges` resolves POTENTIAL_CALL targets by bare
  symbol name across the entire graph with no file filter — when two files
  export a same-named symbol, the heuristic emits a *wrong verified edge* into
  whichever file was inserted first (confirmed against the checker AND the
  import's own `resolved_path`; see §P). Fix: filter `toRows` by the import's
  `resolved_path`; add the invariant test (two same-named exported symbols →
  edge lands in the imported file, deterministically).
- Hold ONE `ts.Program` at a time and release it before the next project (the
  spike's hold-all-programs variant made "warm" slower than cold via GC
  pressure: 42.6 s vs 21.8 s).
- `getAliasedSymbol` alias-chain following is mandatory — without it the
  resolution rate collapses 38% → 2% (measured mid-spike).
- Record "checked, not a call site" for the 30–44% of potential matches that
  are comments/strings/type positions, so `mast_callers` can stop re-surfacing
  them as review sites — this residue classification is itself a major token
  win of the feature.
- Files outside any tsconfig project remain `potential` and the docs say so
  (22% of the monorepo sample; zero in-scope dynamic failures were observed).

**Design (original, still applies where not superseded above):**
- New module `src/graph/checker-resolver.ts`; invoked from the CLI
  (`src/cli/index-cmd.ts` gains `--checker`).
- Edges written with a new `resolution` value: `'checker'`. This is additive to
  the §6.3 enum (`import | field_type | parameter_type | new_expression |
  same_file`) — document it in MAST_SPEC §10.3.1 and in `mast_callers`' tool
  description. No schema bump (no column/table shape change).
- The tree-sitter heuristic remains the synchronous fast path. Checker edges are
  eventual, like embeddings: `mast_status` gains a `pending_checker_edges` count
  parallel to `pending_embeddings` (additive field, no bump).
- Writes acquire `structure.lock` in short per-file batches (§7.6 pattern) so JIT
  re-parses are never starved.
- Staleness: a JIT re-parse (§9.0) deletes-and-replaces a file's symbols, which
  cascades its edges — checker edges for that file are re-enqueued, exactly as
  changed chunks are re-enqueued for embedding.

**Success Criteria**:
- Verified:potential ratio on the monorepo improves by the margin the spike
  predicted (cite before/after from the Stage 1.1 query — this is the shipping
  evidence, not a unit test).
- `pnpm -F @kluster/mast test`, `tsc --noEmit`, lint all green.
- **False-green gate (severity zero):** zero checker edges that name-match but
  point at the wrong declaration. Test: adversarial fixtures — same method name
  on two unrelated classes, interface-typed receiver with two implementors,
  shadowed import. A wrong "verified" edge is worse than no edge; if this class
  of bug appears, fixing it jumps every queue and gets an invariant test.
**Tests**: New `src/graph/__tests__/checker-resolver.test.ts` (fixtures above,
plus DI-container and factory patterns the heuristic misses — assert they resolve);
extend `verified-callers.test.ts` to assert heuristic and checker edges coexist
and dedupe on `(from_id, to_id, edge_type)`.
**Status**: Complete (2026-07-18, working tree, uncommitted) — including the
named-re-export sibling fix (Task 0). Shipping evidence in §P; deviations from
the original design (no `pending_checker_edges`, `collectPotentialMatches`
relocated to `src/search/potential-matches.ts`, batched chunk reads) are
documented in the stage report and MAST_SPEC §10.3.2.

---

## Feature 2 — Token-Budgeted Context Capsule (`mast_capsule`)

**What:** One MCP tool that answers "give me working context for X within N
tokens": the pivot chunk in full source, one-hop graph neighbours (callers,
imports, param/return types) collapsed to signatures, greedily packed to a hard
`token_budget`. Collapses the observed `mast_search` → `mast_signature` →
`mast_exports` round-trip chain into one call. This is composition of existing
capabilities — hybrid search, `class_shell` synthesis, `type_context` resolution,
graph queries — not new machinery.

### Stage 2.1: Evidence baseline — is the round-trip chain real?

**Goal**: Confirm from *our own* telemetry (not vexp's claim of "~60% fewer
tokens") that the chain this tool collapses actually occurs, and how often.

**Empirical questions:**
1. From the §14 metrics table (`src/telemetry/metrics.ts`, global scope on the
   shared volume): in the last N sessions, how often is `mast_search` followed
   within the same session by `mast_signature`/`mast_exports` on a symbol/file
   the search returned? What is the median token cost of that chain?
2. What would the same information have cost as one capsule response? Estimate
   by re-composing recorded responses under a 2k/4k budget using
   `src/telemetry/tokenizer.ts` (ratios are robust, absolute counts approximate
   — §14.5 framing applies).

If the chain occurs in <10% of sessions, demote to reserve: the tool would be
solving a problem our agents don't have. Record either way in §P.

**Success Criteria**: Both questions answered with numbers from real transcripts.
**Tests**: None (read-only analysis; script may live in `eval/spikes/capsule/`).
**Status**: Complete — final verdict **INDETERMINATE / HOLD** (2026-07-15 v2;
the initial DEMOTE was computed on the kluster-repo pool only and was
overturned when the kluster-workbench build-agent pool was added — see §P and
`eval/spikes/capsule/REPORT.md` v2)

### Stage 2.2: Tool implementation (build — only if 2.1 promotes)

**Goal**: `mast_capsule` registered and passing tests.

**Design (pre-decided):**
- New `src/mcp/tools/capsule.ts`, registered in `src/mcp/server.ts` alongside the
  read tools (it is a read tool: JIT staleness §9.0 applies to every chunk it
  returns — reuse `src/mcp/staleness.ts`, no exceptions).
- Input: `{ query: string, token_budget: number (default 3000), file_path?: string }`.
  `query` may be a symbol name or a conceptual query; resolution order: exact
  symbol match (`symbols` table) → `hybridSearch` top hit as pivot.
- Packing order (greedy, deterministic): pivot chunk full content → its
  `type_context` signatures (reuse `mast_signature` resolution, §9 rules 1–8) →
  direct verified callers as signature + call-site context line → imports of the
  pivot's file (`mast_dependencies` data). Stop when the next item would exceed
  budget; report `truncated: true` plus what was dropped (**no silent caps** —
  a capsule that looks complete but isn't is a false-green).
- Token counting via the existing `src/telemetry/tokenizer.ts`, with the §14.5
  "approximate" label carried in the response verbatim.
- No schema changes, no index changes, no bump.

**Success Criteria**: Tool returns within budget ±5% on fixtures; every returned
chunk passed the staleness check; `truncated`/dropped reporting exact.
**Tests**: New `src/mcp/tools/__tests__/capsule.test.ts` — budget boundary
(pivot alone exceeds budget → pivot truncated with flag), packing order
stability, symbol-vs-conceptual pivot resolution, staleness flag propagation.
Extend `tools.test.ts` registration assertions.
**Status**: On hold — Stage 2.1 v2 is indeterminate: the loose (argument-blind)
chain rate clears the 10% gate on the build-agent pool (21.4%) but the tight
result-linked rate the gate is about cannot be measured from the current
metrics schema. Prerequisite before building: instrument metrics with per-call
arguments + returned file/symbol identity (additive, §14.3), run ≥1
instrumented align-*/a0-* build, re-apply the gate on linked chains (see §P)

### Stage 2.3: Adoption validation — drive the real thing

**Goal**: Prove agents actually call it. Availability ≠ adoption: in the align
build, an agent given an open-ended task made **zero** calls to a new tool until
the project instructions named it. Assume the same here.

**Steps:**
1. Update the mast tool-usage prompt blocks (`.claude/CLAUDE.md` mast section,
   SDD `implement-task.md` per MAST_SPEC §12.2) to name `mast_capsule` and when
   to prefer it over search→signature chains.
2. Run ≥3 real agent tasks (SDD pipeline or interactive) and read the metrics
   table: did `mast_capsule` get called? Did search→signature chains per session
   drop against the Stage 2.1 baseline? Did session `efficiency_ratio`
   (`mast_efficiency`) move?
3. Report the numbers verbatim, including a null result. If agents don't reach
   for it after the prompt change, that is a real finding — record it and decide
   (rewrite description / demote) from evidence.

**Success Criteria**: Measured before/after round-trips and tokens per session on
real tasks; adoption observed (≥1 organic call per task on tasks where context
gathering occurs).
**Tests**: None beyond 2.2's suite — this stage is live validation, not unit
coverage. Do not claim the feature "done" until this ran (CLAUDE.md §10 honesty).
**Status**: Not Started (blocked on 2.2)

---

## Feature 3 — Graph Centrality as a Third RRF Ranker

**What:** Add a graph-centrality ranking (how structurally load-bearing a symbol
is: in-degree over `POTENTIAL_CALL`/`IMPLEMENTS` edges, or PageRank) as a third
rank list fused in `hybridSearch` (`src/search/hybrid.ts`) — RRF composes rankers
by rank, so this is a small change. **Accept/reject purely on the gold-set gate.**
This can *hurt* ranking (centrality biases toward hub symbols regardless of query
intent), so it ships only if the numbers say so.

### Stage 3.1: Offline experiment (gate — no production wiring)

**Goal**: Score the 2-ranker vs 3-ranker fusion on the frozen gold set, following
the `score-only.mjs` before/after pattern from Task 9.

**Steps:**
1. `pnpm -F @kluster/mast build`; rebuild the eval corpus per `eval/README.md`
   (`build-corpus.mjs` → `verify-gold.mjs` must print "gold set OK").
2. Compute centrality per chunk in a spike script (`eval/spikes/centrality/`):
   simple in-degree first; PageRank only if in-degree fails the gate (two knobs,
   tested in order — do not tune both at once).
3. Re-implement fusion in the spike by calling the exported `rrfScore` with the
   third rank list layered over recorded FTS/vector rank lists (the harness
   imports compiled `dist/` modules — same pattern as `score-only.mjs`).
4. Score NDCG@10 / Recall@10 / MRR, before vs after, per query and aggregate.

**Promotion gate (decided now, before any numbers exist):**
- **Promote** if aggregate NDCG@10 improves ≥ +0.05 (the gold set can't resolve
  finer than tiers; a smaller delta is noise) **and** no individual gold query's
  reciprocal rank degrades by more than one tier.
- **Reject** if aggregate is flat/negative. Record per-query deltas in §P either
  way so this doesn't get re-proposed from scratch (the reserve kills ideas as
  readily as it ships them).
- If flat-but-promising (e.g. +0.02 with wins concentrated on identifier-less
  conceptual queries): hold in reserve and note that the *gold set*, not the
  ranker, is the blocker — expanding the gold set with a production miss-log is
  the prerequisite work (see `eval/README.md` known limitations).

**Success Criteria**: Scored before/after table produced by `aggregate.mjs`-style
output; gate decision recorded.
**Tests**: None (spike).
**Status**: Complete — verdict **REJECT** (2026-07-15, see §P and
`eval/spikes/centrality/REPORT.md`)

### Stage 3.2: Production wiring (build — only if 3.1 promotes)

**Goal**: Centrality computed at index time and fused in `hybridSearch`.

**Design (pre-decided):**
- Centrality stored as a new nullable REAL column on `symbols` via
  `ALTER TABLE … ADD COLUMN` in `openDatabase` migration (additive — no schema
  bump, per the §7.4 carve-out). Recomputed at the end of Phase 1 full runs and
  incrementally marked stale on file replace (cheap full recompute is fine if
  the spike measured it <1s at monorepo scale — cite the number).
- Third rank list built in `hybridSearch` from the candidate pool only (rank the
  union of FTS+vector candidates by centrality; do NOT inject non-matching hub
  symbols into results — centrality re-orders matches, it never adds them).
- `rrf_k` unchanged; no new config knob unless the spike proves one necessary
  (no honest cross-model default existed for the cosine gate; assume the same
  scepticism for a centrality weight).

**Success Criteria**: Gold-set score with production code path matches the spike
(re-run `score-only.mjs` pattern against rebuilt `dist/`); full suite, `tsc`,
lint green.
**Tests**: Unit tests in `src/search/__tests__/search.test.ts` for the
candidates-only invariant and rank stability with null centrality (cold index);
migration test in `src/graph/__tests__/storage.test.ts`.
**Status**: Rejected — Stage 3.1 gate failed for both in-degree and PageRank
variants; do not build (see §P)

---

## Feature 4 — Secret Filtering at Index Time

**What:** Detect and redact secret-shaped content (API keys, tokens, private
keys, high-entropy literals in env-style assignments) during Phase 1, before
chunk content reaches `chunks.lance`, `chunk_fts`, or agent responses.

**Why no retrieval-evidence gate:** this is defensive with asymmetric downside —
an indexed secret surfaces in agent context and the shared-volume metrics/logs.
It ships on correctness tests alone. The empirical question is the
**false-positive rate**, not the benefit.

### Stage 4.1: Detector + redaction

**Goal**: A pure function `redactSecrets(content, filePath)` applied in Phase 1
chunk extraction (`src/indexer/index.ts` path) before storage.

**Design (pre-decided):**
- Pattern pass (known prefixes: `AKIA…`, `sk-…`, `ghp_…`, `-----BEGIN … PRIVATE
  KEY-----`, JWT shape) + entropy pass (Shannon entropy > threshold on string
  literals assigned to names matching `/key|secret|token|password/i`). Boring,
  well-trodden heuristics — do not invent novel detection.
- Redact in place with `«REDACTED:<kind>»`, preserving line structure so chunk
  line coordinates stay exact (the §9.0 invariant — never break line accuracy).
- Store a per-file `secrets_redacted` count surfaced in `mast_status` and the
  reindex result (additive fields, no bump). **Silent redaction is a false-green
  risk in reverse** — the agent must be able to see that content was withheld.
- Config: `secret_filtering: true` default in `mast.config.json`; documented in
  MAST_SPEC §4.1.

**Empirical check (not a gate, a number to report):** run the detector over the
full monorepo corpus (reuse `eval/build-corpus.mjs` state) and hand-review every
hit. Report hit count and false-positive rate verbatim. If FP rate is high on
legitimate code (hashes in tests, sample keys in fixtures), tighten to
assignment-context-only before shipping.

**Success Criteria**: Seeded fixtures fully redacted; line coordinates unchanged;
corpus FP review done and reported; suite/`tsc`/lint green.
**Tests**: New `src/indexer/__tests__/secret-filter.test.ts` — each pattern
class, entropy boundary cases, multi-line PEM block spanning chunk boundaries,
line-count preservation, opt-out flag.
**Status**: Not Started

---

## §R Design Reserve (pre-thought, NOT build commitments)

Held until evidence demands promotion. Burden of proof is on promotion.

| Mechanism | Trigger for promotion |
|---|---|
| `mast_path(from, to)` — execution-path tracing (vexp `search_logic_flow`) | Transcript analysis shows agents manually chaining `mast_callers` hops ≥2 levels in ≥10% of sessions. Recursive-CTE machinery exists in `src/graph/queries.ts`; cost is small, but so is proven demand. Note: 2026-07-15 telemetry (combined pools, 383 sessions / 2,116 calls) shows `mast_callers` called 4 times and `mast_dependencies` 19 — all within the three align-* stores, with no ≥2-hop chaining observed. Demand remains far below the trigger. |
| `mast_capsule` — token-budgeted context capsule (**DEMOTED 2026-07-19** after the instrumented pilot) | The pre-registered gate ("one instrumented build decides it") fired: linked chain rate **0/7 searches (0.00)** vs loose 3/7 (0.43) — the loose metric that cleared 10% in v2 was measuring temporal coincidence, not information flow; search results never fed later signature/exports arguments (hand-verified). Sonnet works signature-first off fold's IR context. Re-promotion trigger: linked chains actually observed (>0) in UPDATE/RECONCILE-path telemetry — the context-poor population the build path can't represent — or an interactive-session sample with linked rate ≥10%. n=7 is small; the direction, not the precision, is the decision basis. |
| PageRank (vs in-degree) centrality | In-degree fails the Stage 3.1 gate but per-query deltas suggest hub-bias is the fixable problem. |
| Production miss-log → gold-set expansion | Any ranking experiment lands in the ±5% zone the current 28-query set cannot resolve. This is eval infrastructure, prerequisite to finer ranking work. |
| foldv2 between-stage checker hook (proposed 2026-07-17; part (a) seam IMPLEMENTED 2026-07-18, uncommitted — see §P) | Two distinct consumers, different evidence bars. **(a) Reconcile/update path — strongest case, now wired:** `packages/workbench/foldv2/mast-bridge/src/mastCodeSearch.ts` already shells out `mast index --phase1-only` and consumes `queryVerifiedCallers` IN-PROCESS for the codebase projection — a deterministic machinery consumer, so the "agents don't call mast_callers" telemetry objection does not apply; checker precision flows straight into reconcile's minimal-delta quality. Integration is one seam: an option on `MastApi.index()` adding `--checker`. Promote when the update/reconcile flow ships and a pilot shows checker-sharpened projections change reconcile output (fewer spurious impact sites). **(b) Between-build-task hook for agent benefit:** weaker case today (agents: 4 `mast_callers` calls / 383 sessions); promote only via an A/B pilot (checker hook + callers-aware prompt vs control, measured with the new args/results instrumentation). Run after gate-green boundaries only; non-blocking; JSON summary into fold telemetry. Cost expectation at fold-app scale (1 tsconfig, 20–72 files): seconds, not the monorepo's 21.8 s / 2.45 GB — measure once before wiring. Deliberate MAST_SPEC §2 deviation ("zero BT involvement after init") — record it in the spec when promoted. |
| ~~Opt-in `--checker` CLI mode (instead of always-on background pass)~~ | **Promoted 2026-07-15** — the exact contingency fired: peak RSS 2.45 GB > 2 GB gate. Now the committed Stage 1.2 shape. |

## §X Rejected (do not re-propose without new evidence)

- **Intent detection / query routing** — our consumer is Claude choosing among
  well-described tools; vexp targets weaker routing layers. No observed failure
  mode of ours matches it.
- **Cross-session memory tools** (`save_observation` etc.) — violates MAST_SPEC
  §3 non-goals; overlaps the kluster ledger/memory track. Wrong package.
- **30-language support** — explicit v1 non-goal (§3).
- **Trusting vexp's benchmarks as design input** — vendor-reported, no
  reproducible harness. Our gold set + telemetry adjudicate everything here.

## §P Promotion Log (append-only; record numbers, not adjectives)

| Date | Mechanism | Decision | Evidence |
|---|---|---|---|
| 2026-07-15 | Plan created | — | Baseline: hybrid ungated NDCG@10 0.580 (N1 run 2026-07-10) |
| 2026-07-15 | Graph centrality as 3rd RRF ranker (in-degree) | **REJECT** | ΔNDCG@10 −0.0813 (0.4884 → 0.4071 on rebuilt corpus), 11 queries degraded vs 6 improved, worst tier delta 3 (q05 rank 1→8). Coverage only 15.3% of chunks nonzero → third rank list is noise for 85% of candidates; hub displacement confirmed (irrelevant high-degree symbols outrank low-degree gold targets, e.g. q16). `eval/spikes/centrality/results.json` |
| 2026-07-15 | PageRank variant (d=0.85) | **REJECT** | ΔNDCG@10 −0.0688 (0.4196); repaired some hub displacements but created new ones and kept the worst losses. Both pre-decided knobs exhausted. `eval/spikes/centrality/results-pagerank.json` |
| 2026-07-15 | `mast_capsule` (token-budgeted context capsule) | **DEMOTE to reserve** | Loose (argument-blind, upper-bound) search→signature/exports chain occurs in 3/46 sessions (6.52%), under the pre-decided 10% gate; all 18 chain instances cluster in one ~20-min work episode (non-independent). `mast_signature`+`mast_exports` are only 6 of 126 recorded calls. Savings estimate not derivable — schema records no argument/result identity. `eval/spikes/capsule/results.json` |
| 2026-07-15 | Telemetry finding (not a feature): `tokens_full_file_upper_bound` is 0 in **every** recorded metrics row | Fix required — false-signal bug | `estimateFullFileBound()` in `src/telemetry/metrics.ts` is an unimplemented stub, so `efficiency_ratio` reads 0 everywhere and `mast_efficiency`'s in-loop feedback signal (MAST_SPEC §14, "if ratio < 0.30, prefer mast_search") is dead — agents are being told they're maximally inefficient regardless of behaviour. Confirmed on **all 2,116 rows across both pools**, including builds indexed 2026-07-15 (align-kimik27-03) — a current bug, not historical. Reports-wrongly class: fix the stub, backfill nothing (historical rows stay honest-zero with a note). Also blocks any future capsule/efficiency measurement. |
| 2026-07-15 | `mast_capsule` v2 re-test (workbench pool added: 11 stores, 1,990 rows, 337 build-agent sessions, 2026-06-19→07-15) | **v1 DEMOTE overturned → INDETERMINATE, HOLD** | Loose chain rate: build-agent pool 72/337 = **21.36%** (median 2,100 tokens/chain, p90 4,295), interactive pool 6.52%, combined 75/383 = 19.58% — clears the 10% gate, but only as an argument-blind upper bound; the result-linked rate is unmeasurable (schema has no argument/result identity, confirmed on newest builds). Per the plan's pre-decided indeterminate rule: hold, name the missing instrumentation. Notable: `mast_signature` is the workbench's **most-used tool** (843 of 1,990 calls, 42.4%, ahead of search) — the capsule's target workload is real; linkage is what's unproven. Chain rate is strongly model-dependent (echo-kimi 46.2% → deepseek 0% despite 43 signature calls). Bounded savings estimate remains a truncation artifact (0% @ 4k budget) — no real saving demonstrated. `eval/spikes/capsule/results.json` v2 |
| 2026-07-15 | TS-checker-verified call edges (Stage 1.1 spike) | **GO — reshaped to opt-in `mast index --checker`** | Q1 baseline: verified:potential = 661:1,021 (0.647) on top-50 exported symbols; 3,311 POTENTIAL_CALL edges total. Q2: cold 21.8 s (passes <5 min) but peak RSS 2.45 GB **fails** the 2 GB gate → always-on worker dead, opt-in CLI promoted from reserve. Q3: 38% of a seeded 50-sample of potential matches resolve to definite edges (≥20% gate passed); 30% are non-call-site FTS noise (comments/strings/types) — classifying those away is its own win; 22% out-of-tsconfig; 10% resolve to a *different* declaration. n≥2 foreign corpus (align-kimik27-02, staleness-verified 23/23 mtimes): 56% definite, same residue profile — generalizes. TypeScript 5.9.3, seed 20260715. `eval/spikes/checker-edges/results.json` |
| 2026-07-15 | Shipped-resolver finding (not a feature): `populate.ts` emits wrong verified edges on same-named symbols | **Severity-zero false-green — fix jumps the queue** | Q4b adversarial fixture, confirmed in shipped code: `insertEdges` resolves POTENTIAL_CALL targets by bare symbol name across the entire graph (`toRows` has no resolved_path/file filter), so with two same-named exported symbols the "verified" edge lands in whichever file was inserted first — import statement and TS checker both prove the other file. Affects today's `verified_callers`/`mast_rename_impact` contract (the sets agents are told are "safe to act on"). Fix: filter by the import's `resolved_path` + invariant test. Pre-existing, independent of the checker feature. |
| 2026-07-15 | Capsule instrumentation prerequisites implemented (upper-bound fix + `args_json`/`results_json`) | Done in working tree — uncommitted; **not live until `pnpm build`** (the global `mast` binary npm-links to `dist/`, so instrumented-pilot data starts flowing only after a rebuild, which should wait until no fold build is in flight) | Stub was dead code: all 8 read tools hardcoded 0 at `buildToolStats`/`recordToolCall` call sites; real bound now computed per §14.2 with an (path, mtime)-cached injected reader. New nullable `metrics` columns via the additive migration precedent, no schema bump; wired into search/signature/exports/callers with capped, honestly-truncated JSON. 300 tests green (24 new), tsc/eslint clean, align red findings pre-existing and outside mast. |
| 2026-07-15 | `populate.ts` false-green FIXED (working tree, uncommitted) | Done — 4 failing tests reproduced the class first (import, same_file, barrel-chain, external-collision shapes), then `insertEdges` was rewritten to resolve each POTENTIAL_CALL target file-scoped by its resolution rule's own evidence; unresolved/external → no edge (no edge beats a wrong edge). Receiver-type rules with genuinely no file evidence (default/namespace imports, ambient types) keep prior behavior, documented. 304/304 tests green, tsc/eslint clean, MAST_SPEC §10.3.1 clarified. | Same-class sibling found while fixing (below). |
| 2026-07-15 | Sibling false-green (same class, NOT yet fixed): named re-exports (`export { x } from './y'`) resolve their RE_EXPORTS edge target by bare name with the same insertion-order coincidence | **Triage required** — affects `mast_rename_impact.barrel_exports` the way Q4b affected `verified_callers` | Found during the barrel-chain test. Fix requires extending `EdgeRecord`/`NamedReExport` with module/resolved-path evidence (shape change, deliberately out of scope for the hotfix). Per the severity-zero rule the *class* should be closed, not just the instance — schedule with or before Stage 1.2. |
| 2026-07-18 | Stage 1.2 `mast index --checker` SHIPPED (working tree, uncommitted) + named-re-export sibling fixed (Task 0) | Done — 325/325 tests, tsc/eslint clean, align findings pre-existing outside mast | Monorepo end-to-end (throwaway state): frozen top-50 verified:potential **0.647 → 127.7** (766:6; 442/1,021 candidates = 43.3% upgraded to `'checker'` edges, 37.3% classified non-call-site, 18.8% different-declaration, 6 left potential) — spike predicted 38%/30%, both within range. Whole monorepo: 1,885 new checker edges, 72k verdicts, 41.7 s / ~1.25 GB (one-program-at-a-time keeps it under the 2 GB gate). Fold-app scale (align-kimik27-02 copy): 1,063 candidates → 198 edges, 78.5% non-call-site, **0.70 s / ~359 MB** — cheap enough for the foldv2 between-stage hook (§R). False-green adversarial gate: zero wrong checker edges (interface-typed receivers correctly stay unresolved). Verdict staleness: cascade + mtime read-guard, tested by editing a fixture into a real call site. Idempotent rerun reports 0 upgrades; batching refactor proven byte-identical. |
| 2026-07-18 | foldv2 reconcile `--checker` seam WIRED (working tree, uncommitted) | Done — 13/13 mast-bridge + 107/107 cli tests, typecheck clean; align error pre-existing (stale kluster-bt selector) | `MastApi.index` gained `{checker}` option; update.ts enables it for reconcile, build path untouched. Fatality split required TWO invocations (mast's CLI has no non-fatal checker mode in one call): phase1 fatal, then `--incremental --phase1-only --checker` warn-and-continue. E2E on an align-kimik27-02 copy: 89 checker edges, 2,591 non-call-site, ~2 s checker / 536 MB; `queryVerifiedCallers` confirmed surfacing `resolution:'checker'` rows (no filter in queries.ts) — reconcile needs zero changes. Numbers differ from Stage 1.2's 0.7 s/198 edges because the app has since grown ~2.8× in candidates (drift, consistent with 2.8× duration). Remaining §R trigger for (a): pilot showing checker-sharpened projections change reconcile output. Side-finding: foldv2 packages have NO eslint wiring (no lint script, no flat config) — pre-existing gap, needs separate fix. |
| 2026-07-18 | Capsule instrumented pilot, runs 1–2 (kimi-k2.7 url-shortener builds) | **n = 0 — pilot blocked by a foldv2 decompose-prompt gap** | Both runs failed identically at decompose (independent samples, fresh workspace/cache on run 2): kimi plans 44/39 modules, folds the composition root into the frozen `server.ts`, and never plans the `apps/api/src/app.ts` that the frozen stub imports — fold's frozen-entry validation correctly aborts. Two-for-two = systematic (the decompose prompt doesn't state the frozen-entry import obligations the validator later enforces), not sampling noise. mast never starts (design phase only), so zero telemetry either way. Unblock: fold-side decompose fix (deterministic obligation injection — fold already computes exactly these imports in the validator) or pilot on a model that clears decompose. `eval/spikes/capsule/PILOT_RUN_1.md` |
| 2026-07-18 | foldv2 decompose frozen-entry prompt gap FIXED (working tree, uncommitted) | Done — 576/576 tests across 11 foldv2 packages, typecheck clean; capsule pilot unblocked, ready for run 3 | Root cause proven from the failed runs' artifacts: `DecomposeInput` carried no frozen-entry information, so the prompt (a pure function of it) could not state the contract the post-hoc validator enforced — kimi planned the frozen `server.ts` AS the composition root. Fix: `frozenEntryObligations()` derived from the validator's own `localImportsOf` resolution, injected into the prompt via a new `DecomposeInput.frozenEntryImports` field across ALL THREE construction paths (buildPipeline, updatePipeline, incrementalBuild); decompose phase version 3→4; invariant test structurally forecloses prompt/validator drift. Follow-up noted, not built: frozen-entry violations bypass `withRetry` entirely (checked after decompose returns ok), so no retry-with-feedback exists for this class. |
| 2026-07-19 | Instrumented pilot COMPLETE (run 3: kimi leg → quota death → sonnet resume; terminal state AWAITING DECISION after ~8.3 h, 27.8M cached tokens / 99% hit) | Instrumentation **validated in production**; `mast_capsule` **DEMOTED** on the pre-registered gate | Telemetry (89 rows, 12 sessions, copy-analyzed): upper-bound fix live — 85/89 rows nonzero (all 4 zeros legitimately empty), real per-tool costs at last (signature returns ~11% of full-file cost, skeleton ~6%, search ~52%); `args_json`/`results_json` 100% populated on signature/exports/search. Linked chain rate **0/7** vs loose 3/7 — loose was temporal coincidence; capsule demoted (see §R for the re-promotion trigger). Tool mix is strongly model-dependent again: kimi skeleton-led, sonnet signature-led (47 of 80 calls). Decompose fix validated 2/2 models. Mid-run model switch: phase cache keyed by model id → LLM phases regenerate, non-LLM state carries; no friction. Minor follow-ups: `project_skeleton` writes null `results_json` (confirm intended); pattern-fragment 8000-byte budget tripped 25× (fold-side sizing issue). `eval/spikes/capsule/PILOT_RUN_1.md` Run 3 section. |
| 2026-07-19 | Run-3 AWAITING DECISION forensics: fold's contract-collapse left a task-coverage seam | Root cause identified; fix dispatched (fold-side) | `plan.json` contained ONLY 7 test-budget-derived tasks; 19 of 26 modules — exactly the wiring the test budget rightly skips (composition root, routes/handlers/config, adapters, drivers) — got no task and shipped as `export declare` stubs (22 across 12 files). Ambient declarations pass tsc, defeating the D1 "unimplemented = compile error" guarantee; caught only by smoke; refine can't implement missing modules, hence the 18→18 stall. Same bug class as the decompose fix: late-gate obligation never stated early. Not a model failure (sonnet's contracts/tests were faithful; its tests correctly caught the holes). Contract-collapse economics unaffected. Decision-packet answers: reject AGPL ua-parser-js (core's implemented `parseDeviceType` already covers device typing — no replacement dep needed); all 7 ACs are core product behavior — implement, drop none; refine-stall resolves via completing the orphaned modules, not contract changes. |
| 2026-07-19 | fold task-coverage seam FIXED (working tree, uncommitted): plan module-coverage obligation + no-ambient-declaration gate + empty-write task failure | Done — 600/600 foldv2 tests (24 new), typecheck clean, align error pre-existing | `moduleCoverageViolations()` validated at plan time (prompt v2→v3 states the obligation; `deliberatelyNoTestFor` wired so "no test" never implies "no task"; update path proven structurally covered via reconcile's 1:1 planDelta); `DeclarationGate` (TS-AST) restores the D1 compile-error guarantee at verification; `runImplementTask` routes zero-file tasks through task-quarantine instead of ledger success. One pre-existing test found exhibiting the very bug (context-gap fixture) and fixed. ARCHETYPE_GAPS.md contract-collapse section updated with the n=2 seam entry. |
| 2026-07-20 | Run 4 (sonnet, resumed past an API outage) COMPLETE — seam fixes validated in production | Plan-coverage fix works; capsule stays demoted on the first credible linked-chain estimate | **Plan-coverage fix VALIDATED:** plan.json = 27 tasks / 27 modules, 27/27 covered on first attempt (vs run 3's 7 tasks / 19 orphaned); every wiring module (http-app/routes/config/adapters/middleware, persistence-database/migrations, service layer) now owned by a task. **Terminal state:** AWAITING DECISION with 2 items (down from 9), both dep-vetting — `ua-parser-js` (AGPL, predicted) and `@pglite/kysely` (**not on registry** — sonnet hallucinated a package). Run 3's 7 ac-uncovered + refine-stall are GONE; ac-coverage gate reports 0 failures — direct payoff of full coverage. **Capsule linked-chain (n=40 searches, ~6× run 3):** loose 15/40 = 0.38, strict linked 7/40 = 0.18 (all file_path chains, hand-verified; a first fuzzy matcher over-counted at 15 — corrected to 7). First credible estimate; ~82% of build-path searches don't feed a later lookup — capsule stays DEMOTED, re-promotion still gated on update/reconcile-path data. Telemetry: 159 rows/17 sessions, upper-bound 94% nonzero, args/results 100%. `PILOT_RUN_1.md` Run 4b section. |
| 2026-07-20 | Follow-up (fold-side, NOT fixed): DeclarationGate false-positives on `declare module`/`declare global` augmentation | Small gate fix needed | Run 4's only DeclarationGate hit — `fastify.d.ts`'s idiomatic `declare module "fastify"` request-augmentation — is a false positive; no real stub survived (full-tree grep clean, implement coverage genuinely complete). The gate flags the `declare` keyword without exempting standard module/global augmentation. Fix: exempt `declare module`/`declare global` (and `.d.ts` ambient files) from the ambient-declaration check; keep flagging `export declare function/class` in `.ts` source. Add the fixture. |
| 2026-07-20 | DeclarationGate false-positive FIXED + opt-in autopilot BUILT (working tree, uncommitted) | Done — 620/620 foldv2 tests (20 new), typecheck clean; ready for an unattended validation build | **Gate fix:** `declare module "..."` named-augmentation lacked `NodeFlags.GlobalAugmentation` so the gate's exemption missed it; now exempts named-module augmentation + `.d.ts`, still flags `export declare function/class/const`. **Autopilot (`--auto-resolve`, default OFF):** safe-branch-only decision resolution — classifier table (`cli/src/autoResolve.ts`) maps vetting-escalation→auto-revet, install-failed→auto-retry, and ac-uncovered/refine-stalled/contract-change/task-quarantine→escalate; a table-driven test proves NO kind ever maps to a relax-branch (the invariant's anti-regression). Re-vet loop feeds rejection reasons back to `proposeLibrariesPhase` (v1→v2), bounded (2 attempts/item, 10 rounds/build), audit trail on `BuildReport.autoResolutions`, flag-OFF byte-identical. Wired into buildPipeline only (sole source of these decision kinds). |
| 2026-07-21 | Run 5 (kimi `--auto-resolve`) terminal: autopilot VALIDATED, build died on scale | All three fixes confirmed under kimi (n=2); capsule stays demoted on the largest linked-chain sample | Autopilot fired and **resolved** the AGPL `ua-parser-js` escalation via auto-revet→`bowser` (0 human items, audit-recorded) — the exact item that stopped runs 3/4 for a human. Plan-coverage 37/37 (n=2 kimi), DeclarationGate clean (no false positive on 3 `declare module` augmentations). But the build **failed**: ran **86.0M tokens / ~14.9h** (T21 http-app composition root alone = 23.2M, unbounded) into a **429 session usage limit** that aborted refine — a scale/cost death, not a decision gate. "Shippable without a human" is unproven; needs `--task-budget` (cap the runaway) or the sonnet config (same spec at 785K tokens, 99.7% cache). Capsule: linked chain 7/54 = 0.13 (kimi) vs 0.18 (sonnet) — both ~½ the loose rate; two-model convergence confirms demotion. Telemetry: 326 rows/43 sessions, upper-bound 89% nonzero, args/results 100%. Fold follow-ups surfaced: blob-storage/time-series pattern floor mis-trigger drives the 3 next-biggest token sinks (spurious scope); composition-root task needs bounded budget. Breakdown artifact generated. |
| 2026-07-15 | Harness finding (not a feature): frozen `corpus-subset.json` has drifted | Action needed before next ranking experiment | 48/3,000 subset ids no longer resolve; 6 gold queries (q05, q08, q20, q25, q27, q28) silently lack subset vector coverage, depressing absolute NDCG@10 to 0.4884 vs recorded 0.580 (85.6% of the gap). `verify-gold.mjs` checks the corpus, not the subset — a passing "gold set OK" does not guarantee subset coverage. Re-freeze the subset (and extend verify-gold to assert subset coverage) before any experiment that compares against historical absolute scores. A/B comparisons within one run remain valid. |

---

## Sequencing and independence

Features are independent; recommended order by evidence-value-per-hour:

1. **Stage 3.1** (centrality experiment) — cheapest to falsify (~hours; harness
   exists), and its outcome doesn't block anything.
2. **Stage 1.1** (checker spike) — biggest payoff question; answers shape the
   largest build item.
3. **Stage 2.1** (capsule telemetry baseline) — read-only analysis of existing
   metrics.
4. **Stage 4.1** (secret filter) — no gate dependency; can interleave anytime.

Build stages (1.2, 2.2/2.3, 3.2) proceed only on their gate's promotion. Update
stage **Status** fields as work progresses; delete this file when all promoted
stages are Complete and the Promotion Log has been copied into FABLE_FEEDBAK.md
or the relevant memory.
