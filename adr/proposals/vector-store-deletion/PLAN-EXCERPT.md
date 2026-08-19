## M2 DECISION MEMO (2026-08-04) — arm D (delete) recommended; the scoped-out gaps confronted on the record

Written per HANDOFF_Q1.md §4a, BEFORE any A-vs-C benchmark and before any deletion or F18
productization work. Nothing in this memo is new measurement; every number cites an entry
above or the committed evidence under `eval/results/`. **Execution does not begin until the
project owner ratifies this memo** — the decision below is the inheriting session's
recommendation, recorded with its full basis so ratification or rejection can be equally
informed.

### The option set (unchanged from the M2 framing, Stage 2)

| arm | | evidence today |
|---|---|---|
| A | Lance with IVF-PQ enabled | none — never created |
| B | SQLite BLOB + JS brute-force | eliminated on paper (169 ms / 470 MB @153k) |
| C | `sqlite-vec` | none — not a dependency |
| **D** | **delete vectors entirely** | Q1 program: four converging lines + DECLEX closure |

### The decision rule this memo applies

Keep a subsystem when its measured benefit, in the units the cost is paid in — agent task
outcomes, query latency, resident memory, build time, dependency weight — exceeds its
measured cost. Retrieval-rank advantages count only insofar as a measured mechanism
converts them into those units. The standard of evidence demanded scales with the cost of
the thing being defended: F18's marginal cost is near zero, so retrieval-level evidence
suffices to justify it; the vector subsystem's cost is large, so outcome-level conversion
is demanded of it before its retrieval-level advantages count. This asymmetry is
deliberate, not an oversight. The cost-threshold half of the rule is the same one that
eliminated arm B on paper — B was eliminated on cost thresholds alone, before benefit ever
entered the analysis, so it is precedent for cost-threshold reasoning only, not for the
benefit-conversion standard applied to vectors here.

### The ledger

**Costs of keeping vectors (all measured, none moved):**
- 91 MB native dependency (`@lancedb/lancedb`) retained for exactly one table, with its
  differentiator (IVF-PQ) never enabled — today's arm is brute-force scan behind the dep.
- 7.2 h embed at the 153k target (batching FALSIFIED as a fix, Stage 4.5 — the figure is
  a model cost; q8/multi-process untested and affect build time only).
- 470 MB f32 resident + 169 ms/query brute-force at 153k against a 144 ms total p50 — or
  else an A-vs-C benchmark program whose only purpose is keeping the option alive.
- The forked background embedder, `vectors.lock`, the cold-start `mode: "lexical"` ladder,
  83 MB embed cache, ~140 MB Docker model-weights layer (MAST_SPEC.md §13.8.1), Docker-seed
  Phase 2 build time.
- The operational datum: the live index ran **83% unembedded** (Stage 5 Q4) (duration
  unquantified) — lexical-only in practice — and nobody noticed a quality problem.

**Benefits of keeping vectors (all measured):**
- Retrieval-rank advantages on prose gold sets: kluster-normal H−L = 0.1669 [0.028, 0.306]
  SIG (not robust to lexical-baseline choice: LOO t = 2.206 vs crit 2.228); S-prose T4
  LEVEL 92/100 vs lexical's 82/100; fresh-set off-stratum L+D deficits −7.25/−7.67 pp,
  seed-robust.
- **Zero measured outcome-level benefit at the point estimate**: Q1/OUTCOME b = c = 0 at
  k = 12, including six verbatim-shared queries whose windows differed (overlap 3–9/10)
  and whose answers did not — but this is concordance within bounds, NOT equivalence: the
  95% upper bound on the outcome-changing rate is **22.1%** pooled (25% by rule of three)
  and **≈39%** on the S-ident stratum alone (n = 6). Effective discrimination was below
  nominal k: three of the four mechanical failures are ground-truth extraction artifacts;
  regraded, both marginals are 11/12 — brushing the registered Gate 5 ceiling. The plan's
  own mandated honest phrasing for this result:

  > *Outcome-concordant at k = 12 under mechanical grading — indeed answer-identical on
  > 12/12 — with effective discrimination below 8/12 because three of the four failures
  > are ground-truth extraction artifacts, an S-ident stratum shadowed by
  > Grep-resolvability, and a mechanism that is query authoring rather than re-querying.*

### Gap 1 — the S-prose T4 LEVEL gap vs H, and the kluster-normal H−L baseline

Confronted, not minimized: hybrid genuinely ranks prose queries better, at every scale
tier, seed-robustly. Three measured facts govern its weight:
1. The advantage is retrieval-level only. The single outcome-level measurement in this
   program (Q1/OUTCOME) found rank deltas of exactly this kind produced byte-identical
   `(file, symbol)` answers on 12/12 tasks (bounded — see the ledger: 22.1%/39% upper
   bounds, not equivalence).
2. The mechanism is measured, not conjectured: **0 of 147** harness-run agent searches
   (the 30 Q1/OUTCOME runs: ~15k-chunk corpus, one prompt style, Bash surface, read-only
   investigative tasks) used the question's prose wording — agents rewrite into
   code-token shorthand before searching. The S-prose stratum (TSDoc-derived prose) is a
   query population real agents were never observed to issue. The stratum where vectors
   retain their advantage is the stratum agents demonstrably do not use.
3. The home-field baseline is fragile: kluster-normal significance does not survive
   leave-one-out lexical-baseline selection.

**The bet:** prose-rank advantage does not convert to outcomes because agents rephrase.
Residual risk: a future query population that cannot rephrase (see Gap 5).

### Gap 2 — harm on identifier-free / mixed-case-prose queries: UNTESTED

D fired on 0.67% / 0.50% of the two off-strata — below the registered 10% exposure floor,
so the harm gate structurally could not fire. The realistic shipped-D exposure (mixed-case
prose mentioning **non-target** identifiers) lies outside every stratum and has never been
measured. Confronted:
- The harm mode is mechanically bounded: D reorders only when a query token exactly
  matches a chunk's own `symbol_name` (full or dotted-segment, case-insensitive). The
  failure shape is anchor-displacement — a target demoted by an exactly-named non-target.
- The only observed off-stratum D effect in 3,200 original row-pairs was one instance:
  rank 1→2, still in-window — but D fired on well under 1% of off-stratum queries, so
  near-zero observed harm is the expected consequence of near-zero exposure, not evidence
  of per-fire safety. One displacement among a handful of fires is not a low per-fire harm
  rate; it is a single data point.
- The measured-harmful construction (D+esc) is excluded — F18 ships WITHOUT escape, and
  the esc-arm harm contrast (harmful at every cap, every cell excluding 0) is precisely
  why extending D's reach requires a fresh registration.

**The bet:** the harm surface stays benign at ship because it is mechanically bounded to
exact symbol-name/dotted-segment token matches, not because real off-stratum exposure is
known to be safe — that exposure is declared ignorance, not measured safety. Mitigations
attached as conditions: config kill-switch backed by D-fire displacement telemetry,
regression fixtures, and a dated harvest-review commitment (see Conditions, below).
This stays an explicit bet, not a demonstrated safety property.

### Gap 3 — outcome-at-scale: still Reserve, unmeasured

Q1/OUTCOME ran at ~15k chunks; no outcome A/B exists at 153k. Confronted: the insulation
mechanism (query rewriting + window-membership sufficiency) has no named scale dependence;
the one stratum where scale measurably bit lexical (S-ident) is the one F18 holds flat
T1→T4 (.9867 → .9867, same 148 queries); the remaining deficits are T4 LEVEL gaps, not
scale-growth effects (Q1/SCALE found no significant scale differential on the
non-identifier strata) — fresh-set L+D −7.25/−7.67 pp vs H off-stratum, and the S-prose
LEVEL gap of 10 pp (92 vs 82/100) — on strata the harness log suggests agents don't use.
**The bet:** those gaps don't convert at scale. This is the least-evidenced leg of the
decision and is named as such.

### Gap 4 — counterpart-credit composition and generalization limit

23/148 (15.5%) of L+D's T4 window hits are shell-counterpart credits (H: 14/148); 2 of the
3 queries where L+D beats H are credits. Confronted: the dedup-aware hit rule is the
registered metric and mirrors the shipped shell↔method dedup UX (the shell outline names
the target member and carries the `related` navigation hint), so a credit is a usable
result, not a scoring fiction — but ".9867 ≥ H" is window-parity, not exact-hit parity, and
is recorded as such. Generalization: closure covers symbol-shaped-token queries from
TSDoc-rich exported declarations on this corpus only — and the closure population is
TSDoc-derived **TypeScript** declarations; non-TS languages (the spec's extensibility
target) are outside it. Accepted because that population is inferred to be the dominant
real-query shape — stated honestly: the shorthand-rewriting finding (agents don't reuse
prose wording) rests on n = 147 harness-run searches, while the "identifier-bearing,
median 5 words" shape itself is evidenced only by the organic harvest at n = 2;
"empirically dominant" is therefore an inference from thin real-query data, not a directly
measured population frequency, and is stated as such.

### Gap 5 — a surface the handoff list does not name: doc-chunk retrieval

Markdown `doc` chunks are ranked by the same pipeline, and prose-over-docs is the one
query population where the rewrite-into-code-tokens insulation does NOT apply (docs need
not contain identifiers). No Q1 stratum measured doc retrieval — in either direction:
vectors' benefit on docs is exactly as unmeasured as lexical's sufficiency. Post-delete,
doc search is trigram-BM25-only. Named as part of the bet rather than silently absorbed.
`.md` doc chunks are indexed and ranked by the shipped pipeline TODAY (Q1/OUTCOME had to
exclude them explicitly) — the exposure begins at deletion, not at a future product
decision. The re-entry trigger is therefore doc-retrieval becoming load-bearing OR any
telemetry/harvest evidence of doc-query traffic; current doc-query traffic is unmeasured.

### The bet, in one place

Deleting the vector store on this evidence bets that: (1) prose-rank advantage without
outcome advantage stays outcome-irrelevant, because agents rephrase; (2) D's untested harm
surface stays benign, because its harm mode is mechanically bounded to exact
symbol-name/dotted-segment matches — real off-stratum exposure is declared ignorance, and
the D-fire telemetry condition exists to convert that ignorance into data; (3)
outcome-neutrality holds at 153k, where it was measured only at 15k; (4) window-parity
built partly on shell credits is parity where it counts; (5) doc retrieval survives on
trigram BM25. Any of these can be wrong. None of them is currently evidenced to be wrong,
and the subsystem's dependency and complexity costs are certain (its performance costs are
priced only at the brute-force configuration) while every one of its benefits stops at the
retrieval layer.

### The middle option, considered and rejected

Flipping the default to the already-shipped `--no-embeddings` configuration (MAST_SPEC.md
§13.11; the experimental L arm WAS this configuration) and keeping the vector subsystem
dormant would capture the embed-time/RAM/model-weights-layer costs while remaining fully
reversible. Rejected: never-shipped status already makes deletion cheap to reverse at the
code level, so the reversibility this option buys is not scarce; a dormant 91 MB
dependency and a dead subsystem contradict the deletion-hygiene half of the rationale; and
dormant code paths rot unmeasured.

### DECISION: arm D — delete the vector store; ship F18 (ranker D, WITHOUT escape)

Vectors' value claim has been given four independent, pre-registered chances to
materialize at the outcome level or to find a niche lexical cannot serve. The one niche
that survived three of those chances (S-ident at scale) is now closed: the concept is a
one-line lexical rule, but the shipping artifact is a symbol-gated ranker with
dotted-segment matching, ordering rules, and its own regression suite, measured at
efficacy +14.67 pp [+9.33, +20.0] and a seed-invariant decision-contrast upper bound of
exactly 0. What remains on the benefit side is a prose-stratum rank advantage that the
program's only outcome measurement says does not reach the user (bounded — see the
ledger: 22.1%/39% upper bounds, not equivalence), on queries that 147 harness-run agent
searches (the 30 Q1/OUTCOME runs: ~15k-chunk corpus, one prompt style, Bash surface,
read-only investigative tasks) show agents rewriting away from rather than issuing
verbatim. Against that stand costs that are certain on the dependency and complexity
axes; the 470 MB / 169 ms figures price the brute-force configuration only (arm A with
IVF-PQ was never measured), and the 7.2 h embed is a build-time, cached cost, not a
per-query one. Under the decision rule above, D.

### Conditions attached to the delete (constitutive, not advisory)

1. **F18 scope:** ranker D exactly as measured — symbol-gated, full-name + dotted-segment,
   case-insensitive, WITHOUT the escape variant. Any escape-like extension requires a
   fresh pre-registration (measured harmful as constructed).
2. **Regression suite:** Gate B's fixtures (dotted `Class.method` segment match, camelCase
   full match, case-insensitivity, high-multiplicity-segment ordering) become permanent
   tests, not throwaway instrument checks.
3. **Kill-switch:** D ships behind a config flag, default on — the untested harm surface
   gets an operational escape hatch that is not a code change. F18 ships with D-fire
   telemetry written to the existing `metrics` table: per-query, whether D fired, and the
   pre-fusion vs post-fusion rank of the anchored result and of the displaced result
   (when any). Without this, neither the kill-switch nor re-entry criterion 1 has an
   actual input signal.
4. **Deletion is total at code level** (never-shipped: no migrations, no back-compat):
   `@lancedb/lancedb`, `vectors.lance`, `embedder.ts`/`background-embedder.ts` fork,
   `vectors.lock`, embed cache, model-weights Docker layer, seed Phase 2, the
   `mode` discriminator and cold-start ladder Step 4's embed half. AST/graph/FTS tools are
   untouched (pure tree-sitter + SQLite). The honest `mode` surface post-delete is a
   product design point for F18 productization, not this memo.
5. **The organic harvest remains the standing real-query instrument** — unchanged status.
   The archived embedded assets (`eval/ASSETS.md`) are retained off-repo so re-entry never
   re-pays the 7.4 h embed to reconstruct the H baseline. A dated re-entry review fires at
   organic-harvest n ≥ 67 (the plan's own power target) or 90 days after deletion ships,
   whichever comes first. Organic n = 0 at that review is itself a finding — it means the
   standing instrument has no data source — and forces an explicit re-decision of the
   monitoring plan.
6. **Plan consequences:** Stage 5 Q4 (wire embedder completion) and Stage 4.5 lever 7
   (ANN) become moot; the A-vs-C benchmark is cancelled, not deferred.

### Re-entry criteria — what evidence would reverse this decision

- Harvested agent-authored queries, scoped to those answerable against the frozen
  archived snapshot, showing window-membership degradation vs the archived H baseline
  (the harvest instrument exists; the comparison is pre-registerable then).
- A product shift that makes prose-first retrieval load-bearing (doc search as a feature,
  markdown-heavy corpora) — Gap 5's trigger.
- Sustained D-fire displacement telemetry (condition 3) showing D demoting in-window
  targets on real queries at a rate materially above the single instance observed in this
  program.

Re-entry runs through the A-vs-C benchmark at that time, with the then-current corpus —
not through resurrecting this program's arms.

### Adversarial review of this memo (Fable agent, 2026-08-04)

Verdict: SURVIVES-WITH-REQUIRED-CHANGES. Seven required changes were mandated; all seven
are applied above — the memo now incorporates them. The review's error-direction finding:
the memo's overstatements ran predominantly pro-delete — the same direction the program's
§8 warning names. Full review committed verbatim at `eval/results/m2-memo-review.md`.

---

## Stage 7: Vector-store deletion (2026-08-06, per M2 memo condition 4)

**Goal**: remove the vector subsystem entirely. Post-delete, `mast_search` is L+D exactly
as measured (FTS BM25 + ranker D under RRF). AST/graph/FTS tools untouched.

**Design decisions (recorded before implementation):**

1. **Re-entry anchor is the git tag `mast-pre-vector-delete`** (= `cb69cbc`, the F18
   commit). Instrument re-runs of vector arms and H-baseline reconstruction happen from
   that tag; HEAD does NOT keep the vector-dependent eval imports runnable. The `eval/`
   files stay in-repo as the record, but at HEAD their `dist/search/vector.js` etc.
   imports will not resolve — accepted and recorded (§3 says the experiments are settled;
   re-entry checks out the tag). Archived embedded assets per `eval/ASSETS.md` complete
   the re-entry kit.
2. **Never-shipped ⇒ no back-compat.** The `mode` discriminator and `similarity_score`
   are REMOVED from the search response (not frozen at `"lexical"`/`null`), `mast_status`
   drops `pending_embeddings`/`embedding_mode`/`model` and the `"embedding_backlog"`
   freshness cause, and the config keys `embedding_model`/`transformers_cache_dir` go.
   Sequenced in TWO steps so the excision diff stays pure removal: 7.1 excises the
   subsystem with the response shape temporarily unchanged (`mode` hardcoded
   `"lexical"`, `similarity_score` always `null`); 7.2 redesigns the surfaces honestly.
3. **No `CURRENT_SCHEMA_VERSION` bump**: nothing the new code READS changes shape —
   chunks/graph/FTS are untouched; `vectors.lance`/`embed_cache`/`vectors.lock` become
   orphans. Startup best-effort-deletes orphaned vector state from the state dir (logged,
   never fatal). `metrics.mode` column stays (historical rows); new rows write NULL.
4. **`hybridSearch` is renamed in 7.2** (the name asserts a vector+lexical hybrid that no
   longer exists) — target name `fusedSearch`, via `mast_rename_impact` checklist. The
   `chunkStore` parameter becomes REQUIRED in 7.1, which retires the HANDOFF §5 defect
   "`hybrid.ts:55` defaults chunkStore to the RETIRED Lance chunk table" and the
   "`hybrid.ts:102-104` swallows embedder failure" defect (the swallow goes with the
   embedder).
5. **Deletion list (memo condition 4, mapped to files):** `@lancedb/lancedb` +
   `@huggingface/transformers` deps; `src/store/lance.ts`; `src/search/vector.ts`;
   `src/indexer/embedder.ts` + `background-embedder.ts` (+ fork host wiring in serve);
   the `vectors.lock` half of `src/store/lock.ts`; embed-cache handling; Phase 2 of the
   indexer (`runEmbed`/`selectPendingChunks`); the serve ladder's embed half (the Phase 1
   startup scan STAYS); `--phase1-only` CLI flag (Phase 1 is all there is);
   Docker model-prewarm / mast-seed Phase 2 references (repo-wide sweep in 7.3).

### Stage 7.1: Excise the vector subsystem (pure removal, surface frozen)
**Success criteria**: vector/embedder/lance modules deleted; `hybridSearch` is FTS+D only
with `chunkStore` required; deps removed from package.json + lockfile; suite green with
the response shape TEMPORARILY unchanged (`mode: "lexical"` literal, `similarity_score:
null`); no import of deleted modules anywhere in `src/`.
**Status**: Complete (2026-08-06) — 5 modules + 4 vector-test files deleted;
`hybridSearch(db, input, config, chunkStore)` with `chunkStore` REQUIRED (retires the
HANDOFF §5 retired-Lance-default and swallowed-embedder-failure defects); deps removed:
`@lancedb/lancedb`, `@huggingface/transformers`, plus orphaned `apache-arrow` (logged
deviation, `pnpm why -r`-verified; no other workspace package declares any of the three);
lockfile −50 packages. Suite **446/35 green**; tsc + lint clean; zero-hit grep for
deleted symbols; align **324→324 (+0)** — improved from the +3 baseline (deleted files
no longer emit unresolved `@lancedb`/`@huggingface` specifiers), the 2 real repo-level
violations unchanged and unrelated. Other logged deviations: `ChunkRecord` relocated to
`store/sqliteChunkStore.ts` (its real owner post-Lance); `transformers_cache_dir`
resolution + `embedding_model` config keys deferred intact to 7.2 (avoid inconsistent
half-removal); `mast_search` tool description text deferred to 7.2 (frozen surface).
**Eval-suite resolution (runner decision, not the agent's):** 5 eval instrument test
files (`declex-cli`, `declex-score`, `scale-score`, `idfuse-score`, `scale-rank-check`)
fail at HEAD by design — their import chains reach deleted dist modules. Resolved by
NAMED exclusion in `vitest.config.ts` with the tag pointer (record stays in-repo,
runnable home is `mast-pre-vector-delete`), not deletion (they are the experiment
record) and not a red suite (every commit passes). Vector-independent eval tests
(`declex-ranker`, `idfuse-ranker`, …) still run at HEAD. The stale `@lancedb`
forks-pool comment in vitest.config.ts updated (pool kept for better-sqlite3 /
tree-sitter).

### Stage 7.2: Honest surfaces
**Success criteria**: `mode`/`similarity_score` removed from response + `_stats`;
`mast_status`/CLI status fields per decision 2; orphan-state cleanup on startup;
`hybridSearch` → `fusedSearch` rename with callers; config keys removed.
**Status**: Complete (2026-08-06) — suite **448/35** green (+2 net: −6 removed-field tests,
+8 new: config/index.json old-key tolerance, orphan cleanup incl. EACCES no-throw,
unconditional-cleanup bootstrap); tsc + lint clean; all greps zero-hit except the
tolerance test's own fixture literals (intentional); align 324→324 (+0). Renames done as
git moves (`hybrid.ts`→`fused.ts`, `hybrid-declex.test.ts`→`fused-declex.test.ts`).
Logged judgment calls, ratified: `AppContext.searchMode` deleted (only consumer was the
removed `embedding_mode` field); `freshnessCause(staleFiles)` signature narrowed with its
dead parameter, not just its type; `metrics.mode` column retained for historical rows,
new rows NULL. **Carried finding → 7.3 scope: `packages/mast/README.md` is badly stale**
(documents LanceDB/transformers/mode/similarity_score/embedding config keys) — rewrite
in 7.3 alongside MAST_SPEC.md.

### Stage 7.3: Repo sweep + docs + verify
**Success criteria**: repo-wide grep sweep for transformers-cache/mast-seed/lance
references outside `packages/mast` resolved; MAST_SPEC.md rewritten where the vector
subsystem appeared (§2, §3, §4.1, §5, §6.2, §7.1–7.4, §7.6, §8, §9 `mast_search`/
`mast_status`, §11, §13.1–13.3, §13.8, §13.11, §14); plan + handoff updated; full ladder
green (suite / tsc / lint / align at pre-existing baseline).
**Status**: Complete (2026-08-07) — README fully rewritten; MAST_SPEC.md rewritten
per-checklist with every post-edit grep survivor justified (section numbers kept stable
on deletion to preserve cross-references); repo sweep fixed a GENUINELY BUILD-BREAKING
issue (claude-runner + fold-runner Dockerfiles ran `warm-model.mjs`, which imports the
dependency Stage 7.1 removed — model-prewarm steps deleted, both orphaned scripts
deleted, fold-runner README fixed, CURRENT_STATE.md annotated per its correction
convention); historical records (MAINTENANCE.md, .specify plans, foldv2's own embedder
docs) intentionally untouched and named. Ladder: 448/35 green, tsc + lint clean, align
324→324 (+0). **Runner-executed follow-up to the agent's out-of-scope finding:** the
orphaned `VectorEntry` interface and the stale cosine-gate comment in `ast/types.ts`
(survived 7.1/7.2 — nothing imported them, so no grep tripped) excised; re-verified.
**Open item, user-owned:** `.claude/CLAUDE.md` still describes `mast_search` as
"semantic + keyword discovery" — one-line fix proposed to the project owner (agent
correctly declined to edit an instruction file).

**Stage 7 exit state**: the vector store is fully deleted. `mast_search` is lexical
BM25 + declaration-exact (F18) under RRF — L+D exactly as measured. The M2 memo's
condition-5 monitoring clock is LIVE as of the deletion ship (2026-08-07): the re-entry
review fires at organic harvest **n ≥ 67** or **2026-11-05**, whichever comes first;
organic n = 0 at that review is itself a finding forcing a re-decision of the monitoring
plan. `metrics.declex_json` is the accumulating input signal.

---

