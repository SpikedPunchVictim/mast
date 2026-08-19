<!-- SHARD — do not edit the excerpt below. -->

> **Plan excerpt — ADR 011: Indexing scale: the target, the ladder, and the exponent.**
> Verbatim from `IMPLEMENTATION_PLAN.md` at commit `69a587e`, lines 2509–5634, 5842–6241 (concatenated in that order).
> This is the append-only record the ADR was written from; the ADR is the summary, this is the evidence.
> Nothing here has been edited — see `docs/provenance/verify-plan-shards.mjs` for the losslessness proof.

---

### E1/E2 — the scaling ladder and call-graph denominators: PRE-REGISTRATION (written 2026-08-11, BEFORE any measurement)

**Nothing below may be edited after the first scored measurement.** Amendments are
appended with a timestamp, a reason, and which direction the error runs. Registration is
committed before the instrument is built, per the Q1/OUTCOME and Q1/SCALE precedents.

#### Why one registration for two experiments

**AMENDED 2026-08-12 (A3-C2) — the original economy is dead, and was left standing through
two amendments.** The first draft's rationale was "one shared build, read twice": E1 reads
the **cost** of an index run, E2 reads the **content** of the graph it produced. AMENDMENT 1
moved E1's decision onto the n8n tier ladder and E2's onto `nest`, and A3-MAT-8 below
establishes that E2 cannot read a product build at all — `extractFile` takes no `onCallSite`
parameter (`ast/extract.ts:44-50`), so E2 runs its own harness pass. **No build is shared
between the two experiments any more.**

What *is* shared, and still justifies one registration rather than two: the corpus pinning
and worktree discipline, Gates 0/1, the run-manifest schema, the seeded run-order shuffle,
and the harness itself. They remain **scored and decided separately**; a void on one side
does not void the other, and neither can contaminate the other's measurement — now for the
stronger reason that they no longer touch the same artifact.

#### What this measures — and does not (scope, stated first)

**E1**
- **Indexing cost as a function of corpus size**, on the post-M1 / post-S1 / post-F11
  build. This is a **regression proof for Stage 2**: M1's O(N) claim was measured at
  ≤ ~5k files (nest, directus, common). Nothing has measured whether it survives 5–20k.
- It does **not** measure query or retrieval latency at scale. Q1/SCALE owns retrieval;
  this experiment does not re-litigate it and cannot speak to it.
- It does **not** measure index correctness beyond the integrity gates below. A rung can
  pass every E1 metric while producing a semantically poor index.

**E2**
- **`POTENTIAL_CALL` edge yield against a source-side denominator** on codebases nobody
  here has tuned an extractor against. mast's own `src/` is currently the only corpus with
  this measured (866 / 2,155 ≈ 40%, D7 result).
- It does **not** measure whether emitted edges are **correct**. The `onCallSite` oracle
  checks *accounting* — every visited call site yields exactly one outcome — not truth. A
  wrong edge and a right edge both count `edge_emitted`. Yield is an upper bound on
  precision-weighted coverage, and is reported as such.
- It does **not** re-open Stage 3's kluster-corpus figure (1,038 → 1,124 `this.` + 20
  `super.`). That number stays as recorded; E2 measures external corpora, which is exactly
  what Stage 3's "What is explicitly NOT claimed" note deferred to here.

#### Corpora — a nested ladder inside one corpus, plus a replication panel

**AMENDED 2026-08-11 (A1-F3, A1-F1) and 2026-08-12 (A3-FATAL-2, A3-MAT-9). The original
design made five unrelated repos the decision-bearing axis; it no longer does. The
amended design then stated the ladder's rungs in one unit and cut them in another; it no
longer does that either.**

**Decision-bearing axis (E1): nine seeded nested file subsets of `n8n` at
`9d9e9bf97e8a`**, strict supersets `T1 ⊂ T2 ⊂ … ⊂ T9`. This is the Q1/SCALE recipe verbatim
(that registration's own words: "Single-point measurement at full scale confounds corpus
content with corpus scale"), executed with `eval/scale-build-tiers.mjs`, which is the tier
constructor. (`eval/make-subset.mjs` is **not** tier tooling — it freezes Q1's embedding
subset. The first draft miscited it; corrected per A3-C5.)

**Rungs are defined in chunks, because chunks are the exposure variable the fit uses**
(A3-FATAL-2). The first draft stated targets in *files* — "≈1k / 2k / 5k / 8k / all
indexed files" — and the cut rule in *chunks*, while `scale-build-tiers.mjs:36` cuts on
chunk targets. The two units were simply incoherent, and every published figure downstream
inherited the file-flavoured reading. Targets are now **geometric fractions of the realized
total chunk count `C_total`** of the full n8n index at the pin, spanning **20×**:

| rung | T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 | T9 |
|---|---|---|---|---|---|---|---|---|---|
| fraction of `C_total` | 0.0500 | 0.0727 | 0.1057 | 0.1538 | 0.2236 | 0.3252 | 0.4729 | 0.6877 | 1.0000 |

`f_i = 20^{−(9−i)/8}`, so the rungs are **exactly evenly spaced in `ln N`** — the scale the
fit is performed on, which is what makes `Sxx` computable in advance from geometry alone.
Construction: seeded shuffle (**seed = 811**) of the full indexed file list produced by the
prerequisite build (run **P0**, below); take the file prefix whose cumulative chunk count is
nearest `f_i · C_total`; nesting is automatic because every rung is a prefix of one shuffle.
T9 = every indexed file.

**Nine rungs, not five** (owner decision, discharging A3-MAT-1 and enabling A3-FATAL-1's
fix). It raises the bootstrap's cluster count 5 → 9 (Rademacher atoms 32 → 512; Webb
6-point 6⁹ ≈ 10.1 M), roughly triples `Sxx`, and — the reason that actually matters — buys
**7 lack-of-fit degrees of freedom against 18 of pure error**, which is what makes the
re-derived trigger 1 a real test rather than a coin flip.

Across rungs the only thing varying in expectation is corpus *mass* — the quantity a growth
law is about — not corpus *kind*.

**Realized chunk counts must agree across a rung's repetitions.** Extraction is
deterministic over a fixed file list, so the three reps of a tier must report **identical**
`chunk_count` from their own `graph.db`. Any disagreement is a nondeterminism finding, is
reported as such, and voids that tier pending diagnosis. This is cheap, and it is the only
check that would catch a tier whose file list drifted between reps.

**Replication panel (E1 supporting, E2 external validity), pinned now.**

| rung | repo | pin (this registration commits these SHAs) | role |
|---|---|---|---|
| P1 | `open-telemetry/opentelemetry-js` | `7f3e7eaa9f6b` | replication |
| P2 | `langchain-ai/langchainjs` | `62fc484b2a0d` | replication |
| P3 | `strapi/strapi` | `0a8a9b40d064` | replication |
| P4 | `backstage/backstage` | `25463a867ce7` | replication |
| **N** | **`nestjs/nest`** | **`f7fffd6`** (already pinned, `eval/ASSETS.md`) | **E2 decision-bearing**; E1 replication |

**`n8n` is no longer a panel rung** (A3-MAT-9). It was listed as P5 *and* as the ladder's
source, so the panel's top point was the ladder's top point — the panel's whole claim is
that it is external to the decision-bearing axis, and it was not. **T9 is the full-n8n
measurement**; listing it twice double-counted it and would have let the ladder's own top
rung appear to corroborate the ladder. `nest` still appears in both experiments, which is
benign for the opposite reason: the E1 panel carries **no** verdict, so no verdict is
double-counted.

**Why `nest` carries E2** (A1-F1): §10.3.1's coverage band is explicitly scoped to "a
Fastify + DI service codebase," and **none** of the other five checkouts — P1–P4 plus n8n —
depends on `fastify`, verified by searching every non-`node_modules` `package.json` to
depth 4 in all five. Nest
ships 3 fastify-bearing packages and 48 DI-bearing ones, is already pinned, and is this
project's established honest-broker corpus ("the only corpus nobody here tuned anything
against", `eval/ASSETS.md`). **Registered caveat, stated before measuring:** nest is a DI
*framework*, not a DI *service* built on one. Its call shapes are plausibly more
metaprogrammatic than the spec's referent. This makes nest the best available test of the
band and still an imperfect one; the verdict language below is scoped accordingly, and
adding a genuine Fastify+DI *service* corpus sits in the Design Reserve.

Pinned via `git worktree add --detach <sha>` per `eval/ASSETS.md` (**never `rm -rf` to
remove — `git worktree remove`**). Source checkouts live at `~/temp/enterprise-apps/`;
those are live working copies at whatever HEAD `update-repos.mjs` last left, which is
precisely why the ladder measures detached worktrees at the SHAs above and not the
checkouts themselves.

**Index configuration is pinned too** (A1-F9). Every run indexes under `resolveConfig`'s
**defaults as of this commit, with no overrides** — `file_extensions` `['.ts','.tsx',
'.js','.jsx','.md']`, `exclude_patterns` `['**/node_modules/**','**/dist/**',
'**/coverage/**','.kluster/**','**/*.test.ts','**/*.spec.ts']` (`store/config.ts:39-48`).
The resolved config is recorded in every run manifest. An unpinned config is a free lever
over `N` itself; note in particular that `.md` **is** indexed and that `*.test.js` /
`*.spec.js` are **not** excluded, so neither the "source files" intuition nor the raw
`find` below describes what actually gets indexed.

**No remembered file count is evidence.** The Stage 4 E1 row quotes otel 902 /
langchainjs 2,047 / strapi 3,600 / backstage 7,021 / n8n 12,641. Those figures have **no
provenance anywhere in this plan** — no result block produces them — and a raw `find` for
`.ts/.tsx/.js/.jsx` outside `node_modules` over today's checkouts gives **1,059 / 2,153 /
4,895 / 7,645 / 19,056**. **Neither set is the measurement, and the `find` figures are the
wrong anchor in both directions** (A1-F9): they count test files the config excludes and
omit the `.md` files it includes. The ladder's x-axis is **the chunk count `runIndex`
actually produced under the pinned config**, read from each run's own `graph.db` at Gate 1.
The quoted figures are retained only to show the panel is roughly log-spaced; a realized
count that reorders it re-orders the panel, and the discrepancy is logged as a finding.

**AMENDMENT 1 disavowed that anchor and then went on using it** (A3-FATAL-2, second half).
Every quantitative claim it published — span 18.0×, `N log N` effective exponent 1.120,
`Sxx ≈ 16.1`, `SE(b) ≈ σ/4.01`, the `σ < 0.47` reachability ceiling — was computed on the
raw-`find` counts in the very paragraph that called them the wrong anchor. Those figures are
**withdrawn**. The amended arithmetic below is derived from the ladder's *geometry* (evenly
spaced in `ln N` by construction, so `Sxx` depends only on the rung count and the span) and
is **re-derived from the frozen manifest's realized chunk counts at Gate 1b before any
scoring**. Nothing in the verdict machinery depends on a remembered count.

This inherits Q1/SCALE's corpus-truth lesson literally: that experiment's headline count
was the CLI stdout counter and was wrong by 14,529 chunks. **Ground truth is a `SELECT
COUNT(*)` against `graph.db`, never stdout.**

#### Design — cold builds, randomized run order, three repetitions

Each **run** = one corpus (tier or panel rung) × one repetition, into a **fresh state
dir**, never `--incremental`. Three repetitions each: 9 tiers × 3 = **27 decision-bearing
runs**, plus 5 panel corpora × 3 = **15 replication runs**. Run order is a **committed
seeded shuffle (seed = 811)** over all 42 (corpus, rep) pairs, so corpus size cannot align
with OS page-cache warmth or thermal drift — at this timescale (seconds to a minute per
run) those are the dominant non-corpus variance sources, and a naive small-to-large
ordering would confound them with the exposure variable exactly.

**Run P0 — the prerequisite full-n8n build, registered rather than assumed**
(A3-FATAL-3). The tier manifest cannot be frozen without it: `scale-build-tiers.mjs:3-5`
reads a **completed `graph.db`** to obtain the per-file chunk counts the cut rule needs. The
first draft, and AMENDMENT 1 after it, required this build implicitly and put it in **no
gate, no run count and no cost line** — on a harness that, like every `eval/*.mjs`, imports
from `../dist/` directly, which is exactly the exposure Gate 0 exists for. P0 is therefore:

- **Run under Gate 0 and Gate 1 in full**, with its own manifest entry, `schema_version`,
  `dist/` build timestamp, resolved config, and `graph.db`-sourced counts.
- **Excluded from every fit**, from both run counts above, and from every verdict. It is
  construction, not measurement.
- **Declared as a peek.** P0 yields a T9-scale `durationMs` observed *before* the ladder is
  frozen. The mitigation is ordering, and it is binding: **this amendment — the rung
  fractions, seed 811, the 1.35 threshold, the estimator, every trigger and every gate — is
  committed before P0 runs.** With the verdict machinery already immutable, a glimpse of one
  duration cannot tune anything. Said plainly rather than hidden: the investigator will have
  seen roughly what a full n8n index costs before the scored runs begin.

**Fixed-overhead calibration run** (A1-F4a): before the shuffle, the harness performs
**10 index runs against an empty corpus** (a directory with zero indexable files). Their
median `durationMs` is `c` — `runIndex`'s own fixed cost (walk setup, `loadIndexMeta`,
`openDatabase`) with zero indexing work in it. `c` is recorded in the manifest and used by
the estimator below. Without it the pure power law absorbs an additive constant and biases
`b` **downward**, which flatters HOLDS.

#### Measured rows

| id | row | source | inherited from |
|---|---|---|---|
| **E1-R1** | growth law: index wall-clock vs corpus size | `runIndex` result + independent wall clock | D6 RESCOPE |
| **E1-R2** | parse-only vs full-index ratio | harness parse pass vs full run | D6 RESCOPE |
| **E1-R3** | state-size linearity: `graph.db` bytes ÷ `chunk_count` | `stat` + SQL | D6 RESCOPE |
| **E1-R4** | WAL checkpoint cost at scale | `PRAGMA wal_checkpoint` at run boundaries | Q6 RESCOPE |
| **E1-R5** | HEAD-topology probe under concurrent readers | reader wall clock + `mast metrics --locks` | Q6 RESCOPE |
| **E2-R6** | `POTENTIAL_CALL` by `resolution` ÷ source-side call sites | `onCallSite` seam + SQL | D6 RESCOPE → E2 |

**E1-R2 construction, and its validity risk.** No parse-only mode exists in the product —
`mast index` has `--state-dir`, `--incremental`, `--show-progress`, `--checker` and
nothing else, and the `nest --phase1-only` figure in Stage 2's success criteria came from
the spike era, not from a shipped flag. The harness therefore builds its own parse pass
(walk → read → tree-sitter parse → `extractChunks`/`extractEdges`, no `graph.db` opened,
no writes) over the identical file list. **This is a harness reimplementation of Phase 1's
parse half, not a product mode**, and the ratio inherits whatever drift the
reimplementation carries. Gate 2 is what makes it usable. Adding a `--parse-only` flag to
the product to serve a measurement is out of scope — E1 is an experiment, not a feature.

**Gate 2 no longer checks edge count** (A1-F2). The original text required the parse pass
to match the full index on chunk count **and edge count**. That is structurally
impossible: `insertEdges` silently drops every edge whose from/to name fails DB resolution
(`graph/populate.ts:425` TSDoc; drop sites `:537`, `:543`) and dedupes on `PRIMARY KEY
(from_id, to_id, edge_type)` via `.onConflict(doNothing())` (`populate.ts:556-567`,
`graph/db.ts:257`), so N call sites between one symbol pair collapse to one row and every
call into an external package vanishes. No product-side extractor-level edge counter
exists. The gate would therefore have voided R2 on every corpus, or been "satisfied" by
the harness comparing its own extraction to its own extraction — proving nothing.
**Registered consequence:** R2's ratio covers Phase 1's parse half only and **excludes
pass-2 name resolution and edge insertion by construction**. It is a parse-vs-write-path
ratio over the chunk pipeline, not over the whole index, and is read as nothing more.

**E1-R5 construction, and the honest limitation.** The probe runs against an
**already-built, warm state dir** while a *second* full index writes into it — the
production topology (`mast serve` holding readers open while a reindex runs), and the
post-F11 configuration nothing has ever measured. Reading against a state dir
mid-*first*-build would return `index_empty`, which is a confidence signal, not a latency
measurement.

**Registered, after A1-F6 — the parameters the first draft left free; amended 2026-08-12
per A3-MAT-3/5/6:**
- **Corpora: T1 and T9** (the ladder's smallest and largest). Running only a small corpus
  is the one configuration where the ABSENT branch is easily reachable, and leaving the
  choice open was a free lever toward retirement.
- **K = 4 concurrent readers**, and this is an admitted convenience, not a derived number
  — rounds 1–2 swept N ∈ {1..8}. K = 4 sits mid-sweep; a sensitivity sweep is in the
  Design Reserve.
- **Minimum 400 scored reader calls per corpus**, paced at one call per reader per 250 ms.
  Without a registered denominator, "≥ 1% of calls" over a few dozen calls degenerates to
  "any single call."
- **A call is scored only if it overlaps write activity** (A3-MAT-5). Its start **and** end
  timestamps must fall strictly inside a writer index run. 400 calls at K = 4 paced 250 ms
  is ≈ 25 s of reader traffic against a T1 pass measured in single-digit seconds, so under
  the first draft's wording most scored calls would have seen **no writer at all** — diluting
  a ≥ 1% criterion by roughly the duty cycle and pushing R5 toward ABSENT for free. The
  writer therefore runs **repeat non-incremental indexes back-to-back** until the scored
  count is reached, and unscored calls are recorded but excluded. (Verified benign: a
  non-incremental reindex genuinely rewrites everything — `toIndex = currentFiles`,
  `indexer/index.ts:232`, and the skip is gated on `options.incremental` at `:278` — so
  repeat passes are real write load, not no-ops.)
- **Query payload: derived from the probed corpus's own index** (A3-MAT-3). The first draft
  reused Q1/SCALE's frozen probes (`eval/scale-queries.json`) — which are **vscode-specific**
  (`strata.probes.queries[0]` targets `supportsTelemetry` in
  `src/vs/platform/telemetry/common/telemetryUtils.ts`) — against n8n tiers. Absent terms
  are the cheapest reads a search engine performs: FTS5 returns empty early and ranker D
  never engages, which suppresses exactly the contention R5 exists to detect. The payload is
  instead **10 declaration names sampled with seed 811 from that corpus's own `symbols`
  table**, stratified to span common and rare terms, emitted as
  `eval/e1r5-queries-<corpus>.json` and **committed before the probe runs**.
- **Per-corpus idle baseline, measured first:** the same K readers, same payload, same
  count, with **no writer running**. The stall metric is **excess over that corpus's own
  idle baseline**, not an absolute number.

**Why the thresholds moved** (A1-F6a/b). The original registered 1,700 ms; round 1's own
instrument field is `wal_checkpoint_outliers_gt_1500ms` (verified in
`eval/e7-concurrency.json` and `eval/e7-round2.json`), so **1,500 ms** is the measured
signature's own threshold and is what this registration now uses — the looser number
flattered retirement for no stated reason. The original's other bound, 755 ms, was
imported from round 2's Arm B **server-side lock-hold** envelope on **nest** at **~1.3k
files** on a **pre-F11** build, and compared against **client wall clock of `mast query`
CLI processes** — a different plane, corpus, scale, and build. Each `mast query` call is a
fresh node process that resolves config, opens the DB and registers all tools
(`cli/query.ts:79-113`), so at T9 scale it can plausibly exceed 755 ms with zero stalls.
**That bound is withdrawn** and replaced by the idle-baseline comparison above.

**Reader lifecycle, stated as an unargued gap.** Production's topology is `mast serve`
holding connections open; the probe uses process-per-call CLI readers, which rebuild the
wal-index and reopen the DB every call. `mast query` does dispatch through the real MCP
handlers (`cli/query.ts:142-155`), so the *read path* is the shipped one — but the
*connection lifecycle* is not, and that is exactly the dimension a WAL probe is sensitive
to. Registered as a known external-validity limit of R5, not resolved.

**There is no non-invasive in-flight backlog probe.** `PRAGMA wal_checkpoint(PASSIVE)`
*performs* the checkpoint work it would be observing, so sampling it during the write
would measure the instrument. Backlog is therefore read **at run boundaries only** (before
the write starts, after it completes); during the write the observables are reader latency
and `mast metrics --locks` hold/wait distributions, both non-invasive. This limitation is
registered, not discovered later.

**Direction-of-error statement for R5** (A1-F6f, absent from the first draft): the
investigator's effective prior is **retirement** — round 2 measured the signature absent,
and the Q6 RESCOPE already retired it for the pre-F11 system. Every free parameter the
first draft left open (threshold, corpus, denominator) leaned that way. The ABSENT branch
therefore carries the harder requirement: both corpora, the full 400-call minimum, and the
idle-baseline comparison, not an absolute threshold that scale alone could satisfy.

#### Exactly one decision-bearing test per experiment

**E1 — the growth exponent.** Fit `(durationMs − c) = a · N^b` by OLS on log–log over the
**27 tier runs**; `b` is the growth exponent, `b = 1` is linear (cost per unit flat).

**The fitted clock is `runIndex`'s own `durationMs`** (`indexer/index.ts:173` → `:414`),
not the external wall clock (A1-F4c — the first draft named two sources and fitted
neither, which is a free lever). `c` is the calibration constant measured above. Both the
**adjusted** fit (`durationMs − c`) and the **raw** fit (`durationMs`) are reported; **if
they land on opposite sides of 1.35 the verdict is AMBIGUOUS**, which removes the choice
between them as a post-hoc lever.

**Estimator** (A1-F4b — 5-cluster BCa is withdrawn as unsound; its acceleration constant
comes from a delete-one jackknife over five values, ~10% of cluster resamples contain ≤ 2
distinct tiers and ~0.16% contain one, for which the slope is undefined, and the first
draft registered no handling for degenerate resamples):
- **Primary: OLS over the 27 tier runs with HC3 heteroscedasticity-robust standard errors**
  (df = 25), 95% CI on `b` using `t₀.₉₇₅,₂₅ = 2.060`. The nested design is what licenses
  this — tiers are subsets of one corpus, so a tier's cost is a fixed quantity plus
  run-to-run noise, not a draw from a population of corpora.
- **Sensitivity, reported always: a wild cluster bootstrap over the 9 tiers**, with the
  parameters A3-MAT-1 found unregistered:
  - **Webb 6-point weights**, not Rademacher. At 5 clusters Rademacher offers 2⁵ = **32**
    distinct weight vectors, so AMENDMENT 1 traded BCa's degeneracy for a bootstrap whose
    reference distribution has 32 atoms — one degenerate method for another. Nine clusters
    give Rademacher 512 atoms, which is workable but still coarse in the tails a 95% CI
    reads; Webb's 6-point weights give 6⁹ ≈ **10.1 M**. Webb is the standard remedy for
    exactly this small-`G` regime.
  - **10,000 draws, seed 811, cluster = tier.**
  - **Restricted residuals** (imposing `H₀: b = 1.35`) for the **hypothesis test**;
    **unrestricted residuals** for the **percentile-t CI**. This is the Cameron–Gelbach–Miller
    convention, and leaving the choice unregistered was a free lever over the headline
    interval.
  - **Studentized (bootstrap-t) intervals**, studentizing with the CR1 cluster-robust SE —
    not raw percentile, which is the weaker construction at small `G`.
  **If the primary and the sensitivity land on opposite sides of 1.35, the verdict is
  AMBIGUOUS.**
- The **replication panel** (5 corpora × 3 reps) is fitted the same way and reported, but
  is **supporting only and never carries a verdict** — content confounds scale across
  unrelated repos, which is the whole reason the decision-bearing axis is nested.

**The exposure variable is `chunk_count`, not file count.** `b_chunk` is decision-bearing;
`b_file` is supporting. Reason: the write path scales in chunks — the O(n²) pathology
Stage 2 removed was per-chunk-write against Lance's manifests — while mean file size
varies across these five corpora as a matter of corpus *content*, so a file-count exponent
would fold content variation into the scale estimate. Both are reported.

**Registered threshold: `b = 1.35`.**

| observed | verdict |
|---|---|
| `b_chunk` 95% CI **upper** bound < 1.35 — on the HC3 primary **and** the wild-cluster sensitivity, **and** on both the adjusted and raw fits | **O(N) HOLDS at ladder scale.** Stage 2's regression proof extends from ~5k files to T9. |
| `b_chunk` 95% CI **lower** bound > 1.35, on the HC3 primary | **SUPER-LINEAR REGRESSION.** M1's O(N) claim does not extend; Stage 2 reopens as a scale defect. |
| CI straddles 1.35, **or** primary and sensitivity disagree across it, **or** adjusted and raw disagree across it | **AMBIGUOUS.** Report; escalate by adding tiers or repetitions, never by reinterpreting and never by adding an unrelated corpus. |

Why 1.35, registered before the numbers exist so it cannot be tuned: FTS index growth is
expected to contribute a mild `N log N` term, so a threshold at 1.0 would fail a healthy
system by construction. Across the ladder's **20× span in chunks**, that term's *effective*
exponent is `1 + ln(ln N_max / ln N_min) / ln 20`, which for any plausible realized
`C_total` in [50k, 200k] chunks evaluates to **1.09–1.11** — 1.094 at 200k, 1.101 at 100k,
1.108 at 50k. Call it **≈ 1.10**; it is re-derived exactly at Gate 1b. The pathology class
this experiment exists to detect is quadratic (`b ≈ 2`): across the same span, `b = 1.35`
costs **2.85×** more than linear and `b = 2` costs **20×**. 1.35 sits above the expected
`N log N` and far below the pathology.

(The 18.0× / 1.120 / 2.75× / 18× figures from AMENDMENT 1 are withdrawn — A3-FATAL-2: they
were computed on the raw-`find` **file** counts that same amendment disavowed, for a ladder
that is cut on **chunks**. The threshold itself, 1.35, is unchanged; it was registered at
`5b16b4d` and both the old and new rationales place it in the same gap.)

**Power, and the reachability arithmetic** (A1-F4d; re-derived per A3-FATAL-2 and extended
per A3-MAT-1). Because the rungs are evenly spaced in `ln N` by construction, `Sxx` follows
from geometry alone and does not depend on any remembered corpus count. With 9 rungs
spanning 20×, the spacing is `d = ln 20 / 8 = 0.3745`, and `Σ_{k=−4}^{4} k² = 60`:

- **Cluster level (9 tier means):** `Sxx = 60 d² = 8.414`, `SE(b) = σ_tier / 2.901`, df = 7,
  `t₀.₉₇₅,₇ = 2.365`. HOLDS needs `b̂ + t·SE < 1.35`; at the expected `b̂ ≈ 1.12` that
  requires **`σ_tier < 0.28`**.
- **Run level (27 runs):** `Sxx = 3 × 8.414 = 25.24`, `SE(b) = σ / 5.024`, df = 25,
  `t₀.₉₇₅,₂₅ = 2.060` → **`σ < 0.56`**.

**Both are published, and the cluster-level one is the honest number** (A3-MAT-1). HC3 over
27 runs at 9 distinct x-values treats tier-level lack-of-fit as if it shrank with
repetitions, and it does not: adding reps drives down pure error while leaving any
systematic tier-level departure untouched. Quoting only `σ < 0.56` would therefore overstate
the design's power in precisely the situation the experiment cares about. **Widening 5 → 9
rungs is what makes the honest ceiling livable:** at 5 rungs the same calculation gives
`Sxx_cluster = 5.22`, df = 3, `t = 3.182`, and `σ_tier < 0.165` — a bar ordinary
between-tier variation could plausibly breach, i.e. a HOLDS branch at real risk of being
arithmetically unreachable. Q1/SCALE published its `n_min = 154`; this is the analogue.

**This design is still sized to detect a quadratic regression, not to resolve `b = 1.0`
from `b = 1.2`.** If the realized CI straddles 1.35 from below 1.0, the honest verdict is
AMBIGUOUS-underpowered, and the registered escalation is more tiers or more repetitions —
never a narrower threshold, and never (as the first draft wrongly proposed) another
unrelated corpus, which would deepen the confound rather than resolve it.

**Registered consistency triggers.**
1. **Lack of fit — RE-DERIVED 2026-08-12 (A3-FATAL-1). The previous form was wrong in the
   investigator's favour and had been re-certified as "verified and unchanged."** It read:
   *"if `ms/chunk` is strictly monotonically increasing across all five tiers (p = 1/120
   under exchangeability) while the CI discharges → AMBIGUOUS."* Under the very `N log N`
   model used two paragraphs above to justify `b = 1.35`, `ms/chunk ∝ log N`, which **rises
   ~41% across the span** (`ln 19056 / ln 1059 = 1.415` on the old ladder; ~1.35 on the
   amended one) — so **strict monotone increase is the *expected healthy* signature**, and
   the trigger fired on it. Worse, the registered escalation for AMBIGUOUS is *more
   repetitions*, which tightens tier means and makes a monotone ordering **more** likely: an
   escalation that increases the chance of the outcome it is escalating from. `ms/chunk` is
   not exchangeable across tiers under the fitted model, so no permutation argument applies
   to it at all.

   **The trigger now applies to departure from the fitted law, which is what "the single
   exponent misdescribes this ladder" actually means.** With 3 reps at each of 9 rungs the
   classical decomposition is available and is the right instrument:
   - **Statistic:** the lack-of-fit `F` test on the **adjusted** log–log fit —
     `F(7, 18)` = (lack-of-fit MS, 9 − 2 = 7 df) / (pure-error MS, 9 × (3 − 1) = 18 df),
     at **α = 0.05**.
   - **Registered on the adjusted fit only.** The raw fit carries a known omitted additive
     constant, which *guarantees* curvature, so a raw-fit lack-of-fit test would fire by
     construction and mean nothing. The raw `F` is reported as descriptive.
   - **A practical-significance floor, required jointly with significance.** The trigger
     fires only if `F` is significant **and** the fitted quadratic-in-`ln N` term implies a
     departure from the straight-line fit exceeding **5% in predicted time at the ladder's
     endpoints**. Benchmark, computed for this ladder's geometry: the `N log N` term's own
     curvature produces a maximum endpoint departure of **0.69%** in log-time (mid-ladder
     +0.47%, endpoints −0.69%). A 5% floor clears that by ~7× while sitting far below a
     linear-plus-quadratic mixture's signature. Without the floor, a design with tight pure
     error would fire on the 0.7% term itself and AMBIGUOUS would be predetermined — the
     A1-F4d defect class.
   - **Fires → AMBIGUOUS**, with the registered escalation (more rungs or more reps).
   - **What it does and does not detect, stated plainly:** a *pure* power law of any
     exponent is a straight line in log–log, so this trigger is silent on quadratic-only
     data — the CI on `b` owns that case. It detects **mixtures**, e.g. a linear pipeline
     with one quadratic subcomponent that only dominates at scale, where a single exponent
     is the wrong description of the ladder. The two instruments are complementary, not
     redundant; the previous trigger was neither.
2. Any run with `write_errors > 0` is **VOID** — that is an S1 regression, and S1's whole
   point was that a non-zero `write_errors` means chunks are silently absent from the index.
   Diagnose, then re-run.
3. If R3's `bytes/chunk` at T9 exceeds 1.5× T1's, it is flagged and discussed in the result;
   it does not alone force AMBIGUOUS (state overhead has a fixed component that amortizes
   differently across a 20× span).
4. **Parse-error rate** (A1-F12). Files that fail to parse consume walk/read/parse time and
   contribute **zero** chunks, so a parse-error rate that rises with tier size inflates
   `ms/chunk` with `N` through a channel the model does not represent. If any tier's parse-
   error *rate* exceeds 2× the median tier's, it is flagged and **must be discussed before
   the verdict is recorded**. (Nested tiers make this unlikely — they are subsets of one
   corpus — which is another reason the nested axis is decision-bearing; the panel, where
   vendored/fixture density genuinely varies, is supporting only.)
5. **`b_file` vs `b_chunk` disagreement** (A1-F10). If the supporting file-count exponent
   and the decision-bearing chunk-count exponent land on opposite sides of 1.35, that is
   reported and discussed — it means chunks-per-file is itself varying with scale — but it
   does not override the registered exposure choice.

**Direction-of-error statement, in advance:** the investigator's prior is that M1 fixed
this — O(N) was proven at small scale and Stage 2 is marked Complete. **"O(N) HOLDS"
flatters that prior.** The HOLDS branch therefore carries the harder requirements: a CI
upper bound rather than a point estimate near 1, trigger 1 above, and a mandatory
adversarial results review before the verdict is recorded.

**E2 — the §10.3.1 coverage band.** §10.3.1 reads, verbatim (`MAST_SPEC.md:2018-2024`):
"In a Fastify + DI service codebase, the resolver catches roughly the field/parameter/
import cases — **typically 60–80% of real call sites** depending on how heavily the
codebase uses factories and containers." Quantity: `edge_emitted ÷ total call sites
visited`, from the `onCallSite` seam run over a corpus's indexed file set.

**Decision-bearing corpus is `nest` alone** (A1-F1). The claim is scoped to Fastify+DI, and
the other five checkouts — P1–P4 plus n8n, the ladder's source — contain no Fastify at all;
testing a scoped claim against out-of-scope corpora and then mandating a spec rescope is not
a test, it is a formality that returns the investigator's prior.

| observed on **nest** | verdict |
|---|---|
| yield ≥ 60% | **SUPPORTED.** §10.3.1's band holds on the closest available Fastify+DI corpus. Whether the realized value also falls below 80% is descriptive; the upper edge is not a failure condition. |
| yield < 60% | **NOT ATTAINED** (softened 2026-08-12, A3-MAT-2, owner decision). Registered reading: *the band is not attained on the closest available Fastify+DI corpus.* That is **evidence for a spec revisit, not a mandate** to rescope §10.3.1 or remove the figure. Reason: `n = 1`, and the one corpus is a DI *framework* rather than the DI *service* the spec names — a single out-of-referent miss cannot carry a spec change on its own. Recorded as a spec-drift **candidate**, alongside the P3 items, for a decision that weighs it against the caveats rather than executing on it. |

The table is exhaustive by construction — the first draft's three rows left the pattern
"one corpus above 80%, none in 60–80%" with **no verdict at all** (A1-F7), which is the
Q1/SCALE AMENDMENT-1 F3 class: verdict machinery undefined on a reachable data pattern,
resolvable only post-hoc by the prior.

**P1–P4 and n8n are external validity, and carry no verdict.** Their yields are reported in
full and answer a different, narrower question: how far the band travels outside its stated
scope. A miss on all of them licenses **no** spec change.

**Direction-of-error statement:** mast's own `src/` measures 40%, below band, so the
investigator's prior is that the band is optimistic — **NOT ATTAINED flatters that prior**.
That branch therefore carries the mandatory adversarial results review, and the nest caveat
above (framework, not service) must be restated wherever the verdict is quoted.

**The denominator is narrower than the spec's** (A1-F8), and this is registered rather than
discovered later. §10.3.1's band is over "real call sites"; the seam's denominator is
`collectCalls`' *visited* sites, which **by design** exclude calls inside nested-scope
function/method/class bodies (D7 result: such calls "are never handed to `parseCallee` and
are therefore, by design, outside this invariant"). Callback-heavy code — promise chains,
array HOFs, route-handler closures — is systematically absent from the denominator, so the
measured yield **overestimates** coverage of real call sites. Direction: this runs
**against** the UNSUPPORTED prior. Mitigation: every corpus additionally reports raw
`call_expression` node count alongside visited sites, so the size of the excluded region is
quantified rather than assumed small.

Supporting, reported in full, never dispositive: the by-`resolution` breakdown (`SELECT
resolution, COUNT(*) FROM edges WHERE edge_type='POTENTIAL_CALL' GROUP BY resolution`),
including the `this_method` / `super_method` share F4 shipped; the four-way `CallSiteOutcome`
distribution per corpus against mast's own 866 / 604 / 592 / 93 baseline.

**E1-R5's falsification, registered separately** (it is a defect probe, not a growth law):
round 1's signature was periodic **1.7–3 s** reader stalls.

| observed, on **each** of T1 and T9, over ≥ 400 scored calls (scored = overlapping write activity) | verdict |
|---|---|
| ≥ 1% of reader calls exceed **1,500 ms** (round 1's own instrument threshold) | Round-1's stall class is **PRESENT at HEAD**; Q6 reopens as a live defect. |
| 0 calls exceed 1,500 ms **and** that corpus's p99 exceeds its own idle-baseline p99 by **≤ 250 ms in absolute terms** | **ABSENT at HEAD topology** — which, with round 2's pre-F11 null, retires the class. |
| anything between | Reported; class **INDETERMINATE**. |

**The "within 2× idle baseline" multiplier is withdrawn** (A3-MAT-6). It was derived
nowhere, and it is **vacuous at T9**: any corpus whose idle p99 reaches 750 ms has a 2×
bound of ≥ 1,500 ms, at which point the clause is strictly implied by the row's other
condition and contributes nothing. The replacement is absolute and derived: round 1's
signature was periodic **1,700–3,000 ms** stalls, so an excess an order of magnitude below
the *smallest* stall ever observed is the operative "no trace of this class" bar — hence
**250 ms**. Direction, stated because it matters: an absolute bar is **harder** to satisfy
at T9 than a multiplier would be, so this change runs **against** retirement, which is the
correct direction given R5's registered prior.

Both corpora must land in the same row for a clean verdict; a split (e.g. ABSENT at T1,
INDETERMINATE at T9) is reported as INDETERMINATE overall, because scale is exactly the
axis this row exists to probe.

#### Registered readings for the supporting rows (A1-F10)

The first draft measured R2, R3 and R4 and registered no interpretation for any of them —
in a design whose banner is "exactly one decision-bearing test per experiment", a measured
row with no registered reading is a post-hoc lever. Each now has one, and none carries a
verdict:

- **R2 (parse ÷ full ratio):** descriptive. It answers "how much of Phase 1's chunk pipeline
  is parsing versus writing", scoped by the exclusion above. No threshold; no verdict; its
  only registered use is to inform where a future optimisation would pay.
- **R3 (`graph.db` bytes ÷ chunk_count):** descriptive, policed by trigger 3. It is the
  successor signal to the retired Lance `_versions` row, and a flat value across tiers is
  the *expected* post-M1 picture, not a discharge criterion for anything.
- **R4 (checkpoint cost at scale):** descriptive, and explicitly **not** a defect test. It
  exists to give the deferred `wal_autocheckpoint` question (Q6 RESCOPE item 4) real numbers
  to be decided against instead of speculation. Registered reading: boundary
  `PRAGMA wal_checkpoint` `(busy, log, checkpointed)` and TRUNCATE wall-clock per tier,
  reported as a curve against chunk count. **No threshold is registered because none is
  justified by anything measured so far** — inventing one here would be a post-hoc lever
  wearing a pre-registration's clothes.

#### Falsification criteria (pre-stated)

- **Super-linear indexing (the regression outcome):** `b_chunk` CI lower bound > 1.35 on the
  nested tier ladder.
- **O(N) holding:** `b_chunk` CI upper bound < 1.35, on both the primary HC3 fit and the
  wild-cluster sensitivity, adjusted and raw.
- **The spec's coverage band failing:** `nest` yield below 60% — read as NOT ATTAINED, per
  the softened consequence registered above.
- **The round-1 stall class living at HEAD:** ≥ 1% of concurrent-reader calls over 1,500 ms
  **on both probed corpora** (A3-MAT-4 — this bullet previously read "on either probed
  corpus" while the verdict table says a split is INDETERMINATE overall. The contradiction
  was introduced by AMENDMENT 1, which added the second corpus here but not there. **The
  table wins**, because the table is the instrument that is actually scored, and "either"
  would have made a single-corpus PRESENT reading dispositive against a design that
  deliberately probes two scales).
- Every one of these is falsifiable in both directions; no outcome here is "no result."

#### Gates before any scored measurement

0. **Binary identity — the D8 gate.** `pnpm -F mast build` runs first; the run manifest
   records `mast status --json`'s `schema_version` and `dist/`'s build timestamp; the
   harness invokes the freshly built binary **by absolute path**, never a `PATH` lookup.
   Any run whose recorded `schema_version` ≠ the source tree's `CURRENT_SCHEMA_VERSION` is
   **VOID**. This gate exists because D8 established that a stale gitignored `dist/` served
   three days and one schema version of agent sessions undetected, and because **every
   `eval/*.mjs` script imports from `../dist/` directly** — the harness is exposed to the
   identical failure. Rebuild is not restart: any long-lived `mast serve` involved in R5
   must be started *after* the build. **This gate covers run P0** (the prerequisite
   full-n8n build) and **E2's harness pass**, neither of which the first draft brought
   under it — see A3-FATAL-3 and A3-MAT-8.
1. **Corpus integrity, per run:** detached worktree at the pinned SHA with
   `git status --porcelain` empty; tier file lists match the frozen tier manifest exactly;
   `write_errors == 0` (else VOID, per trigger 2); `parse_errors` **recorded but not gated**
   — corpora legitimately contain files this extractor cannot parse, and gating on that
   would silently select for corpora that flatter the tool, so the rate is policed by
   trigger 4 instead; indexed file count and chunk count read from `graph.db`, never stdout;
   the resolved config recorded in the manifest. **Added 2026-08-12:** a tier's three
   repetitions must report **identical** `chunk_count`; disagreement is a nondeterminism
   finding and voids that tier pending diagnosis.
   **Gate 1b — ladder geometry and reachability, re-derived from the frozen manifest before
   any scoring** (A3-FATAL-2). Once P0 has run and the 9 rungs are cut, the harness computes
   and **commits**, from the manifest's realized chunk counts: the realized span, each rung's
   realized fraction of `C_total`, `Sxx` at run and cluster level, both `SE(b)` multipliers,
   both σ ceilings, and the `N log N` effective exponent. The projected figures above
   (`Sxx_cluster = 8.414`, `σ_tier < 0.28`, `σ < 0.56`, `b_eff ≈ 1.10`) assume rungs land
   exactly on their target fractions; real file prefixes land near, not on. **If the realized
   `Sxx_cluster` falls more than 20% below 8.414, the cut is re-examined before any scored
   run** — not after, and never by moving the threshold. This gate exists because AMENDMENT 1
   published an entire power analysis computed on an anchor it had itself disavowed in the
   same document; arithmetic that is never re-derived against reality is decoration.
2. **Parse-only fidelity (R2):** the parse pass's **file count, chunk count and symbol
   count** must equal the full index's **exactly**. Edge count is deliberately **not** in
   this gate — see the R2 construction note above (A1-F2): edge rows are lossy and deduped
   relative to extractor emissions, so equality is structurally impossible and requiring it
   would void R2 everywhere. Any mismatch on the three checkable counts voids R2 for that
   run.
3. **Cold-start discipline:** fresh state dir per run; never `--incremental`; run order is
   the committed seeded shuffle (seed 811). Each run records **both** clocks. Gate:
   `external − durationMs ≤ max(5%, 500 ms)`. The absolute floor is not slack — process
   boot, commander, config resolution and `openDatabase` all sit outside `startMs`
   (`indexer/index.ts:173`), a fixed 150–300 ms that is 4–9% of a ~3.5 s T1 run, so a bare
   5% rule would fire systematically on the *healthiest* small-tier runs (A1-F5 — the
   Q1/SCALE Gate-5 class, a gate firing on the ideal condition). Retakes are **capped at 2
   per run**; a third failure is logged as a finding rather than retaken, because selective
   retention of fast-boot runs would bias small-tier totals down and the slope **up**.
4. **WAL instrument rules — carried verbatim from the Q6 RESCOPE so they cannot be
   re-derived wrongly.** Backlog is read via `PRAGMA wal_checkpoint`, **never** from `-wal`
   file size, which is a high-water mark and is *silent* on deferral. The reader-block
   signal is the **`checkpointed < log` gap**, not the `busy` column, which stays 0. Any
   copy of a live database copies `.db` + `-wal` + `-shm` together. Never open `graph.db`
   with `?mode=ro&immutable=1` — it is WAL-blind. **Measured prior carried into R4:**
   `{busy:0, log:889, checkpointed:889}` on the live 14,605-chunk index, 2026-08-11 — 889
   is the backlog **ceiling**, not its depth, because opening a copy rebuilds the wal-index.
   (A3-C3: this registration cites the live index as both 14,605 and 14,610 chunks. They are
   the **same index at two moments of 2026-08-11**, five chunks apart — the WAL reading above
   was taken before the operator restart, the 14,610 figure in Costs after it. The reading's
   own context is left as measured rather than retro-fitted; only the discrepancy is
   reconciled here.)
5. **Determinism and instrument hygiene:** the six pin SHAs, seed 811, the frozen tier
   manifest, the harness scripts, and the run-manifest schema are committed **before** any
   measurement. Every script ships a working CLI entry point — Q1/SCALE logged that defect
   class **twice** (`ab-score.mjs`, `idfuse-score.mjs`); a third occurrence is a process
   failure, not a cosmetic note.
6. **Measurement ordering** (A1-F10). R5 runs a **second index into an already-built state
   dir**, so after R5 that directory is no longer the scored run's artifact. R3's `stat`,
   R4's boundary checkpoint reading, and E2's seam/SQL extraction must all be taken
   **before** R5 touches a corpus — or R5 must run against a dedicated copy. Registered
   here because nothing else in the design forces the order.
7. **Scorer correctness — known-answer tests, green BEFORE the scorer sees real data**
   (AMENDMENT 2). The scorer's statistics ship as `eval/__tests__/e1-score.test.mjs`, run by
   the normal suite (`vitest.config.ts` already includes `eval/**/*.test.mjs`, and its own
   comment names this defect class), so the gate is enforced by `pnpm -F mast test` rather
   than by a bespoke script a runner has to remember to invoke. Required cases, all over the
   frozen tier chunk counts with seeded multiplicative noise:
   - **(a) Known quadratic** (`total = a·N²`) must fire **SUPER-LINEAR REGRESSION**. A
     scorer that cannot fire this row on data built to fire it returns the investigator's
     prior on every input.
   - **(b) Known linear** (`total = a·N`) must fire **O(N) HOLDS**.
   - **(c) Known linear-plus-large-constant** (`total = c + a·N`) must fire HOLDS on the
     **adjusted** fit *and* must exhibit a lower raw-fit exponent — this is the only case
     that proves the calibration subtraction is wired the right way round rather than merely
     present. A sign error here biases `b` down, i.e. toward HOLDS. **Numeric margin, added
     2026-08-12 (A3-MAT-7): "visibly lower" is not a test.** The dataset is constructed with
     `c` equal to 40% of T1's total time; the assertions are that the **adjusted** fit
     recovers the constructed truth `b = 1.0` within **±0.05**, and that the **raw** exponent
     sits at least **0.10 below** the adjusted one. Both numbers are properties of the
     constructed dataset, not of the outcome.
   - **(d) HC3 and the wild cluster bootstrap** each checked against a fixed dataset whose
     OLS slope and robust SE are computed independently, not by the code under test.
   - **(e) Degenerate input** — all-equal timings, and a single-tier dataset — must **not**
     silently produce HOLDS. They must raise or return an explicit undefined verdict.
   - **(f) E2's two-row table and R5's three-row table** each exercised on synthetic inputs
     that land in every row, including R5's split-corpora INDETERMINATE case.
   - **(g) E1's own three-row table, every row and every feeding mechanism** (A3-MAT-7 — the
     first draft of this gate exercised E2's and R5's tables but **not E1's**, which is the
     only one that carries the headline verdict, and whose AMBIGUOUS row has *three*
     independent mechanisms, none of them constructed):
     - SUPER-LINEAR fired via the **CI lower bound** — a dataset with `b̂ ≈ 1.42` whose CI
       lower bound clears 1.35.
     - AMBIGUOUS via a **CI straddling** 1.35.
     - AMBIGUOUS via **primary/sensitivity disagreement** across 1.35.
     - AMBIGUOUS via **adjusted/raw disagreement** across 1.35.
     - **The point-estimate killer:** a dataset whose point estimate is **below** 1.35 but
       whose CI **upper** bound is above it must return **AMBIGUOUS, never HOLDS**. Without
       this case a scorer that keys verdicts off `b̂` instead of the interval bounds passes
       every other case in this gate — and it fails toward HOLDS on precisely the noisy data
       where the distinction decides the experiment.
   - **(h) Trigger 1's lack-of-fit test.** A pure power law (any exponent) must **not** fire
     it. A linear-plus-quadratic mixture constructed to exceed the 5% endpoint-departure
     floor **must** fire it. A mixture constructed to sit at the `N log N` term's own 0.7%
     departure must **not** fire it even when pure error is made small enough for `F` to be
     significant — that pair is what verifies the practical-significance floor is wired in
     rather than merely written down.

   **Why this gate is here at all, stated plainly:** the first draft of this registration
   omitted it. Q1/SCALE registered the equivalent gate specifically because `ab-score.mjs`
   shipped with its headline Wilcoxon test *registered but never implemented* — the exact
   failure of omitting a check on the machinery that produces the verdict. Carrying that
   file's CLI-entry-point lesson (Gate 5) while dropping its scorer-test lesson was an
   inconsistency in the author's favour.
8. **E2 harness fidelity — the gate E2 never had** (A3-MAT-8). `extractFile` takes
   `(filePath, projectRoot, contextLines, chunkSplitThreshold, markdownHeadingDepth)` and
   **no `onCallSite` parameter** (`ast/extract.ts:44-50`); the seam exists only on
   `extractEdges` (`ast/extractors/typescript.ts:1148-1162`). **E2 therefore cannot ride a
   Gate-0-verified product build.** It is a harness pass that self-reports *both* its
   numerator and its denominator — the one measurement in this registration with no
   independent check on either — while R2, a merely *descriptive* row, was given Gate 2.
   That asymmetry is backwards, and it survived two amendments. The compensating control:
   - The harness pass over `nest` must reproduce that corpus's Gate-0-verified build on
     **file count, chunk count and symbol count exactly** — the same three counts Gate 2
     uses, and for the same reason.
   - Its `edge_emitted` count must be **≥** the `POTENTIAL_CALL` row count in that build's
     `graph.db`. Greater-or-equal is the only sound direction: A1-F2 established that edge
     rows are lossy (unresolved names dropped, `populate.ts:537,543`) and deduped
     (`db.ts:257`) relative to extractor emissions, so equality is structurally impossible
     and a **lower** harness count would mean the harness is not seeing the whole corpus.
   - The harness records its own import path and the built `dist/` timestamp, so Gate 0's
     binary-identity claim extends to it rather than stopping at the product CLI.
   - Any mismatch **voids E2 for that corpus**, which — since `nest` is E2's sole
     decision-bearing corpus — voids E2's verdict rather than degrading it silently.

   Adding an `onCallSite` parameter to `extractFile` would let E2 read the product path
   directly and retire this gate. **That is a product change made to serve a measurement,
   and it is out of scope** — the same reasoning that kept `--parse-only` out for R2. Gate 8
   is the compensating control, not a preference.

#### Costs (stated before spending)

- **Index time, expressed in the only unit that survives A3-FATAL-2.** A minutes figure
  derived from the disavowed file counts would repeat the defect this amendment exists to
  fix, so the budget is stated in **full-n8n-index-equivalents**, `t` = the cost of one T9
  build:
  - **Ladder:** `Σ f_i = 3.092` equivalents per repetition × 3 reps = **9.28 t**.
  - **Prerequisite:** run P0 = **1.00 t**.
  - **Panel:** P1–P4 + `nest` ≈ **0.90 t** per rep × 3 = **2.69 t**. This one term is
    still sized off the provisional raw-`find` ratios, because no better anchor for
    *other* repos exists until they are built; it is a budget line, and no verdict
    depends on it.
  - **Total ≈ 13 t**, plus 10 calibration runs (empty corpus, negligible), parse-only
    passes, process startup, and R5's writer/reader load on two corpora.

  Against the original registration's ≈ 5.5 t, the amended design costs **≈ 2.4×** — not
  "roughly doubles" (A3-C4), which understated it while the design grew from 5 rungs to 9
  and acquired a prerequisite build. At these absolute numbers that is not a constraint
  worth trading validity for. `t` itself is unknown until P0 runs, and **that is the point**:
  this projection is itself the quantity under measurement — a budget, not a prediction — and
  a realized ladder an order of magnitude above it *is* the R1 result, not a cost overrun.
- **Disk.** The live index is 157 MB at 14,610 chunks (≈11.3 KB/chunk). If chunk yield
  tracks it, T9 could reach ~1.5–2 GB and one full set of tiers plus panel ~5–7 GB.
  **Only the final repetition's state dirs are retained**; earlier reps are deleted once
  their manifest is written, subject to Gate 6's ordering. Host: 79 GB free of 926 GB (92%
  used). `~/.cache/mast-eval/vscode-state-*` holds ~6.9 GB that is reclaimable if needed —
  per `eval/ASSETS.md`, Q1/SCALE's *conclusions* do not depend on those dirs surviving, only
  the ability to cheaply re-run ranking arms.
- **No agents, no embedding, no model calls.** Token spend is orchestration only.

#### Design Reserve (pre-thought, NOT commitments)

A tenth rung at vscode (8,653 files / 138,440 chunks, already pinned and built once for
Q1/SCALE) — note it is a *different corpus*, so promoting it extends the panel, not the
nested ladder; a genuine **Fastify+DI service** corpus for E2, which nest only approximates
(the closest candidate is this monorepo's own `application/api`, disqualified as the home
corpus); a K-sweep for R5 across N ∈ {1..8} matching rounds 1–2; per-language yield
breakdown for E2; **`wal_autocheckpoint` tuning**
(Q6 RESCOPE item 4) evaluated against R4's realized numbers and never speculatively;
attribution of the 1,802 ms `index-run` hold — which the Q6 RESCOPE leaves explicitly
**unattributed** across at least three candidate mechanisms (batch volume, Q3's FTS-growth
cost, checkpoint-inside-commit) — promoted only if R5 reproduces holds in that band.

#### AMENDMENT 1 — 2026-08-11, pre-run, post-adversarial-review

Adversarial design review commissioned per the standing §6 rule (Agent tool, model
`fable`) against this section as committed at `5b16b4d`, **before any measurement had
occurred**. Per the Q1/SCALE and Q1/OUTCOME precedents, no data existed, so the
registration above was revised **in place** rather than appended to; this log is the audit
trail. Every code claim the reviewer made was **independently verified against source
before being accepted** — the reviewer has been wrong before, and §6 requires it.

Stated plainly, because it is the finding about the process rather than the instrument:
**of the twelve findings, five run toward the investigator's own priors** (E1 → "O(N)
HOLDS"; E2 → "UNSUPPORTED"), and four more are free levers with no fixed direction that
would have been resolved after the data existed. Q1/SCALE's review found 7 of 12 running
the same way. **This is now the third consecutive review round in which the majority of
defects flattered the investigator** — that regularity is itself the argument for the
review step, and it should be quoted at anyone who proposes skipping it.

| # | Finding | Change | Direction the error ran |
|---|---|---|---|
| F1 | E2 tested a claim §10.3.1 scopes to "a Fastify + DI service codebase" against five corpora, **none of which depend on `fastify`** (verified: every non-`node_modules` `package.json` to depth 4 in all five). The "all five must miss" bar, presented as conservative, was near-automatic — and the consequence ("the spec must be rescoped") did not follow from missing a band on out-of-scope corpora. | `nestjs/nest` @ `f7fffd6` (3 fastify + 48 DI packages, already pinned, the project's honest-broker corpus) becomes E2's **sole decision-bearing** corpus, with an explicit registered caveat that it is a DI *framework*, not a DI *service*. P1–P5 demoted to external validity, licensing **no** spec change. | **Strongly flatters UNSUPPORTED** — the worst defect in the registration. |
| F2 | Gate 2 required the parse pass to match the full index on **edge count**. Structurally impossible: `insertEdges` drops unresolved names (`populate.ts:537,543`) and dedupes on `PRIMARY KEY (from_id,to_id,edge_type)` (`db.ts:257`), and no product-side extractor-level edge counter exists. The gate would have voided R2 everywhere, or passed vacuously on harness-vs-harness. | Gate 2 now checks **file + chunk + symbol** counts. R2's scope narrowed in writing to Phase 1's chunk pipeline, explicitly excluding pass-2 resolution. | **Free lever** — the likely real outcome was a post-hoc redefinition of "edge count". |
| F3 | Five unrelated repos made corpus **content** perfectly confounded with `N`. Q1/SCALE faced this exact problem and solved it with seeded nested subsets of one corpus; the reversal was justified nowhere. Worse, the registered escalation for AMBIGUOUS was *another corpus*, deepening the confound. | Decision-bearing axis is now a **seeded nested tier ladder inside n8n** (T1⊂…⊂T5, seed 811), the Q1/SCALE recipe verbatim on existing tooling. The five repos become a replication panel that carries no verdict. Escalation is more tiers/reps, never another corpus. | **Two-way** — content noise widens the CI (opposes), but the HOLDS branch's causal claim ("Stage 2's proof extends") was unsupportable by the design (flatters when it fires). |
| F4 | Four statistical defects: (a) a pure power law with no additive constant biases `b` **downward**; (b) BCa on 5 clusters draws its acceleration from a 5-value jackknife, ~10% of resamples hold ≤2 distinct clusters, and no degenerate-resample handling was registered; (c) `total_index_ms` was never defined — R1 named two clocks and the fit named neither; (d) no reachability arithmetic, where Q1/SCALE published `n_min = 154`. | (a) 10 empty-corpus calibration runs measure `c`; both adjusted and raw fits reported, opposite sides of 1.35 → AMBIGUOUS. (b) BCa withdrawn; primary is OLS + HC3 over 15 points, with a wild cluster bootstrap as a registered sensitivity, disagreement → AMBIGUOUS. (c) `durationMs` fixed as the fitted clock. (d) `σ < 0.47` published as the residual-sd ceiling for HOLDS to be reachable. | **(a) and (b) flatter HOLDS; (c) free lever; (d) risked a predetermined AMBIGUOUS.** |
| F5 | Gate 3's flat 5% clock-agreement rule fires on the *ideal* condition: `startMs` sits inside `runIndex` (`index.ts:173`) so 150–300 ms of process boot is 4–9% of a ~3.5 s T1 run. Remedy "re-take the run" cannot fix a structural offset — outcomes were an infinite loop, a de facto void of the cheapest anchor, or selective retention of fast-boot runs. | Gate becomes `max(5%, 500 ms)`; retakes capped at 2, then logged as a finding; both clocks recorded always. | **Opposes HOLDS** (selective retention would bias the slope up) — and it is the Q1/SCALE Gate-5 class repeating: a gate firing backwards. |
| F6 | R5 imported thresholds across corpus, build, plane and instrument: 1,700 ms where round 1's own field is `wal_checkpoint_outliers_gt_1500ms`; 755 ms taken from a **pre-F11, nest, server-side lock-hold** envelope and applied to **client wall clock of per-call CLI processes**. Rung, denominator, pacing and payload all unregistered; no direction-of-error statement. | Threshold → **1,500 ms**. The 755 ms bound **withdrawn**, replaced by each corpus's own idle baseline (p99 within 2×). T1 **and** T5 both probed, ≥400 scored calls, 250 ms pacing, frozen payload. Reader-lifecycle mismatch registered as a known limit. Direction statement added. | **Flatters retirement** — every free parameter leaned the same way. |
| F7 | E2's three-row table left "one corpus >80%, none in 60–80%" with **no verdict** — a reachable pattern with undefined machinery. | Table reduced to two exhaustive rows (≥60% / <60%). | **Toward the prior** — the gap would have been closed after the data existed. Q1/SCALE AMENDMENT-1 F3 class, repeating. |
| F8 | The seam's denominator excludes calls in nested-scope bodies by design (D7), so callback-heavy code is absent from it and the measured yield **overestimates** coverage of the spec's "real call sites". The registration never said so. | Exclusion registered explicitly; raw `call_expression` count reported alongside visited sites so the excluded region is quantified. | **Opposes UNSUPPORTED** — but the registered quantity was silently not the spec's quantity. |
| F9 | The index config was unpinned — a free lever over `N` itself. Defaults index `.md` and exclude `*.test.ts` but **not** `*.test.js` (`config.ts:39-48`), so the registration's raw-`find` anchor was wrong in both directions. | Config pinned in writing (defaults at this commit, no overrides), resolved config recorded per run, and the `find` figures re-labelled as the wrong anchor rather than a sanity check. | **Free lever, unknown direction.** |
| F10 | R2, R3 and R4 were measured with **no registered interpretation** — R4 with no threshold, no verdict row, and absent from the falsification criteria, its only consumer a post-hoc tuning decision. `b_file`/`b_chunk` disagreement unhandled. Sequencing unregistered: R5's second index overwrites the artifact R3 and E2 read. | A registered reading per supporting row (explicitly descriptive, verdict-free — including R4, where **no threshold is registered because none is justified**); trigger 5 for exponent disagreement; Gate 6 fixes R3/R4/E2-before-R5. | **Free levers.** |
| F11 | Arithmetic audit: `N log N` effective exponent 1.120 ✓, 11.3 KB/chunk ✓, 3.29 ms/file ✓, trigger 1's p = 1/120 ✓ — all reproduced. One wobble: the span is 19,056/1,059 = **18.0×**, not 19, so b=1.35 costs 2.75× (not 2.8×) and b=2 costs 18× (not 19×). The shuffle seed was never printed, where Q1/SCALE printed 153. | Figures corrected; **seed = 811** stated in the registration. | **Trivial, flattered the threshold's rationale** by slightly overstating the pathology. |
| F12 | `parse_errors` recorded-but-ungated was correctly argued, but no consistency trigger existed either: unparseable files consume time and yield zero chunks, so a parse-error rate rising with `N` inflates `ms/chunk` through an unmodelled channel. | Trigger 4: any tier whose parse-error *rate* exceeds 2× the median must be discussed before the verdict is recorded. | **Two-way, most plausibly opposes HOLDS.** |

**Verified and unchanged** (the reviewer attacked these and could not break them): the six
pins are real commits; S1's whale-file hazard is genuinely retired so trigger 2's
`write_errors == 0` is enforceable rather than a deterministic rung-killer; ground-truth
counts from `graph.db` rather than stdout is mechanically correct (`chunksAdded` is counted
pre-write, `index.ts:282`); the "no parse-only product mode" admission is exact
(`index-cmd.ts:12-20`); `mast query` dispatches through the real MCP handlers; the seeded
run-order shuffle; **Gate 0, the D8 binary-identity gate, in full**; chunk count as the
exposure variable; log–log as the estimation scale; trigger 1; Gate 4's WAL rules,
transcribed from the Q6 RESCOPE without drift; and the registered admission that no
non-invasive in-flight backlog probe exists.

#### AMENDMENT 2 — 2026-08-12, pre-run, self-identified

Not from a review. Found while distilling the remaining build work for the project owner,
against the registration as committed at `c60cbbf`, **before any measurement had
occurred** — so, per the same precedent as AMENDMENT 1, the gate was added in place and
this log is the audit trail.

**The defect: no known-answer test on the scorer.** Q1/SCALE's Gate 1 required its
statistical test to be "implemented and unit-tested BEFORE scoring", with named cases,
because `ab-score.mjs` had shipped with its registered Wilcoxon test **never implemented**
(HANDOFF_Q1.md §5). This registration inherited that file's *other* lesson — Gate 5's
working-CLI-entry-point rule, where the same defect class recurred a second time in
`idfuse-score.mjs` — but silently dropped the scorer-test lesson.

| aspect | statement |
|---|---|
| **Change** | New **Gate 7**: six known-answer cases (quadratic → SUPER-LINEAR; linear → HOLDS; linear-plus-constant → adjusted HOLDS with a demonstrably lower raw exponent; independent HC3/bootstrap checks; degenerate inputs must not silently discharge; every verdict-table row exercised). Enforced by `pnpm -F mast test`, since `vitest.config.ts` already includes `eval/**/*.test.mjs`. |
| **Direction the error ran** | **Toward the investigator's prior, on every branch.** An unverified scorer's most likely silent failures — an inability to fire SUPER-LINEAR at all, a sign error on the calibration subtraction (which biases `b` down), or a degenerate input falling through to the discharge row — all land on **O(N) HOLDS**. This is the same asymmetry AMENDMENT 1 found five times. |
| **Why it was missed** | The registration's own banner is "exactly one decision-bearing test per experiment", and attention went to *defining* that test rather than to verifying the code that would evaluate it. The gate that checks the checker is the easiest one to forget and the most expensive to omit. |

**Process note.** AMENDMENT 1's tally recorded three consecutive review rounds in which the
majority of defects flattered the investigator. This one was self-found rather than
review-found, which is a better sign than the alternative — but it was found while
*explaining the work to someone else*, not while writing it, and that is worth recording as
its own lesson about when these defects actually surface.

#### AMENDMENT 3 — 2026-08-12, pre-run, post-second-adversarial-review

Second adversarial design review commissioned per §6 (Agent tool, model `fable`) against
this section as committed at `61e166d`, **before any measurement had occurred**. As with
AMENDMENT 1, no data existed, so the registration above was revised **in place** and this
log is the audit trail. Every code claim the reviewer made was **independently verified
against source before being accepted**; the reviewer has been wrong before.

**The finding about the process, stated first because it is the important one: all three
fatal defects were introduced by AMENDMENT 1's repairs.** They are not in `5b16b4d`. The
review that was supposed to harden the design broke new ground in it — and two of the three
sat inside passages AMENDMENT 1 explicitly certified as "verified and unchanged." Trigger 1
is the sharpest case: the reviewer checked its arithmetic in round 1 (`p = 1/120 ✓`) and
missed that the trigger contradicts the threshold rationale sitting two paragraphs above it.
**Checking a component in isolation is not checking the design.** This is now the fourth
consecutive round in which the majority of defects flattered the investigator, and the first
in which the *repairs* were the vector.

| # | Finding | Change | Direction the error ran |
|---|---|---|---|
| **FATAL-1** | **Trigger 1 contradicted the threshold's own rationale.** Under the `N log N` model used to justify `b = 1.35`, `ms/chunk ∝ log N` and rises **~41%** across the span (`ln 19056 / ln 1059 = 1.415`). Strict monotone increase in `ms/chunk` is therefore the **expected healthy signature** — and trigger 1 called it AMBIGUOUS. The registered escalation (more reps) tightens tier means and makes the monotone ordering *more* likely: an escalation that increases the chance of the outcome being escalated from. The `p = 1/120` exchangeability argument never applied, because `ms/chunk` is not exchangeable across tiers under the fitted model. | Trigger 1 re-derived onto **departure from the fitted law**: classical lack-of-fit `F(7, 18)` at α = 0.05 on the **adjusted** fit (raw reported as descriptive, since its known omitted constant guarantees curvature), **jointly** with a **5% endpoint-departure floor** — benchmarked against the `N log N` term's own **0.69%** curvature, computed and shown. What it detects is now stated: mixtures, not pure power laws. | **Toward AMBIGUOUS** — i.e. "safe rather than informative": a design that discharges nothing while appearing rigorous. Fix-induced. |
| **FATAL-2** | **The ladder's rungs were cut in one unit and stated in another.** Targets read "≈1k / 2k / 5k / 8k / all indexed **files**"; the cut rule read cumulative **chunk** counts; `scale-build-tiers.mjs:36` cuts on chunk targets. Worse: **every published figure** — span 18.0×, `N log N` exponent 1.120, `Sxx ≈ 16.1`, `SE(b) ≈ σ/4.01`, `σ < 0.47` — was computed on the raw-`find` **file** counts that AMENDMENT 1, in the same document, called "the wrong anchor in both directions." | Rungs are now **geometric fractions of realized `C_total`** (`f_i = 20^{−(9−i)/8}`, 20× span, exactly even in `ln N`). All arithmetic re-derived from **geometry** (`Sxx_cluster = 8.414`, `σ_tier < 0.28`, `σ < 0.56`, `b_eff ≈ 1.10`) and the old figures withdrawn. New **Gate 1b** re-derives the whole power analysis from the frozen manifest's realized counts before any scoring, with a 20% geometry tolerance. | **Free lever, and a live incoherence** — the ladder as written could not be built as specified. Fix-induced. |
| **FATAL-3** | **The tier manifest requires a full n8n index build first** — `scale-build-tiers.mjs:3-5` reads a completed `graph.db` for per-file chunk counts. That build appeared in **no gate, no run count, no cost line**, on a harness that imports `../dist/` directly, i.e. carrying D8's exact exposure while sitting outside the D8 gate. It is also a pre-freeze look at a T9-scale timing. | Promoted to **run P0**: under Gates 0 and 1 in full, own manifest entry, **excluded from every fit**, and **the peek is declared** — with the binding mitigation that this amendment (fractions, seed, threshold, estimator, triggers, gates) is committed **before** P0 runs, so the machinery is immutable by the time anything is seen. | **Free lever plus an ungated build** — the peek is of a duration at the ladder's top rung, the most informative single number in the experiment. Fix-induced. |
| MAT-1 | AMENDMENT 1 replaced 5-cluster BCa with a 5-cluster **Rademacher** wild bootstrap — 2⁵ = **32** atoms. One degenerate method for another. CI construction, restricted-vs-unrestricted residuals and the studentization were all unregistered. Separately, HC3 over 15 runs at 5 x-values treats tier-level lack-of-fit as if it shrank with reps, which it does not, so `σ < 0.47` overstated the design's power. | 9 clusters (owner decision); **Webb 6-point weights** (6⁹ ≈ 10.1 M atoms); restricted residuals for testing, unrestricted for the percentile-t CI; studentized with CR1. **Both** reachability ceilings published, with the **cluster-level one named as the honest number** — and the 5-rung counterfactual (`σ_tier < 0.165`) shown, which is the quantitative case for widening. | **Flatters HOLDS** — an overstated power figure makes the discharge branch look reachable when it may not be. |
| MAT-2 | E2 decides on `n = 1`, and the consequence was a mandate: "§10.3.1 must be rescoped or the figure removed." | **Owner decision: keep `n = 1`, soften the consequence.** Sub-60% now registers as **NOT ATTAINED** — "the band is not attained on the closest available Fastify+DI corpus" — evidence for a spec revisit, recorded as a spec-drift *candidate*, **not** a mandate. | **Toward the prior** (mast's own src = 40% already favours a miss); a single out-of-referent corpus cannot carry a spec change. |
| MAT-3 | R5's payload was Q1/SCALE's frozen probes — **vscode-specific** (`supportsTelemetry` in `src/vs/platform/telemetry/common/telemetryUtils.ts`) — aimed at n8n tiers. Absent terms are the cheapest reads the engine performs: FTS5 returns empty early, ranker D never engages. | Payload **derived from the probed corpus's own `graph.db`** (10 declaration names, seed 811, stratified common/rare), committed as `eval/e1r5-queries-<corpus>.json` before the probe. | **Flatters retirement** — it suppresses exactly the contention R5 exists to find. |
| MAT-4 | Falsification said the stall class is PRESENT on "**either** probed corpus"; the verdict table says a split is INDETERMINATE overall. Direct contradiction, introduced when AMENDMENT 1 added the second corpus to one and not the other. | Resolved **in the table's favour** — the table is what gets scored. Falsification now reads "on both probed corpora." | **Free lever** — an unresolved contradiction is resolved after the data by whoever reads it. Fix-induced. |
| MAT-5 | Nothing required scored R5 calls to **overlap write activity**. 400 calls at K = 4 paced 250 ms ≈ 25 s of reader traffic against a single-digit-second T1 pass, so most scored calls would see no writer — diluting the ≥ 1% criterion by the duty cycle. | A call is **scored only if start and end fall strictly inside a writer run**; the writer repeats non-incremental indexes until the count is reached. (Verified benign: `toIndex = currentFiles`, `index.ts:232`, skip gated on `options.incremental` at `:278` — repeat passes are real write load.) | **Flatters retirement**, by roughly the duty cycle. |
| MAT-6 | The "p99 within **2×** idle baseline" clause was derived nowhere and is **vacuous at T9**: idle p99 ≥ 750 ms makes 2× ≥ 1,500 ms, implied by the row's other condition. | Replaced with an **absolute ≤ 250 ms excess** over the corpus's own idle p99 — an order of magnitude below round 1's smallest observed stall (1,700 ms). Direction noted: absolute is *harder* at T9, which opposes retirement. | **Flatters retirement**, and silently so — the clause reads as a second requirement while adding nothing. |
| MAT-7 | Gate 7 exercised E2's and R5's verdict tables but **not E1's** — the only one carrying the headline verdict, and the only one whose AMBIGUOUS row has three independent feeding mechanisms. A scorer keying verdicts off the point estimate rather than the CI bounds passed all six registered cases. Case (c)'s "visibly lower" had no numeric margin. | New case **(g)**: E1's three rows and all three AMBIGUOUS mechanisms, including the **point-estimate killer** (`b̂ < 1.35`, CI upper > 1.35 ⇒ AMBIGUOUS, never HOLDS). New case **(h)**: trigger 1's lack-of-fit test, including the pair that verifies the 5% floor. Case (c) given numbers: adjusted recovers `b = 1.0` within ±0.05, raw at least 0.10 below adjusted. | **Toward HOLDS on every branch** — a point-estimate scorer fails toward HOLDS on exactly the noisy data where the distinction decides the experiment. |
| MAT-8 | `extractFile` takes **no `onCallSite` parameter** (`ast/extract.ts:44-50`); the seam exists only on `extractEdges` (`typescript.ts:1148-1162`). **E2 cannot ride a Gate-0-verified build** — it is an ungated harness pass self-reporting *both* numerator and denominator. R2, a merely descriptive row, had Gate 2; E2's decision-bearing measurement had no fidelity gate at all. | New **Gate 8**: file/chunk/symbol counts must match the Gate-0 build exactly; `edge_emitted` must be **≥** the build's `POTENTIAL_CALL` row count (≥ because edge rows are lossy and deduped — A1-F2); harness import path and `dist/` timestamp recorded. Mismatch **voids E2**. Adding the seam to `extractFile` is explicitly out of scope — a product change to serve a measurement, same reasoning as `--parse-only`. | **Free lever on both terms of a ratio** — the single largest unchecked surface in the registration. |
| MAT-9 | `n8n` was listed as panel rung **P5** *and* as the tier ladder's source, so the replication panel's top point was the ladder's top point. | **P5 dropped.** T9 *is* the full-n8n measurement. Panel = P1–P4 + `nest`, 15 replication runs. (`nest` still appears in both experiments — benign, because the E1 panel carries no verdict.) | **Flatters HOLDS** — the panel's job is to be external, and its heaviest point was internal. |
| C1–C5 | Cosmetics: "each indexed once from cold" survived from `5b16b4d` against a 3-rep design; the "one registration, shared build" economy was dead post-A1 and post-MAT-8; the live index cited as both 14,605 and 14,610 chunks; "roughly doubles" understated the cost growth; `eval/make-subset.mjs` miscited as tier tooling. | All corrected: the shared-build rationale rewritten to name what *is* actually shared; the two chunk readings reconciled as the same index five chunks apart on 2026-08-11; cost restated in **n8n-index-equivalents** (≈ 13 t, ≈ 2.4× the original) rather than a minutes figure derived from the disavowed anchor; `scale-build-tiers.mjs` named as the tier constructor. | — |

**Verified and unchanged** (attacked and not broken): the pin SHAs; Gate 0 in full; the
`durationMs` fitted clock and the calibration constant `c`; the 1.35 threshold itself, which
both the old and the re-derived rationale place in the same gap; chunk count as the exposure
variable; log–log as the estimation scale; Gate 2's three-count formulation and the reasoning
that removed edge count; Gate 4's WAL rules; Gate 6's ordering constraint; the E2 denominator
caveat (A1-F8) and the `call_expression` mitigation; the R5 reader-lifecycle limitation;
triggers 2, 4 and 5.

**Registered process note, since it now has four data points.** Rounds 1 and 2 of review, plus
the self-found AMENDMENT 2, plus this round: the majority of defects have flattered the
investigator every time. What is new here is that **the repairs were the vector** — three
fatal defects, none present in the original draft. The operational conclusion is not "review
harder"; it is that **a repaired registration is a new registration and inherits none of the
old one's verification.** Re-certifying a passage as "verified and unchanged" while the
passages around it move is precisely how FATAL-1 survived.

### AMENDMENT 4 (2026-08-12) — round-3 review, before any scored run

Commissioned against the shipped harness (`eval/e1-common.mjs`, `e1-p0-build.mjs`,
`e1-build-tiers.mjs`, `e1-stats.mjs`, `e1-score.mjs`, `e1-schedule.mjs`) and the run driver's
design, **after** P0 and the tier cut had run and **before** the first scored run. Every
mechanical claim below was re-verified against source before being accepted; the reviewer's
one over-read (it took R4's design to be a timed `TRUNCATE` curve rather than a passive
reading) is noted and its underlying point kept.

| id | finding | change | direction the error ran |
|---|---|---|---|
| **A4-FATAL-1** | **The verdict table contradicts its own prose on SUPER-LINEAR.** The table's row 2 fires on the **HC3 primary alone**; three separate unconditional sentences say otherwise — adjusted/raw disagreement ⇒ AMBIGUOUS, primary/sensitivity disagreement ⇒ AMBIGUOUS, and trigger 1 "Fires → AMBIGUOUS" — as does the table's own AMBIGUOUS row. Both texts cannot hold. The conflict is **reachable and expected**: a large `c` biases the *raw* exponent **down**, so "adjusted above 1.35, raw straddling" is the **signature of true super-linearity**, not of instability. `combineE1Verdict` had already resolved this in code, without an amendment. | **The table governs.** SUPER-LINEAR fires on the **adjusted HC3 primary's CI lower bound**. Concordant evidence of *different flavours of "not clean O(N)"* — trigger 1's mixture signal, a raw fit dragged down by the omitted constant — is reported as a **qualifier on the verdict**, never as a downgrade. **AMBIGUOUS is for conflicting evidence, not for concordant evidence of different kinds of bad.** Gate 7 gains the untested case `hc3Adj='above'` ∧ `lackOfFitFires` ∧ raw straddling. | **Toward the prior.** Resolving it the other way makes SUPER-LINEAR nearly unreachable on exactly the data pattern super-linearity produces, and routes it into AMBIGUOUS's "add rungs or reps" escalation — i.e. toward never recording a regression. The code's own (undocumented) choice ran *against* the prior; the defect was leaving a documented contradiction to be settled silently by an implementer. |
| **A4-MAT-1** | **The calibration constant is silently optional.** `eval/e1-score.mjs:113` defaults `c = 0`. A driver that forgets to thread `e1-calibration.json` through produces adjusted ≡ raw with no error, and the adjusted/raw protection self-satisfies trivially. Gate 7 case (c) proves the machinery subtracts correctly — but only when `c` is passed, and the production call site is the one seam no test covers. | `c` is **required**; the raw fit passes an explicit sentinel rather than falling through a default. The calibration artifact's path is recorded in the scored output. | **Toward the prior** — this registration's own words: an omitted additive constant biases `b` **downward**. |
| **A4-MAT-2** | **Gate 0 does not survive a resume.** `assertGate0` compares only `schema_version`. A mid-schedule rebuild of `dist/` at an unchanged `1.3.0` — this is an actively developed branch — passes, and the resumed half of the schedule then measures different code than `c` was calibrated on. `newestDistMtime` is insufficient (tsc rewrites only changed outputs). | A **content hash over every `dist/**/*.js`** is recorded in the schedule artifact and re-asserted at **every** start and restart; a mismatch voids the remainder of the schedule pending an explicit re-decision. | **Unknowable for `b`**; it inflates σ, against Gate 1b's whole reachability argument (`σ_tier < 0.282`). |
| **A4-MAT-3** | **Resume censors exactly the runs the experiment exists to detect.** "Skip completed pairs" leaves incomplete attempts no trace. The likeliest interruption is an operator killing a run that *looks hung* — that is, a pathologically slow large-tier run, which is the super-linear signal itself. On restart it silently re-runs, now warmer, and only the faster second attempt enters the fit. | An **attempt-start line is journaled before the spawn**. On resume, a start with no completion is a logged finding and the re-attempt is flagged and counted against the retake cap. An unparseable trailing JSONL line is treated as an incomplete attempt — never as a completed pair. | **Toward the prior** — selective censoring of slow runs biases `b` down. |
| **A4-MAT-4** | **Gate 1's tier clause had no enforcement anywhere.** "Tier file lists match the frozen tier manifest exactly" was registered, but the design verified pins for *panel* corpora only; the tier trees are built once and reused across 27 runs, unchecked. Compounding it, `materialiseTier` **hardlinks**, so the trees alias the n8n worktree's inodes — any in-place mutation during the ~2.3 h window changes tier content mid-schedule, and no tier run asserted the n8n pin. | Every tier run asserts `SELECT path FROM files` from its own `graph.db` equals the frozen manifest's file set exactly, and `file_count` matches. Every tier run also calls `assertCorpusPinned('n8n')`. | **Unknowable** — a polluted tree moves that rung's realized `N` and its time in the same direction, partially self-masking. Most likely surfaces as the rep-identity check firing, i.e. a **false** nondeterminism finding. |
| **A4-MAT-5** | **The scorer omits four registered supporting outputs.** `scoreE1` consumes `{tier, chunk_count, duration_ms}` only — no `file_count`, no `db_bytes`, no `parse_errors` — though `runColdIndex` records all of them. So `b_file` (registered "Both are reported"), trigger 3 (bytes/chunk at T9 vs T1), trigger 4 (parse-error rate, which "**must** be discussed before the verdict is recorded") and trigger 5 (`b_file` vs `b_chunk`) would all be hand-computed post-hoc. | All four **emitted natively**, with Gate-7-style known-answer cases for triggers 3 and 4. | **Toward the prior.** Every one of these exists to force an anomaly to be *confronted* before HOLDS is recorded; omitting them removes tripwires in one direction only. This is HANDOFF §5's `declex-score.mjs` class verbatim — "fix the scorer to emit this contrast natively before reusing the instrument." |
| **A4-MAT-6** | **Retake semantics were unregistered.** Gate 3 caps retakes at 2, but nothing said which take is fitted, or whether a thrice-failing run's data enters the fit at all. Retakes also run seconds after an identical run of the same tier — maximally warm — so replacements are systematically faster than what they replace. | The take that **passes** Gate 3 enters the fit. If all three attempts fail, **the first attempt's data enters the fit** and the failure is logged as a finding — never dropped. Every discarded take is recorded with both clocks; retake counts persist across resumes. | A1-F5's own analysis: selective retention of fast-boot runs biases the slope **up**. Selection in *either* direction is the defect, so nothing is dropped. |
| **A4-MAT-7** | **VOID had no re-run path.** Trigger 2 says "Diagnose, then re-run", but the driver's design recorded a `write_errors` run VOID and continued — correct for not aborting 2.3 h, incomplete as a protocol. A 2-rep tier also breaks the shape of the "three reps report identical `chunk_count`" check and costs pure-error df. | VOID pairs are **not** "completed" for resume purposes and enter a post-schedule re-run queue. The scorer **refuses to fit** a ladder carrying unadjudicated voids. | Mostly variance (toward AMBIGUOUS, against the prior) — but a lost **T9** rep specifically weakens the top of the ladder, which is unknowable. |
| **A4-MAT-8** | **R2 had no implementation plan** — a measured row with no schedule placement, no statement of which artifact Gate 2 compares against, and no cache discipline. This is the A3-FATAL-3 class that P0's promotion exists to fix. | R2 runs **after** the 42 scored runs, over each corpus's **rep-3 file list**, with Gate 2 against that rep's `graph.db` counts. **Registered limitation:** the parse pass runs page-cache warm against a cold full index, so the ratio **understates** the parse share. R2 is descriptive-only and carries no verdict. | **Free lever**, though a small one given R2 is verdict-free. |
| **A4-C1** | **Gate 3's rationale is wrong about `openDatabase`, and contradicts the calibration paragraph.** `startMs` is `runIndex`'s first statement (`indexer/index.ts:173`); `openDatabase` is at `:188` — **inside** the fitted clock, and therefore inside `c`, exactly as the calibration paragraph says. Process boot, commander and `resolveConfig` *are* correctly outside (they run in `cli/index-cmd.ts` before `runIndex`). Separately, the calibration paragraph names `loadIndexMeta`, which `runIndex` never calls (defined `index.ts:497`, uncalled). | Both texts corrected here. **The fitted clock and `c` are unchanged** — the paragraph that governs `c` was already right; only Gate 3's justification prose was wrong, and it was copied verbatim into `eval/e1-schedule.mjs`, which is corrected too. | ~Neutral. Gate 3's clock is a cross-check and never enters the fit. Recorded because it is a second contradiction internal to the immutable text. |
| **A4-C2** | **Gate 3's "~3.5 s T1" premise is stale by ~9×.** Realized T1 is 3,679 chunks; at P0's rate (73,359 chunks / 635,996 ms) that is ≈ 32 s, so the 5% term is ≥ 1.6 s at every rung and **the 500 ms floor is inert across all 42 runs.** | The floor **stays registered** — removing a gate term because this particular ladder happens not to need it would be tuning — but is recorded as inert, so no later reader mistakes it for load-bearing. | Neutral; a live-but-unnecessary safeguard. |
| **A4-C3** | **R4's boundary reading is structurally zero in this topology.** `graph.db-wal` is 0 bytes after P0: the one-shot CLI drains the WAL at process exit. A per-rung curve of ~0 ms reads as "checkpointing is free at scale". | Readings are recorded and **labelled structurally zero in the artifact itself**, so the R4 curve cannot be quoted as evidence about `mast serve`'s checkpoint behaviour. | **Toward the adjacent prior** — the number the deferred `wal_autocheckpoint` decision (Q6 RESCOPE item 4) is registered to consume is exactly the one this would fake. |
| **A4-C4** | **Instrument hygiene, four items.** The child process inherits the parent environment unpinned and unrecorded (`NODE_OPTIONS` — heap size, `--inspect` — would silently change performance); node version unrecorded; `mast index` never persists the resolved config the way `init` does, so "the resolved config recorded in every run manifest" was unsatisfied; child **stderr is discarded**, though parse-error *file names* go there (`index.ts:286`) while the record keeps only the count — and reps 1–2's state dirs are deleted, so diagnosis would have no file list. | All recorded per run: `process.version`, a stripped-and-recorded `NODE_OPTIONS`, the Gate-0 build's own `resolveConfig` output, a stderr tail. `MAST_STATE_DIR` asserted unset and no `mast.config.json` in any corpus root (verified across all six worktrees). | Unknowable; hygiene, but trigger 4 is undiagnosable without the stderr tail. |
| **A4-C5** | Tier trees contain **only chunk-bearing files**, so their walk/stat cost scales with rung size where a real corpus pays a corpus-constant walk over all entries. | Recorded. Uniform across rungs ⇒ **no slope bias within the ladder**; mildly dilutive toward `b = 1`, and the walk is ≲1% of a run. Extends `e1-tiers.json`'s logged deviation, which covered zero-chunk *indexed* files only, not never-indexed directory entries. | Mildly **toward the prior**, immaterial at this magnitude. |
| **A4-C6** | **Nesting makes every scored run content-warm** — all tiers share inodes with each other and with P0's build. | Recorded, not corrected: the experiment measures warm-cache indexing, **uniformly**, which is a scope statement rather than a defect. Residual: larger tiers' marginal files are touched by fewer prior runs, pointing `b` slightly **up**. | **Against** the prior, immaterial while n8n's sources fit in RAM. |

#### A4-C2 CORRECTED ON FIRST CONTACT (2026-08-12, after scored run 1 of 42)

**A4-C2 is wrong and is withdrawn.** It claimed the `max(5%, 500 ms)` gate's 500 ms floor is
"inert across all 42 runs", on the reasoning that realized T1 is 3,679 chunks and therefore
≈32 s at P0's rate, making the 5% term ≥1.6 s everywhere. The first scored run falsifies it:

| | measured |
|---|---|
| T2 (5,332 chunks) fitted clock | **8,908 ms**, not the ≈28 s the extrapolation implies |
| 5% term at T2 | **445 ms** — *below* the 500 ms floor, so the floor is what binds |
| external − fitted, three attempts | **887 / 794 / 561 ms** — Gate 3 failed all three |
| ms per chunk | **1.671 at T2** vs **8.670 at P0/T9** |

**The error was circular, and worth naming precisely.** I sized the gate by extrapolating T1
from P0's *mean* per-chunk cost — which assumes cost per chunk is constant, i.e. assumes
`b = 1`, i.e. assumes the hypothesis under test. Using the null to calibrate an instrument
meant to test the null is exactly the move this registration exists to prevent, and I made it
in the amendment that was correcting other people's version of the same mistake.

**Gate 3 itself is UNCHANGED**, and that is the point. The floor is load-bearing at the bottom
of the ladder, precisely as A1-F5 argued and contrary to my note; the run's data is retained
(first attempt, per A4-MAT-6), and the failure is logged as a finding rather than retaken away.
Moving a threshold on first contact with the data is tuning, and it is forbidden here whichever
direction it would move.

**A4-MAT-6 is confirmed load-bearing by the same run.** The three attempts came in at 8,908 /
6,861 / 6,264 ms — the third is **30% faster than the first**, purely from page-cache warmth.
Had the rule retained the last (or a passing) attempt rather than the first, small-tier totals
would have been recorded ~30% low, steepening the ladder and biasing `b` **up**. The registered
rule keeps the coldest take.

**Direction of the A4-C2 error:** it would have led a later reader to dismiss a live gate as
decorative. Unknowable for `b` directly; corrosive to the gate's standing.

**Not a result, and not to be read as one.** The two-point ms/chunk contrast above spans P0
(excluded from every fit by construction) and a single unreplicated run, with no calibration
subtraction and no controls. It is recorded because refusing to write down an inconvenient
number one has already seen is its own defect — not because it bears on the verdict. The
verdict comes from 27 scored runs through the committed scorer, or it does not come at all.

**Gate 5 addendum.** `eval/e1-run.mjs`, the run-manifest schema, `eval/results/e1-schedule.json`
and `eval/results/e1-calibration.json` are committed **before scored run 1** — the standard
P0 already met (AMENDMENT 3 committed at `502ee6a` before the peek).

**Verified and unchanged** (attacked and not broken): the threshold 1.35; seed 811; the rung
fractions and the frozen manifest; Gate 1b's realized arithmetic, independently recomputed
(span 19.94×, `Sxx_cluster = 8.398`, rungs within 0.8% of target); the estimators — OLS, HC3,
CR1, Webb-weight bootstrap with restricted-residual testing and unrestricted percentile-t CI,
and the lack-of-fit F with its 5% floor; every degenerate-input guard, all of which fail *away*
from HOLDS; `chunk_count` as the exposure variable; the fitted clock's identity; Gate 0's
schema-version check (**extended** by A4-MAT-2, not replaced); the hardlink mechanism itself
(fast-glob with `followSymbolicLinks: false`, no `.gitignore` read, sorted deterministic walk,
`--state-dir` outranking every config source so nothing writes into a corpus); tree-sitter
grammar loading, which happens at module require and is therefore in neither the fitted clock
nor `c`; `retainStateDir`'s keying on repetition number; the E2 and R5 verdict tables; Gate 8.

**Registered process note, now five data points.** New this round: **two of the three most
serious findings were contradictions internal to this registration, not defects in the code** —
the verdict table against its own prose, and Gate 3's rationale against the calibration
paragraph. AMENDMENT 3's lesson was that repairs are a vector. This round's is narrower and
sharper: **a document amended three times accumulates internal inconsistency faster than it
accumulates errors, and the code is where those inconsistencies finally have to be resolved.**
Resolving one in code without an amendment — which is precisely what `combineE1Verdict` did,
and it happened to resolve it *correctly* — converts a documented contradiction into an
undocumented choice, and the next reader has no way to tell which it was.

#### E1 RESULT (2026-08-12) — SUPER-LINEAR REGRESSION: `b = 1.75`, and the upper half of the ladder is near-quadratic

**Verdict: SUPER-LINEAR REGRESSION.** The registered table's row 2 fires: the adjusted HC3
primary's 95% CI **lower** bound is 1.660, above the 1.35 threshold. Qualifier:
`lack_of_fit_mixture`.

The verdict is not marginal, and it is not reached through any of the disagreement routes
that would have made it AMBIGUOUS. All four registered classifications land on the same
side:

| fit | `b` | HC3 95% CI | wild-cluster bootstrap-t 95% CI | class |
|---|---|---|---|---|
| adjusted (`durationMs − c`) — **primary** | **1.7529** | **[1.6599, 1.8458]** | [1.5943, 1.9122] | above |
| raw (`durationMs`) | 1.7504 | [1.6573, 1.8435] | [1.5888, 1.9128] | above |

`c = 23.5 ms` (median of 10 empty-corpus runs). n = 27 tier runs over 9 tiers, df = 25,
`t₀.₉₇₅,₂₅ = 2.060`, bootstrap B = 10,000, seed 811, Webb 6-point weights, restricted
residuals for the test and unrestricted for the percentile-t CI. Adjusted and raw agree;
primary and sensitivity agree; `c` is small enough here that it moves `b` by 0.0025, so the
whole adjusted/raw protection is inert on this data rather than load-bearing.

**HOLDS was arithmetically reachable, and it was rejected.** This is the point of Gate 1b's
committed ceilings, and it is the difference between a measurement and an underpowered
shrug:

| level | realized σ | Gate 1b ceiling | |
|---|---|---|---|
| cluster (9 tier means about the line) — **the honest number** | 0.1851 | 0.28188 | within |
| run (27 runs about the line) | 0.2349 | 0.56055 | within |

**The shape, which the single exponent flattens.** Cost per chunk rises **10.2×** end to
end across a 20× corpus — this is the finding, and it is visible without any fit. It is
**not monotone**: T2 (1.167) exceeds T3 (0.926), because T2 was slot 1 of the whole schedule
and its Gate-3-failing first take is the coldest measurement in the ladder. The rise is
monotone from T3 upward.

| tier | chunks | files | reps (ms) | median | ms/chunk |
|---|---|---|---|---|---|
| T1 | 3,679 | 656 | 2,639 / 2,575 / 2,702 | 2,639 | 0.717 |
| T2 | 5,332 | 954 | 8,908 / 4,139 / 6,223 | 6,223 | 1.167 |
| T3 | 7,761 | 1,393 | 7,534 / 7,159 / 7,184 | 7,184 | 0.926 |
| T4 | 11,278 | 1,986 | 12,981 / 13,240 / 14,243 | 13,240 | 1.174 |
| T5 | 16,529 | 2,880 | 26,960 / 37,478 / 26,154 | 26,960 | 1.631 |
| T6 | 23,854 | 4,191 | 55,321 / 59,244 / 104,531 | 59,244 | 2.484 |
| T7 | 34,691 | 5,976 | 104,164 / 116,759 / 109,112 | 109,112 | 3.145 |
| T8 | 50,299 | 8,945 | 271,563 / 241,165 / 222,538 | 241,165 | 4.795 |
| T9 | 73,359 | 13,330 | 538,591 / 540,559 / 493,134 | 538,591 | 7.342 |

The lack-of-fit F fires (`F = 2.804`, `p = 0.0368`, df 7/18, departure **17.4%**, above the
5% practical floor), and the reason is curvature rather than noise: **`b` = 1.362 over
T1–T4 and 1.904 over T3–T9.** The upper half of the ladder is close to quadratic. A single
`b = 1.75` is therefore a *summary of a mixture*, and per A4-FATAL-1 this is reported as a
qualifier on SUPER-LINEAR — concordant evidence of a different flavour of not-clean-O(N) —
never as a downgrade to AMBIGUOUS.

**Supporting outputs.** `b_file = 1.7558`, within 0.003 of `b_chunk`, so trigger 5 does not
fire and the exposure choice is not doing any work here. Trigger 3 does not fire: bytes per
chunk is **flat** (5,863 at T1 vs 5,986 at T9, ratio 1.021) — the regression is in **time,
not space**, which rules out per-row storage bloat as the mechanism. Trigger 4 does not fire
(zero parse errors at every tier).

**Replication panel — supporting only, and it does not reproduce the exponent.** Fitted the
same way over 5 corpora × 3 reps: `b = 1.2790`, HC3 CI [0.9471, 1.6110], straddling 1.35.
It carries no verdict, and the registration said in advance why: content confounds scale
across unrelated repos. This data shows exactly that confound at full strength — P1 costs
**4.712 ms/chunk at 8,413 chunks** where the nested T3 costs **0.926 ms/chunk at 7,761
chunks**, a 5× per-chunk spread between corpora of near-identical size. A cross-corpus fit
is measuring content, which is the whole reason the decision-bearing axis is nested.

**Two Gate 3 findings, handled as registered.** T2#1 and T2#3 failed the clock-agreement
gate on all three attempts (final-attempt deltas 561 ms and 513 ms against a 500 ms floor).
Per A4-MAT-6 the **first** attempt's data enters the fit and the failure is logged, never
retaken away. Both are recorded in `e1-verdict.json` as `driver_findings`. The gate polices
the external cross-check clock, which never enters the fit; the excess is process boot, and
at T2's scale it is ~10% of a small run. Note that `gate3` on a thrice-failing run record is
the **last** attempt's verdict while `duration_ms` is the **first** attempt's value — the
registered combination, with every attempt preserved in `gate3_attempts`, but the two fields
do not correspond and a reader must not divide one by the other.

**A driver-flag discrepancy, resolved toward the registration.** `e1-run.mjs` sets
`scoreable: false` whenever `findings.length > 0`, which is stricter than anything
registered: A4-MAT-6 says a thrice-failing Gate 3 run is *logged and retained*, so this
class of finding was never a scoring blocker. The registered blockers — VOID runs (trigger
2) and chunk-count nondeterminism — did not fire: 42/42 complete, 0 void, and all three
repetitions of all 14 corpora reported identical `chunk_count`. Scoring proceeded on the
registered rule, and the flag is left as-is rather than edited after seeing data.

**A correction to an investigator claim made before this scoring ran.** During the run I
reported that "three corpora exceed Gate 1b's `σ_tier < 0.282` ceiling" (T2 0.384, P1 0.375,
T6 0.349). **That comparison was invalid** — those figures are the *within*-corpus sd of
three repetitions, and the ceiling governs the *between*-tier residual sd of the 9 tier means
about the fitted line. They are different quantities: repetition spread inflates the run
level and, where symmetric about the tier mean, leaves the cluster level untouched entirely.
The realized cluster σ is 0.1851, comfortably inside the ceiling. The mistake is pinned by a
test (`eval/__tests__/e1-report.test.mjs`, "separates within-tier spread from between-tier
departure") so it cannot recur silently. The largest repetition spreads (T6's 55.3 / 59.2 /
104.5 s, T2's 8.9 / 4.1 / 6.2 s) are still worth naming, but against no registered ceiling.

**What this means, stated no more strongly than the data supports.** M1's O(N) claim does
**not** extend from ~5k files to T9. Stage 2's regression proof is a proof at its own scale
and nothing beyond it, and Stage 2 reopens as a scale defect. The mechanism is not
identified here: E1 measures the exponent, not its cause, and flat bytes-per-chunk only
rules out storage bloat. Locating it — FTS5 index maintenance whose cost grows with existing
index size, the graph edge-resolution pass, or the write path — is separate work, and R2
(the parse-only pass) is the registered first cut at splitting parse cost from write cost.

##### E1 RESULTS REVIEW (2026-08-12) — the verdict survives; one registration violation found, running toward HOLDS

An adversarial results review was commissioned per §6 and its claims verified against source
and recomputed from `e1-runs.jsonl` (the ceremony's requirement — the reviewer has been wrong
before, and on the Q1/DECLEX round it over-read a design). **Every load-bearing claim it made
reproduced exactly.** Its judgement: SUPER-LINEAR survives every sensitivity it could
construct. The following amend this RESULT.

**R1 — a registration violation, and it is mine.** A4-MAT-3 requires an orphaned
attempt-start to be *"a logged finding"* whose re-attempt is *"counted against the retake
cap"*. Neither happened. The E1 schedule was interrupted **twice, both times on T9** — an
attempt started `21:38:21Z` and re-started `21:46:52Z`, another started `22:13:43Z` and
re-started `22:15:39Z` — and this RESULT's first version asserted "42/42 complete, 0 void"
with no trace of either. The defect was deeper than a missing `findings.push`: `loadJournal`
deleted a pair's pending start the moment the pair completed, so an interruption followed by
a *successful* re-attempt — exactly what happened — left no orphan to report at all. **This
is the precise scenario A4-MAT-3 was written to catch**, occurring twice, invisible to the
instrument written to catch it.

*Direction of error:* **toward HOLDS.** Warm re-runs censoring slow top-rung evidence biases
`b` down. It did not materialize — the two re-run T9 reps are **538,591 and 540,559 ms
against the uninterrupted rep's 493,134 ms**, i.e. the interrupted reps are the *slowest* of
the three. Fixed at the instrument, not just in prose: `orphanedAttempts` and
`remainingAttempts` in `eval/e1-schedule.mjs` with five tests, wired into `loadJournal`,
`summarise` and the retake budget. `e1-runs-summary.json` and `e1-verdict.json` regenerated
and now carry both `INTERRUPTED` findings.

**R3 — the panel scopes the claim as well as supporting it, and only one direction was
quoted.** The omitted contrast is the more informative one: **P4 indexes 93,518 chunks —
*more than T9* — at 2.97 ms/chunk (median 277,944 ms) against T9's 7.34.** That kills the
machine-artifact family of explanations outright (thermal accumulation, disk fill, hardlink
warmth, schedule position could not produce a slow T9 and a fast, larger P4 on the same box
in the same session), and it simultaneously bounds the finding: **7.34 ms/chunk is not a
universal function of chunk count.** T9 carries 51,551 symbols and 48,497 edges against P4's
17,987 and 11,820 — ~2.9× and ~4.1× — so the cost tracks symbol and edge density, not chunks
alone. "Stage 2 reopens as a scale defect" must not be read as "every 90k-chunk corpus costs
9 minutes."

**R4 — retake-retention sensitivity, quantified.** A4-MAT-6 fits the take that *passes* Gate
3, which on two runs was a warmer retake (T1#1 3,266→2,639; T3#2 7,299→7,159; T3#3 went the
other way). Refitting on **first attempts everywhere gives `b` = 1.7410, CI [1.6415,
1.8404]** — the registered rule contributes +0.012, and the lower bound clears 1.35 either
way.

**R2, R7 — two anomalies named plainly.** The ms/chunk rise is not monotone (corrected
above). **T6#3 = 104,531 ms is a 76% spike** over its siblings (55,321 / 59,244), run warm
immediately after T6#2, so cache warmth cannot explain it and nothing else is offered. It is
unexplained, not merely "spread worth naming". Dropping T6 entirely gives `b` = 1.7478.

**R5 — provenance, stated precisely.** Only the verdict machinery was pre-committed:
`scoreE1` at `d014d9d`, ~65 minutes before scored run 1. The **reporting seam**
(`eval/e1-report.mjs`) was written after the data existed, at `8a97bea`. On this journal it
had no discretion to exercise — 42 unique `(corpus, rep)` records, exactly 27 tier runs, no
voids — and the reviewer reproduced the selection and every downstream number independently.
Recorded anyway, because "it happened not to matter" is a finding about this dataset, not
about the instrument.

**R6 — the lack-of-fit p is nominal.** df 7/18 is correct, but the F pools pure error across
tiers whose within-tier `sd(ln)` spans 0.024 (T1) to 0.384 (T2); under that
heteroscedasticity `p = 0.0368` is approximate. The mixture qualifier does not rest on it —
the split-half slopes (1.362 / 1.904) and the 17.4% departure carry it.

**Sensitivities, all verified by recomputation from the journal.** Drop T2 → **1.8045**
[1.7194, 1.8896]; drop T6 → 1.7478; drop both → 1.7998; first-attempts-everywhere → 1.7410;
`c` ∈ {21, 48.9, 180} → 1.7526 / 1.7555 / 1.7696; cluster-mean fit at df = 7 → [1.602,
1.904]; an independently implemented Webb bootstrap with a different RNG → [1.602, 1.911]
against the harness's [1.594, 1.912]. **`corr(ln chunks, schedule position) = 0.0015`** over
the 27 tier runs, so the shuffle did its job; a real warming drift exists (residual-vs-slot
`r` = −0.36) but is orthogonal to size, and adding slot as a covariate moves `b` by 0.0001.
Symbols scale as `chunks^0.993`, edges `^1.080`, potential calls `^1.116` — near-linear, so
the time exponent is not smuggled in through a structural count.

**The three concrete biases actually present in this data all run toward HOLDS** — T2's
retained coldest first-takes, the warm T9 re-runs after interruption, and T9's exclusion of
the 655 zero-chunk files (logged in the frozen manifest). The verdict cleared 1.35 anyway,
on every estimator and every sensitivity constructed against it.

**Artifacts.** `eval/results/e1-verdict.json` (verdict, both fits, panel, triggers,
reachability), `eval/results/e1-runs.jsonl` (42 runs + 55 attempt records),
`eval/results/e1-runs-summary.json`, `eval/results/e1-calibration.json`,
`eval/results/e1-tiers.json` (frozen manifest + Gate 1b arithmetic). Scored by
`eval/e1-report.mjs` through `scoreE1`, which was committed at `d014d9d` before scored run 1
and is pinned by 56 known-answer cases.

### E1-PHASE PRE-REGISTRATION (2026-08-12) — which phase carries E1's exponent

**Status: registered, not yet run.** Committed before any scored run, per §6.

**This is a diagnostic, not a verdict experiment.** It cannot confirm, overturn or soften
E1's SUPER-LINEAR verdict, and no result here may be reported as doing so. E1 answered *how
steeply* cost grows; this answers *where the time goes*, which E1 could not, because
`runIndex` recorded only `durationMs` and its 42 runs are therefore undecomposable after the
fact. The output is a localisation, and its consumer is the choice of what to fix.

#### The question

E1 measured `b = 1.7529` over the nested ladder, `1.904` over T3–T9, while the work items
themselves grow near-linearly (symbols `chunks^0.993`, edges `^1.080`, potential calls
`^1.116`). So cost **per work item** grows with accumulated index size. Which phase?

#### Design

**Five rungs from the frozen E1 manifest — T1, T3, T5, T7, T9 — 3 repetitions each, 15
runs.** These are every other rung of the 9-rung ladder, so they remain **exactly evenly
spaced in `ln N`**: `d = ln(19.94)/4 = 0.7482`, `Σ_{k=−2}^{2} k² = 10`, giving
`Sxx_cluster = 5.598` and `Sxx_run = 16.79`. Chunk counts are fixed by the frozen manifest
at 3,679 / 7,761 / 16,529 / 34,691 / 73,359. Estimated machine time from E1's medians:
~11.4 min per repetition, **~35 min total**.

Everything else is inherited from E1 unchanged and must not be re-derived: the frozen tier
manifest, seed 811, the seeded-shuffle run order, cold-start discipline (fresh state dir per
run, never `--incremental`), per-`(corpus, rep)` state dirs, `assertCorpusPinned('n8n')` on
every tier run, `assertTierFileSet`, Gate 3's `max(5%, 500 ms)` clock rule with its retake
cap, and A4-MAT-6's first-attempt retention.

**The measured quantity is the per-phase exponent** `b_phase`, from OLS of
`ln(phase_ms)` on `ln(chunk_count)` across the 15 runs, plus each phase's **share of
`durationMs` at T9**. Both are reported for all five phases. HC3 SEs are reported;
**no threshold is registered and no verdict fires** — this instrument classifies, it does
not adjudicate.

**A free confirmatory signal, registered as such:** these 15 runs also yield a total-clock
exponent on a **different binary** from the one E1 measured (phase timers were added at
`2655164`). It is reported as a mini-replication of E1's 1.75. It is **not** a re-test of
the verdict — 5 rungs is a weaker design than 9 — and a discrepancy would be a finding about
the *instrument*, not about `b`.

#### Hypotheses and what each predicts, stated before the data

| | mechanism | prediction |
|---|---|---|
| **H1** | Page-cache cliff: 11 B-tree indices maintained during bulk insert (`graph/db.ts:288–350`) against a database reaching ~440 MB, with SQLite's default ~2 MB page cache and no `cache_size`/`mmap_size` pragma set (`db.ts:370–385`). *(⚠️ the "~2 MB" is WRONG — it is ~16 MB; see CORRECTION 2026-08-13. H1's decision conditions are purely numeric and are unaffected.)* | `b_write ≥ 1.6` **and** `b_parse ≤ 1.25` **and** write's share of `durationMs` at T9 `≥ 60%` |
| **H2** | Call/symbol resolution: pass 2's edge insertion scales with candidate sets that grow with the corpus. | `b_edges ≥ 1.6` **and** edges' share of `durationMs` rises monotonically T1→T9 |
| **H3** | Parse itself: tree-sitter cost growing faster than linearly in content. | `b_parse ≥ 1.6` |
| **H4** | Diffuse — no single phase carries it. | no phase reaches `b ≥ 1.6` |
| **H0** | **Residual, registered so the set is exhaustive:** all of H1–H4 refuted. Reachable — e.g. `b_write = 3.0` at a 45% T9 share refutes H1 on the share condition while write carries the entire exponent, and refutes H4 because a phase did reach 1.6. | outcome is **"localised, unclassified"**: report every exponent and share, adjudicate nothing, escalate exactly as H4 |

H1 and H2 are not exclusive; both may fire, and that is a reportable outcome rather than an
ambiguity to be resolved by choosing one.

**What a confirmed H1 does and does not license.** It confirms **write-localised,
size-coupled super-linearity** and nothing narrower. Chunks and database bytes are perfectly
collinear across this ladder, so this instrument **cannot distinguish** a page-cache cliff
from FTS5 trigram segment merges, per-file transaction overhead, or B-tree depth growth. Any
report calling a confirmed H1 "the page-cache cliff" is over-reading it. The mechanism
discriminator is registered here so it cannot be improvised later: **a `cache_size` /
`mmap_size` A/B at a single rung, run AFTER this diagnostic and BEFORE any shipped fix.**
That is a probe, not a remedy, and so does not breach "no fix before diagnosis".

**A fact that already damages H1's mechanism story, recorded before the run.** T1's database
is **21.6 MB** — already ~10× SQLite's ~2 MB default page cache — while the knee E1 measured
sits at T4/T5 (66 → 95 MB). A 2 MB cache is exhausted before the ladder begins, so it cannot
produce a knee there. *(⚠️ **WITHDRAWN 2026-08-13** — the default is ~16 MB, not ~2 MB, so
T1 is 1.3× the cache and this argument does not hold. See `CORRECTION (2026-08-13)` after the
E1-PHASE RESULTS REVIEW. Left standing as the historical record per §6.)* H1's *location* claim (write-localised) survives; H1's *mechanism*
claim as originally stated does not follow from the evidence I cited for it.

**Direction-of-error statement (mandatory field).** **My prior is H1** — I proposed it and
have not tested it, so every free parameter here leans toward finding it. **The compensation
I first claimed was largely theatre, and is corrected rather than defended.** Because the
phases tile `durationMs`, the total slope is share-weighted: `b_total = Σ share_i · b_i`. Given
E1's T3–T9 slope of 1.904, `b_parse ≤ 1.25` is near-automatic *a priori* (symbols scale
`^0.993`, edges `^1.080`, bytes/chunk flat), and once the share condition holds, `b_write ≥ 1.6`
follows arithmetically — at a 60% share with parse at 1.25 and the rest linear,
`b_write ≈ 2.38`. **Exactly one substantive free condition remains: write's T9 share ≥ 60%.**
The other two are consistency checks, not independent hurdles, and are reported as such.
Condition counts, corrected: H1 needs 3 (one substantive), **H2 needs 2**, H3 and H4 need 1.
The 1.6 bar sits below E1's measured 1.75 so a phase carrying the exponent is not narrowly
missed, and it is the same bar for every hypothesis.

#### Gates

- **Gate 0** — binary identity: `dist` content hash and `schema_version` recorded and
  re-asserted at every start and restart. The binary **has changed** since E1 (`2655164`), so
  `c` is re-calibrated from 10 empty-corpus runs; E1's `c = 23.5 ms` is **not** reused.
- **Gate 1** — corpus integrity: n8n pin re-asserted per run; each run's `SELECT path FROM
  files` equals the frozen manifest's file set for its tier, exactly.
- **Gate 3** — both clocks recorded, `max(5%, 500 ms)`, retakes capped at 2 then logged, and
  orphaned attempts charged against that cap (A4-MAT-3, implemented at `77b44ef`).
- **Gate P (new)** — **attribution**: on every scored run, `Σ phase_ms ≥ 0.95 × durationMs`.
  A run below that is VOID pending diagnosis, and joins A4-MAT-7's re-run queue.

  *Re-anchored on a measurement (design review P8).* The first draft set 90% on the strength
  of a one-file 22 ms smoke run, whose ~7 `Date.now()` stamps are quantization-dominated and
  could not distinguish 96% attribution from 80%. `eval/e1-phase-attribution.mjs` ran the
  real T1 rung three times: **attribution 99.91 / 99.93 / 99.93%**, remainder 3 / 2 / 2 ms.
  The floor is 95% — beneath the worst observation with ~5 points of headroom — and it stays
  permissive on purpose: the remainder is `db.destroy()`'s WAL close-time checkpoint, which
  is genuinely size-coupled, and a tight floor would VOID T9 for exhibiting the very growth
  the experiment is looking for. **The remainder is therefore policed as a FINDING, not a
  gate: a remainder share above 2% at any rung is reported and discussed** — T1's is 0.09%,
  so 2% is a 20× rise, not a tolerance.
- **Walk-share void condition, re-anchored the same way**: `walk` measured **1.27–1.47%** of
  `durationMs` at T1, so the registered 10%-at-T9 tripwire is generous and correctly aimed
  rather than arbitrary. Unchanged.

**Declared peek (P0 precedent).** The attribution runs above are T1 rung measurements taken
*after* this registration was committed at `0298a98` but *before* the scored runs, and they
necessarily revealed T1's phase shares. The mitigation is ordering, and it is already
discharged: every threshold these numbers could tune — the 1.6 exponent bar, `b_parse ≤ 1.25`,
**and the 60% write-share condition** — was committed at `0298a98`, before the measurement
existed. The three runs are excluded from every E1-PHASE fit and from the run count; they are
gate calibration, not measurement, and `eval/results/e1-phase-attribution.json` records them
in full so the peek is auditable rather than merely asserted.
- **Gate P2** — **rep identity**: as in E1, a tier's three repetitions must report identical
  `chunk_count`; disagreement voids that tier.

#### Falsification criteria

- **H1 is refuted** if any of: `b_write < 1.6`, `b_parse > 1.25`, or write's T9 share `< 60%`.
- **H2 is refuted** if `b_edges < 1.6` or edges' share does not rise monotonically.
- **H3 is refuted** if `b_parse < 1.6`.
- **The whole instrument is void** if Gate P fails on any scored run, or if `walk` — a fixed
  cost that dominated the one-file smoke run at 11 of 22 ms — exceeds **10%** of `durationMs`
  at T9, which would mean the phase split is mis-drawn and the fit is measuring startup.
- **If H4 or H0 holds**, the next step is *not* another ladder: it is statement-level
  profiling inside the highest-share phase, and this registration says so now so that a
  diffuse or unclassified result is not quietly re-analysed into a localisation.

#### Estimator and aggregation rules, registered so nothing is chosen after the data

Every clause here closes a lever the first draft left open. The precedent is four
consecutive rounds in which the unregistered choice was later resolved toward the prior
(A4-FATAL-1, A4-MAT-1, A4-MAT-6).

- **Comparisons are on HC3 point estimates.** SEs and CIs are reported for context and have
  **no role in any refutation**. At 5 rungs a cluster-level 95% CI is roughly ±0.22 even at
  E1's realized `σ_tier = 0.185`, so permitting "the CI touches 1.6" would make every
  condition negotiable after the fact.
- **"Share at T9" is computed from T9's median run**, by `phase_ms / durationMs`. Not the
  mean, not a pooled ratio-of-sums.
- **H2's monotonicity is strict, on per-tier median shares, across all five rungs.** A tie
  breaks it.
- **`ln(0)` is not permitted:** any scored run with a null `phase_ms` (a binary predating
  `2655164`) or any phase `≤ 0` is **VOID**, never silently dropped. `parsePhaseMs` returns
  null by design so the harness can still read E1's own history; on an E1-PHASE scored run
  that null is a defect.
- **A Gate P or Gate P2 VOID joins A4-MAT-7's re-run queue**, whose semantics apply
  unchanged; it is not an excuse to fit around the gap.
- **The unattributed remainder** (`durationMs − Σ phase_ms`) is fitted and reported as a
  sixth series with its T9 share. Its registered reading is **"teardown, including WAL's
  close-time checkpoint"** — `db.destroy()` (`index.ts:445`) runs after the `finalise` stamp
  (`:443`) and before `durationMs` (`:459`), making it the one size-coupled cost outside
  every phase. Reported rather than tolerated as slack, because Gate P's 10% tolerance is
  ~54 s at T9 and unattributed time is exactly where the mechanism could hide.
- **The mini-replication is fitted with E1's own registered estimator** (adjusted clock,
  OLS + HC3) and is **"consistent" iff its 95% CI covers 1.7529**. Anything else is logged as
  an instrument finding and adjudicates nothing in either direction — it may not soften E1
  and may not be claimed as strengthening it.
- **The "no threshold, no verdict" sentence above governs the HYPOTHESIS SET, not the gates.**
  H1–H4 are classifications with registered refutation conditions; none of them is a verdict
  on MAST's scaling, which E1 alone carries.

#### What is deliberately NOT done

No fix is applied and no pragma is changed before this runs. Measuring the current binary is
the point; changing `cache_size` first would confound the diagnosis with the remedy. Any fix
that follows is verified by re-running **E1's full 9-rung registered ladder** against the
committed scorer and the immutable 1.35 threshold — not by re-running this diagnostic, and
never by moving a threshold.

#### ADDENDUM (2026-08-12, written while building the instrument, BEFORE any scored run)

Building `eval/e1-phase-run.mjs` surfaced six choices the registration above does not fix.
Each is an unregistered lever, and this program's own record says an unregistered lever gets
resolved toward the investigator's prior (A4-FATAL-1, A4-MAT-1, A4-MAT-6, four rounds
running). They are therefore closed here, in writing, before the instrument is run — not
defended afterwards. **No threshold in the registration moves; these are readings of it.**

1. **"T9's median run" is the run with the median `duration_ms`** among that rung's three.
   Three repetitions is odd, so the median run is unique and no averaging occurs. Not the
   mean and not a pooled ratio-of-sums, both of which the registration already excludes.
2. **"Per-tier median share" (H2's monotonicity input) is the median of the rung's three
   per-run shares** — a different statistic from item 1, which is why `tierShares` publishes
   **both** readings at every rung (`median_run` and `median_of_shares`). Publishing one
   would leave the choice between them available after the data arrived.
3. **H4 is evaluated over the five phases only.** The remainder is not a phase. If the
   remainder alone reached the 1.6 bar while no phase did, H4 still fires exactly as
   registered, and the remainder's exponent is reported beside it as a finding rather than
   folded into the classification.
4. **A non-positive remainder at any rung makes the sixth series unfittable**, reported as
   `degenerate: non_positive_values` plus a finding. It is neither dropped nor a VOID: the
   registered `ln(0)` VOID governs *phases*, and widening it to the remainder would let
   millisecond rounding at T1 void an entire rung.
5. **Gate P is evaluated on the FITTED attempt**, after `selectFitted` — the run that will
   actually be scored, not the last one spawned. Checking the last attempt would let a
   thrice-failing pair pass Gate P on a decomposition that never enters the fit.
6. **`scoreable` encodes the registered blockers only** — VOID runs and Gate P2
   chunk-count disagreement. A thrice-failing Gate 3 run is logged and retained (A4-MAT-6)
   and is **not** a blocker. E1's driver conflated the two into one stricter flag, which the
   E1 RESULT recorded as a discrepancy resolved toward the registration; it is encoded
   correctly here rather than inherited wrong.

**Binary identity, recorded before the run.** `pnpm -F mast build` at this commit reproduces
`dist` content hash `454894e50ccdf7fc299fe7f5af006217b1bfbed396663e9a1be14c5efe35aa4c` —
**the same hash `eval/results/e1-phase-attribution.json` carries**. Gate P's 95% floor and
the scored runs therefore measure one build, which is what makes the floor's ~5 points of
headroom meaningful rather than a comparison across binaries.

**`c` is re-measured, not inherited.** E1's `c = 23.5 ms` was measured on the pre-`2655164`
binary and is not reused; `eval/results/e1-phase-calibration.json` is written by this
instrument's own 10 empty-corpus runs.

**Instrument, committed before any scored run (Gate 5).** `eval/e1-phase-schedule.mjs` (the
5-rung schedule, Gate P, the `ln(0)` guard, and the state-dir namespacing that keeps E1's
retained rep-3 artifacts alive), `eval/e1-phase-score.mjs` (every threshold and the
classification), `eval/e1-phase-run.mjs` (the driver), `eval/e1-phase-report.mjs` (the
journal seam), and 68 known-answer tests across three files — including the registration's
own worked H0 counterexample (`b_write = 3.0` at a 45% T9 share), every boundary at `>=`
/ `<=`, and H2's strict-monotonicity tie. E1's own modules are **not** modified: what
E1-PHASE inherits unchanged it imports.

#### E1-PHASE RESULT (2026-08-12) — H1 FIRES: the exponent is in the WRITE phase, and the mechanism is still unidentified

**Outcome: H1.** All three registered conditions hold, and H2, H3 and H4 are each refuted.
15/15 runs complete, 0 VOID, 0 interrupted, no driver findings, `scoreable: true`.

| condition | registered test | measured | |
|---|---|---|---|
| `b_write` | `>= 1.6` | **1.9685** | pass |
| `b_parse` | `<= 1.25` | **1.0144** | pass |
| write's share of `durationMs` at T9 | `>= 0.60` | **94.01%** | pass |

| series | `b` | HC3 95% (context only) | T9 share |
|---|---|---|---|
| walk | 0.6019 | [0.5446, 0.6591] | 0.05% |
| parse | 1.0144 | [0.9930, 1.0359] | 4.33% |
| **write** | **1.9685** | **[1.8800, 2.0569]** | **94.01%** |
| edges | 1.4360 | [1.2333, 1.6388] | 1.56% |
| finalise | 1.2623 | [1.1189, 1.4057] | 0.05% |
| remainder | 0.5504 | [0.3253, 0.7756] | 0.002% |

| rung | chunks | walk | parse | write | edges | finalise |
|---|---|---|---|---|---|---|
| T1 | 3,679 | 1.40% | 42.80% | 52.18% | 3.39% | 0.15% |
| T3 | 7,761 | 0.72% | 32.54% | 63.69% | 2.87% | 0.11% |
| T5 | 16,529 | 0.30% | 17.93% | 80.02% | 1.64% | 0.09% |
| T7 | 34,691 | 0.11% | 9.55% | 88.88% | 1.39% | 0.06% |
| T9 | 73,359 | 0.05% | 4.33% | **94.01%** | 1.56% | 0.05% |

**Write is near-quadratic and it eats the ladder.** Parse is essentially exactly linear
(1.0144), walk is sub-linear (0.6019), and write's share of the clock climbs monotonically
from 52% to 94% while parse's collapses from 43% to 4%. At T1 the run is a parse/write
split; at T9 it is a write.

**What this licenses, stated at exactly the registered strength: "write-localised, mechanism
unidentified", and nothing narrower.** Chunks and database bytes are perfectly collinear
across this ladder, so this instrument **cannot distinguish** a page-cache cliff from FTS5
trigram segment merges, per-file transaction overhead, or B-tree depth growth. Any report
calling this "the page-cache cliff" is over-reading it. **The fact recorded before the run
still stands and still damages that specific mechanism story:** T1's database is 21.6 MB
against SQLite's ~2 MB default page cache, so the cache is exhausted before the ladder
begins and cannot produce the T4/T5 knee E1 measured. H1's *location* claim is confirmed;
H1's *mechanism* claim is not, and was not tested here.

> ⚠️ **The paragraph above is WITHDRAWN as of 2026-08-13 — see `CORRECTION (2026-08-13)`
> below.** The default page cache is **~16 MB**, not ~2 MB (`better-sqlite3` compiles
> `SQLITE_DEFAULT_CACHE_SIZE=-16000`), so T1 is 1.3× the cache rather than 10× and the
> "exhausted before the ladder begins" argument does not hold. Text left standing as the
> historical record per §6. **The sentence either side of it is unaffected:** H1's location
> claim is still confirmed and its mechanism claim is still untested — withdrawing a piece
> of counter-evidence does not promote the mechanism story, it only removes the grounds for
> dismissing it without measuring.

**Direction of error, revisited against the outcome.** H1 was the previous agent's own
hypothesis and every free parameter leaned toward finding it — that was registered in
advance, and it fired. Two things keep this from being a prior confirming itself. First, the
registration corrected its own compensation claim before the run: because phases tile
`durationMs`, only **one** condition was substantively free — write's T9 share — and the
other two are arithmetic consequences. That one free condition came in at **94.01% against a
60% bar**, clearing it by 34 points rather than narrowly. Second, the registration's own
worked H0 counterexample (`b_write = 3.0` at a 45% share, which refutes H1 while write
carries the whole exponent) is a committed known-answer test in
`eval/__tests__/e1-phase-score.test.mjs` and passes — the scorer demonstrably *can* refuse
H1 on the share condition alone.

**H2 is refuted on both of its conditions, and one of them is a near miss that the
registration's estimator rule refuses to negotiate.** `b_edges = 1.4360` with HC3
[1.2333, **1.6388**] — the interval touches the 1.6 bar. The registration puts every
comparison on HC3 **point estimates** and says CIs "have no role in any refutation",
precisely so a touching interval cannot be argued into a firing. It is recorded here as the
first case where that clause actually bound. Edge share is also **not** monotonic: it falls
T1→T7 and rises again at T9 (3.84 → 2.87 → 1.71 → 1.39 → 1.57% on per-rung median shares;
3.39 → 2.87 → 1.64 → 1.39 → 1.56% on the median run's shares). **Both registered readings of
"median share" give the same refutation**, so the addendum's item-2 choice changes nothing
here.

**A registered prediction that the data refutes — the remainder is NOT size-coupled.** The
registration's reading of the unattributed remainder was "teardown, including WAL's
close-time checkpoint... the one **size-coupled** cost outside every phase", and Gate P was
deliberately left permissive to avoid voiding T9 for exhibiting that growth. Measured:
`b_remainder = 0.5504`, strongly **sub**-linear, with its share falling 0.074% → 0.002% from
T1 to T9 (2 ms → 12 ms absolute, against a 20× corpus). The remainder is real but inert, the
permissiveness it justified was never needed, and the registered *reading* of it is wrong.
Recorded rather than quietly dropped, because it is a prediction this registration made and
lost.

**Gates.** Gate P (attribution ≥ 95%): **99.85–100.00%** on all 15 runs, worst 99.85% at
T1#3. Walk-share void condition (10% at T9): **0.05%**. Gate P2 (rep identity): all three
repetitions of all five rungs reported identical `chunk_count`. Gate 0: `dist`
content hash `454894e5…`, identical to the build
`eval/results/e1-phase-attribution.json` was measured on, so Gate P's floor and the scored
runs share one binary. `c = 15 ms` (median of 10 empty-corpus runs), re-measured — **E1's
23.5 ms was not reused**. Note the direction: the constant **fell**, 23.5 → 15 ms, across a
change that *added* timing stamps. **I have no explanation for that and do not offer one**;
machine and OS-cache state differ between sessions, and `c` is small enough here to be
inert either way (the mini-replication is 1.7768 at `c = 15` and 1.7778 at `c = 23.5`).

**Gate 3 and retake retention, with the bias named and quantified.** Two runs missed the
clock-agreement gate, **both at T3**: T3#3 failed on attempts 1 and 2 (deltas 531 and 505 ms
against a 500 ms floor) and passed on attempt 3; T3#1 failed on attempt 1 (551 ms) and passed
on attempt 2. Both therefore retained a **passing** take, and A4-MAT-6's first-attempt rule
never engaged — there was no thrice-failing run. The journal reconciles exactly: **18
`attempt_start` records against 18 completed attempts across 15 runs, so `orphanedAttempts`
reports zero**, and A4-MAT-3's interruption class did not occur.

*The direction of that retention is unfavourable and is stated rather than left implicit.*
Both retained takes are **faster** than their first attempts (7,185 vs 7,210 ms; 7,350 vs
7,622 ms), and they sit at a **low** rung — retaining faster takes at the bottom of a ladder
biases the slope **upward**, i.e. toward the super-linear write result this experiment
reports. Refitting on **first attempts everywhere** moves nothing that matters:
`b_write` **1.9685 → 1.9683**, `b_parse` 1.0144 → 1.0093, `b_edges` 1.4360 → 1.4392, write's
T9 share unchanged at 94.01%, mini-replication 1.7768 → 1.7750, **outcome H1 either way**.
The bias is real, is in the flattering direction, and is worth −0.0002.

**The mini-replication is consistent, and it adjudicates nothing.** `b = 1.7768`, HC3 95%
[1.6693, 1.8843], which covers E1's 1.7529 — "consistent" by the registered rule, on a
**different binary** and a weaker 5-rung design. It may not be read as strengthening E1's
verdict and could not have softened it. Its wild-cluster bootstrap interval is
[1.0429, 2.5107]: five clusters is very few for Webb weights, and that width is a fact about
this design, not about `b`.

**An arithmetic cross-check that was not registered and is offered as such.** Because the
phases tile the clock, the local slope at a rung is the share-weighted sum of the phase
exponents. Evaluated at T9's shares that gives **1.9178**, against E1's independently
measured T3–T9 slope of **1.904** — two binaries, two experiments, 0.7% apart. This is a
consistency observation, not a test, and no conclusion rests on it.

**What this does NOT do.** It cannot confirm, overturn or soften E1's SUPER-LINEAR verdict,
and nothing here is reported as doing so. E1 answered how steeply cost grows; this answers
where the time goes.

**Next step, as registered and not improvised now:** a `cache_size` / `mmap_size` A/B at a
single rung — a **probe, not a remedy** — run before any shipped fix. No pragma has been
set and no index creation deferred. Any fix that follows is verified by re-running **E1's
full 9-rung ladder** against the committed scorer and the immutable 1.35 threshold, never by
re-running this diagnostic.

**Artifacts.** `eval/results/e1-phase-verdict.json` (exponents, shares under both readings,
the full condition table, mini-replication), `e1-phase-runs.jsonl` (15 runs + 18 attempt
records), `e1-phase-runs-summary.json`, `e1-phase-calibration.json`, `e1-phase-schedule.json`
(schedule + binary pin), `e1-phase-attribution.json` (Gate P's anchor).

##### E1-PHASE RESULTS REVIEW (2026-08-12) — H1 stands; the provenance claims around it do not

An adversarial results review was commissioned per §6, and **every load-bearing claim it made
was verified against source or recomputed before being accepted here**. It reproduced all six
exponents, both HC3 interval sets, both share readings at all five rungs, the mini-replication,
the first-attempts refit and the share-weighted cross-check — exactly — under an independently
written OLS+HC3 and its own wild-cluster bootstrap ([1.037, 2.486] against the harness's
[1.043, 2.511]). It confirmed the scorer is faithful to the registered rules line by line, that
Gate P's VOID path is reachable and evaluated on the fitted attempt, and that the corrective
commit `952f691` moved the record **against** the investigator. **The arithmetic carries no
error running toward H1. The narrative did, in three places.**

**RR1 — the declared peek partially answered the one "free" condition, and the RESULT above
oversold that condition as a risky test.** `e1-phase-attribution.json` (created
`01:06:46Z`) revealed write already at **51.7 / 54.9 / 56.2% of the clock at T1**. Given that,
and E1's already-known convex total curve, write's T9 share falling below 60% would have
required another phase to out-grow write from a ~3.4% base — roughly `b_edges ≈ 2.7`. So
"cleared it by 34 points rather than narrowly" is true arithmetic and **weak epistemics**: the
share condition was close to foreordained once the peek existed. The registration's mitigation
(every threshold committed at `0298a98`, verified: `00:12:17Z`, before the peek) protects
against threshold-tuning and **does not** protect against this. What remains genuinely
informative is the localisation itself — parse at exactly 1.0144, write's 52% → 94% climb —
not the fact that a bar was cleared.

**RR2 — the estimator rules were registered later than the RESULT implies, and the
point-estimate clause was never actually outcome-determinative.** Verified: the "Estimator and
aggregation rules" section is **absent from `0298a98`** and was added at `5f7ef33`
(`01:08:27Z`) — ~100 seconds *after* the attribution peek, though still ~90 minutes before the
first scored run. The four numeric constants (1.6 / 1.25 / 0.60 / 1.7529) *are* in `0298a98`;
the rules built on them are not. Two mitigations verified: a single-rung peek yields no
exponent and no interval, so the point-estimate clause could not have been tuned to `b_edges`'
near-miss; and **H2 was independently refuted by non-monotone edge shares under both registered
readings**, so a CI-based rule would have fired nothing either. Consequence for the RESULT
above: **"the first case where that clause actually bound" is withdrawn.** It did not bind —
H2 died on monotonicity regardless.

**RR3 — Gate 5's margin was 24 seconds, and part of the calibration predates the commit.**
Verified timestamps: `e1-phase-schedule.json` written `01:36:42Z`; commit `e69020a` landed
`01:37:29Z`; calibration completed `01:37:52Z`; first scored `attempt_start` `01:37:53Z`. So
"committed before any scored run" holds **by 24 seconds**, the driver process was loaded from
the working tree before the commit existed, and most of the 10 empty-corpus runs behind
`c = 15` ran pre-commit. Behavioural identity was checked rather than assumed: `git diff
e69020a..HEAD -- eval/` is empty, the committed `buildPhaseSchedule` reproduces the pinned
schedule bit-for-bit, and every Gate 3 decision in the journal matches the committed
`gate3Verdict` arithmetic. Nothing indicates the running code differed from the committed
code — but Gate 5 is a provenance gate, and a 24-second margin is worth disclosing rather
than claiming comfortably.

**RR4 — the remainder refutation is qualitatively sound and quantitatively spurious.**
Remainder values span **1–14 ms** and are millisecond-quantized. A ±1 ms adversarial
perturbation moves `b_remainder` across **0.37–0.79**, wider than its own printed HC3 interval
[0.3253, 0.7756] — so four decimals on 0.5504 are theatre. The qualitative claim survives every
perturbation (sub-linear under all of them; share falls 0.074% → 0.002%), so the registered
"size-coupled" reading is still refuted; the *precision* is withdrawn.

**RR5 — omissions now named.** (a) **T5's repetition spread is 12.5%** (27,105 / 29,649 /
30,498 ms) against ≤2.7% at every other rung; unexplained, and unmentioned above where E1's
RESULT named its own T6 spike. Dropping T5 entirely leaves `b_write` at 1.9685; dropping any
single rung keeps it in 1.90–2.08. (b) **Write itself is a mixture**: split-half `b_write` is
**1.8378** over T1–T5 and **2.0627** over T5–T9, the same convexity E1 carried as a formal
qualifier — so "consistent with E1's 1.7529" compares two mixture summaries. (c) **The
coupling looks DB-wide, not write-exclusive**: `edges` at 1.436 and `finalise` at 1.2623 both
exceed the near-linear growth of the items they process (edge count scales `chunks^1.080`),
and edges' share upticks at T9. At a 1.6% share this changes no fix priority, but a reader
localising to "write" should know the neighbours lean the same way.

**RR6 — a latent instrument defect, unexercised.** A Gate P or Gate P2 VOID that is later
successfully re-run leaves the void in `loadJournal`'s map, so `scoreable` stays false
permanently: A4-MAT-7's "re-run queue" has no dequeue in `e1-phase-run.mjs`. Zero voids
occurred, so it touched nothing here. **Fix before any reuse of this instrument** — it joins
HANDOFF §5's defect list.

**What survives all of it.** H1 — **write-localised, mechanism unidentified** — stands
unchanged, on every estimator and every sensitivity constructed against it. What is amended is
the confidence language around it, in the three places where this RESULT's first version
flattered its own hypothesis.

##### CORRECTION (2026-08-13) — the "~2 MB default page cache" figure is wrong by 8×, and it was load-bearing

Found while building the A/B's lever (`2127ef7`), before the A/B was designed. A test asserting
that `openDatabase` leaves the page cache at SQLite's own default was written against a bare
`better-sqlite3` connection rather than a hardcoded constant, and it reported **`cache_size =
-16000`** — not the `-2000` the E1-PHASE registration assumed.

**Verified at primary source, not inferred from the observation.** `better-sqlite3@12.11.1`
(SQLite 3.53.2) compiles the amalgamation with `SQLITE_DEFAULT_CACHE_SIZE=-16000`
(`deps/defines.gypi:13`), overriding the `#ifndef` fallback of `-2000` in `sqlite3.c:14850`;
the flag's presence on the shipped object's own compile command line
(`build/Release/.deps/…/sqlite3.o.d`) confirms it reached the binary rather than merely the
build file. Measured on the same install: `page_size = 4096`, and **`mmap_size = 0`** — memory
mapping is OFF by default, so an mmap arm is an on/off contrast, not a resize.

**MAST's effective default page cache is therefore ~16.0 MB (16,000 KiB), not ~2 MB.**

**What this overturns.** The registration recorded, as a pre-run fact damaging H1's mechanism
story: *"T1's database is 21.6 MB — already ~10× SQLite's ~2 MB default page cache — while the
knee E1 measured sits at T4/T5 (66 → 95 MB). A 2 MB cache is exhausted before the ladder
begins, so it cannot produce a knee there."* At the true default, T1's 21.6 MB is **1.3×** the
cache, not 10×. The ladder does not begin with the cache already exhausted — it **crosses** the
cache boundary at roughly its first rung and reaches 4–6× the cache by T4/T5. That is the
regime in which a cache cliff would produce a knee, which is precisely where E1 measured one.

**Direction of error — stated because this one runs the wrong way.** The correction **removes a
piece of counter-evidence against the hypothesis the previous session held**, and so makes the
cache-cliff story more plausible, not less. Under §6 ("a result that flatters the thing you are
testing deserves MORE scrutiny") it is recorded with its own limits attached:

1. **Database size is not working set.** A bulk insert's hot pages are the 11 indices' interior
   B-tree nodes and FTS5's in-flight segment structures, not the whole file. Neither the old
   comparison nor the corrected one is decisive about residency; what changed is only that the
   *ratio degrades ~5× across the ladder* instead of being pinned far past the cliff from the
   start.
2. **The 21.6 MB T1 figure is inherited, not re-measured here.** It is carried forward from the
   previous session on its own authority.
3. **This does not promote H1's mechanism claim.** A confirmed H1 still licenses
   "write-localised, mechanism unidentified" and nothing narrower — FTS5 segment merges,
   per-file transaction overhead and B-tree depth growth remain indistinguishable on the
   E1-PHASE evidence. What the correction changes is that the cache cliff can no longer be
   waved off *a priori*; it has to be measured. That is what the A/B is for.

**Consequence for the A/B's registration:** its arms must be sized against the real **16 MB**
baseline. An arm at, say, 8 MB or 64 MB was going to be described relative to a 2 MB control
that does not exist, and the "control" arm is not a small cache — it is already a moderately
large one.

### E1-AB PRE-REGISTRATION (2026-08-13) — is the page cache the mechanism behind write's super-linearity?

**Status: registered, not yet run.** To be committed before any scored run, per §6.

**This is a probe, not a remedy, and not a verdict experiment.** It cannot confirm, overturn
or soften E1's SUPER-LINEAR verdict, and no result here may be reported as doing so. It also
cannot re-adjudicate E1-PHASE: H1 (write-localised, mechanism unidentified) stands whatever
this returns. It is the mechanism discriminator registered *inside* the E1-PHASE registration
precisely so it could not be improvised after the result. **No pragma is shipped on the
strength of it.** Any fix that eventually follows is verified by re-running **E1's full 9-rung
ladder** against the committed scorer and the immutable 1.35 threshold — never by re-running
E1-PHASE, never by re-running this, and never by moving a threshold.

#### The question

E1-PHASE localised the exponent to the write phase (`b_write = 1.9685`, 94.01% of the clock at
T9) and licensed **"write-localised, mechanism unidentified" and nothing narrower**. Chunks and
database bytes are perfectly collinear across that ladder, so a page-cache cliff, FTS5 trigram
segment merges, per-file transaction overhead and B-tree depth growth are indistinguishable on
that evidence. This experiment breaks the collinearity on exactly one of those candidates, by
varying the page cache **at fixed corpus size** and watching whether write time moves.

#### Facts this design rests on, each measured or read at primary source (not inherited)

| fact | value | source |
|---|---|---|
| default page cache | `cache_size = -16000` → **15.63 MiB** | `better-sqlite3@12.11.1` `deps/defines.gypi:13`, on the shipped object's compile line |
| default memory map | `mmap_size = 0` — **off** | measured on a live connection |
| mmap ceiling on this platform | `SQLITE_MAX_MMAP_SIZE = 0x7fff0000` (~2 GiB) | `sqlite3.c:16129`, `__APPLE__ && __MACH__` branch; no `SQLITE_MAX_MMAP_SIZE` define in `defines.gypi` |
| WAL commit durability | `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1` → **NORMAL** | `defines.gypi:15` |
| T1 `graph.db` | **21,569,536 B = 20.57 MiB** = 1.32× the cache | `ls -l ~/.cache/mast-eval/e1/phase-run-T1-r3/graph.db`, re-measured today |
| T9 `graph.db` | **439,140,352 B = 418.8 MiB** = 26.8× the cache | same, `phase-run-T9-r3` |
| write structure | **one transaction per file** (~13,330 at T9) | `src/indexer/index.ts:369` and the `populateFile` loop beneath it |

The T1/T9 sizes discharge limit 2 of the `CORRECTION (2026-08-13)` above — the 21.6 MB figure
was inherited there on the previous session's authority and is now first-hand.

Two of these actively shape the design. `synchronous = NORMAL` means a per-file commit does
**not** fsync, so per-transaction durability cost is not the linear floor one would otherwise
assume. And `mmap_size = 0` means the mmap arm is an **on/off** contrast, not a resize.

#### Design

**Two rungs — T1 and T9 — four arms, three blocks: 24 runs.**

| arm | flags | expected `pragmas:` echo | role |
|---|---|---|---|
| **A** | *(none)* | `{"cache_size":-16000,"mmap_size":0}` | control — the un-pragma'd binary |
| **B** | `--cache-size-mib 1024` | `{"cache_size":-1048576,"mmap_size":0}` | cache exceeds T9's whole database (1024 MiB vs 418.8 MiB, 2.4×), so **no page can ever be evicted** |
| **C** | `--mmap-size-mib 1024` | `{"cache_size":-16000,"mmap_size":1073741824}` | memory mapping ON, cache at default — isolates the read-path syscall/copy cost |
| **D** | `--cache-size-mib 2` | `{"cache_size":-2048,"mmap_size":0}` | **positive control** — an 8× *shrink*, to the figure the E1-PHASE registration wrongly assumed was the default |

Arm B's size is chosen by a rule, not by taste: **≥ 2× T9's final database size**, so that the
arm is "the cliff cannot exist" rather than "a bigger number". Arm D is 2 MiB = `-2048`, near
but not identical to the `-2000` the registration assumed; the difference is 2.4% and is
noted so nobody later reads `-2048` as a transcription error.

**Why two rungs when the E1-PHASE registration said "at a single rung".** This is a deliberate
expansion of the registered scope and is declared as one. A single-rung contrast measures a
**level** effect; the claim under test is about an **exponent**. T1 costs 2.7 s against T9's
8.9 min, so the second rung is **0.5% of the schedule's machine time** and buys the only
statistic that speaks to size-coupling (below). Expanding a registered scope *before* running,
in writing, with the reason, is the opposite of the failure mode §6 guards against.

**Blocked, not shuffled globally.** Each of the 3 blocks contains all 8 `(arm × rung)` cells,
ordered by a seeded shuffle (**seed 4409**, committed here). Blocks run sequentially. Every arm
therefore appears exactly once per block, so a monotone machine drift across a ~2-hour schedule
loads onto all arms roughly equally instead of onto whichever arm ran last.

**State dirs are namespaced `e1ab-run-<arm>-<tier>-r<k>` under `~/.cache/mast-eval/e1/`.**
`runColdIndex` wipes its state dir before every run, and E1's `run-T9-r3` / E1-PHASE's
`phase-run-T9-r3` are retained artifacts that Gate 6 and any future audit read. Note also that
`~/.cache/mast-eval/ab-runs/` and `ab-state/` **already exist** and belong to the unrelated
paraphrase A/B — the `e1ab-` prefix avoids that collision too. Pinned by a test.

Everything else is inherited from E1/E1-PHASE unchanged and must not be re-derived: the frozen
tier manifest, `assertCorpusPinned('n8n')`, `assertTierFileSet`, cold-start discipline (fresh
state dir per run, never `--incremental`), Gate 3's `max(5%, 500 ms)` clock rule with its
retake cap, and A4-MAT-6's first-attempt retention.

#### The estimator, fixed before the data

**Primary statistic — a within-block ratio, so drift cancels by construction:**

```
ρ_X = median over blocks k=1..3 of  write_ms(X, T9, k) / write_ms(A, T9, k)
```

for `X ∈ {B, C, D}`. **Median of the three per-block ratios**, not a ratio of medians and not a
pooled ratio-of-sums. `write_ms` is the primary series because E1-PHASE measured it at 94.01%
of the clock at T9; `duration_ms` is reported alongside under the identical estimator and has
**no role in any decision** — it is there so a divergence between the two is visible rather
than hidden.

**`c` is neither measured nor used.** Every statistic here is a within-rung ratio or a
write-phase quantity, so the empty-corpus constant plays no part. It is not recorded, because
an unused measurement lying in an artifact is an invitation to post-hoc use.

**Three blocks is three numbers.** No CI, no HC3, no bootstrap is computed or reported for
`ρ`: at n=3 any interval would be decoration, and the E1-PHASE record already contains one
case (`b_edges`) where a printed interval invited an argument the registration had to refuse.
The **spread** (min, median, max of the three per-block ratios) is reported instead, and a
spread exceeding **0.15** on any arm is a **reported finding**, not a gate.

#### Hypotheses, thresholds and the outcome set — exhaustive, committed before the data

**Primary classification, on `ρ_B`:**

| `ρ_B` | outcome | what it licenses — and nothing more |
|---|---|---|
| ≤ 0.20 | **CACHE-DOMINANT** | the page cache accounts for ≥80% of write time at T9; the cache-cliff *class* is the leading mechanism at this rung |
| 0.20 < `ρ_B` ≤ 0.80 | **CACHE-PARTIAL** | materially involved; does **not** account for the bulk — other mechanisms carry the majority |
| > 0.80 | **CACHE-NOT-IMPLICATED** | a 64× enlargement buys <20% at the rung where write is 94% of the clock |

The same three-way table is applied to `ρ_C` with `MMAP-` prefixes, independently. **The bands
are graded on purpose**: write's excess over linear is ~94% of write time at T9, so a 20%
reduction retires ~21% of the excess. Without the bands, a `ρ_B` of 0.79 could be narrated as
"the cache cliff is confirmed", which it is not.

**The mechanism story is adjudicated on the pair `(ρ_B, ρ_D)`, and every cell is named:**

| | `ρ_D ≥ 1.10` (shrinking hurts) | `ρ_D < 1.10` (shrinking is free) |
|---|---|---|
| **`ρ_B` ≤ 0.80** | cache implicated per the ρ_B band; corroborated in both directions | **CACHE-ASYMMETRIC** — classification per the ρ_B band **stands**, and the asymmetry is a finding that must be explained before any fix is proposed |
| **`ρ_B` > 0.80** | **CACHE-SATURATED** — the lever demonstrably works, but 15.63 MiB is already past the benefit knee. The *default cache* is not the mechanism. | **CACHE-INERT** — a **512× range** (2 MiB → 1024 MiB) moves write by less than the bands. **The page-cache-cliff story is REFUTED at T9.** |

**CACHE-INERT is a positive result, not a null**, and arm D is what makes it one. Without a
positive control, "we enlarged the cache and nothing happened" is indistinguishable from "our
lever was not connected". With it, the claim becomes "we moved the lever 512× in both
directions and the clock did not care."

**The size-coupling discriminator — interpreted only when `ρ_B ≤ 0.80`:**

```
Δ = ρ_B(T1) − ρ_B(T9)
```

**SIZE-COUPLED iff `Δ ≥ 0.10`** — the enlargement helps at least 10 percentage points more at
26.8× the cache than at 1.32×. Otherwise **CONSTANT-FACTOR**: the arm is a speedup, not an
explanation of the exponent, and may not be reported as bearing on `b_write`. This is a
**conditional discriminator, not an independent hurdle**, and is counted as such below.

**Secondary, descriptive, no threshold:** the two-point write slope per arm,
`b̂_write(X) = ln(w9/w1) / ln(19.94)`. On E1-PHASE's control data this returns **1.961** against
the 5-rung fit's 1.9685, so the two-point form tracks the ladder — but **two points are not a
fit**, no interval exists for it, and no outcome above depends on it. It is reported to make
the arms mutually comparable in the units the program has been reasoning in, and for no other
purpose.

#### Direction-of-error statement (mandatory field)

**My prior now leans toward the cliff, and the reason is uncomfortable: I moved it there
myself, yesterday, by withdrawing the counter-evidence** (`CORRECTION (2026-08-13)`). §6 says a
result that flatters the thing you are testing deserves more scrutiny; the same applies to a
*correction* that flatters it. Four compensations, and I distinguish the real ones from the
decorative:

1. **Arm D is the substantive compensation.** It gives a refutation its own positive evidence,
   so an inert result is publishable rather than a reason to keep hunting for a better arm.
   Nothing else in the design does that work.
2. **Gate A (arm identity) cuts both ways.** A flag that silently failed to reach the
   connection would produce identical arms and a clean, credible-looking null — *or*, on a
   different failure, a spurious difference. The echo makes both visible.
3. **The graded bands** stop a small effect being narrated as vindication. That is a guard on
   *reporting*, not on measurement, and is worth less than (1).
4. **The within-block ratio and seed are fixed here**, so no aggregation or ordering choice
   remains open after the data arrives. This is table stakes, not a compensation.

**Condition counting, honestly.** The cache-cliff story has **exactly one substantively free
test: `ρ_B ≤ 0.80`.** `Δ ≥ 0.10` is conditional on it and only sub-classifies. `ρ_D ≥ 1.10` is
an instrument check that does not test the hypothesis — it decides whether a *refutation* is
informative. Anyone reading three thresholds as three hurdles is over-counting, which is the
error the E1-PHASE registration had to correct in itself before running.

**A prior that runs the other way, recorded now so it cannot be claimed later.** T9's database
is 418.8 MiB on a machine with far more RAM than that, so the OS page cache plausibly holds the
entire file already; a SQLite cache miss may then be a `memcpy` from the OS cache rather than a
disk read. If so, **arm B should do very little**, and the honest expectation for this
experiment is closer to CACHE-INERT than to CACHE-DOMINANT. Arm C exists partly because it
addresses that regime directly: mmap removes the `pread` syscall and copy that a warm-OS-cache
miss still pays.

**One consequence I do not control and will not pretend to.** `wal_autocheckpoint` stays at its
default (1000 pages ≈ 4 MiB) in every arm. Cache size and checkpoint scheduling interact, so
"arm B" is strictly "arm B *at the default checkpoint policy*". It is held constant, not
isolated.

#### Gates

- **Gate 0 — binary identity.** `dist` content hash + `schema_version` recorded pre-run and
  re-asserted at every start and restart; all 24 runs assert one hash. **The hash HAS moved**:
  `2127ef7` added `OpenDatabaseOptions` and the two CLI flags, so this experiment runs on a
  different binary than E1-PHASE's 15-run ladder. **Registered consequence: no absolute timing
  here is comparable to the ladder's, and nobody may read across the two.** Both arms sharing
  one binary is what keeps the A/B internally valid; the control arm is **re-measured on this
  binary** and E1-PHASE's T9 write times are not reused as a control.
- **Gate 1 — corpus integrity.** `assertCorpusPinned('n8n')` per run; each run's `SELECT path
  FROM files` equals the frozen manifest's file set for its tier, exactly.
- **Gate A (new) — arm identity.** Every run's `pragmas:` line must equal its arm's declared
  pair in the table above, **exactly**. A mismatch **VOIDs the run**. This is the gate that
  makes each run self-describing about which arm produced it; it is the direct analogue of
  Gate 0's content hash, at the level of the lever rather than the binary.
  **Its limit, stated rather than glossed:** the echo proves the pragma was *configured on the
  connection SQLite reported it from*. It does not prove SQLite's pager honoured it internally.
  The only available cross-check on that is behavioural — if **no** arm moves the clock, a
  disconnected lever cannot be fully excluded, and CACHE-INERT is reported with that caveat
  attached rather than as a clean refutation.
- **Gate 3 — clock agreement.** `max(5%, 500 ms)`, retakes capped at 2 then logged, orphaned
  attempts charged against the cap (A4-MAT-3), A4-MAT-6 first-attempt retention. Retentions
  are reconciled (`attempt_start` records vs completed attempts) and the direction of any
  retained bias is stated in the RESULT, as E1-PHASE's was.
- **Gate P — attribution.** `Σ phase_ms ≥ 0.95 × durationMs` on the **fitted** attempt.
  Inherited unchanged; E1-PHASE measured 99.85–100.00% across 15 runs, so the floor is
  ~5 points of real headroom rather than a guess.
- **Gate P2 — work identity, strengthened.** All **twelve** runs at a rung (4 arms × 3 blocks)
  must report an identical `chunk_count`, not merely the three reps of one arm. This is the
  gate that proves the arms did the *same work* and differ only in configuration. Disagreement
  voids the rung.
- **Gate 5 — instrument committed before any scored run.** And this time literally: **commit,
  then launch.** E1-PHASE's margin was 24 seconds with part of its calibration running
  pre-commit (RR3); that is disclosed there and is not repeated here.

**Database size across arms is a reported FINDING, not a gate.** Final `graph.db` bytes are
recorded for every run and compared across arms at each rung. It is *not* a gate because the
run-to-run determinism of that number has not been measured, and Gate P's precedent (re-anchored
on three real T1 runs rather than a smoke test) is that a threshold with no measurement behind
it does not belong in this program.

#### Falsification criteria

- **The cache-cliff mechanism story is REFUTED at T9** iff `ρ_B > 0.80` **and** `ρ_D < 1.10`
  (CACHE-INERT).
- **It is refuted specifically as a story about the DEFAULT** iff `ρ_B > 0.80` and
  `ρ_D ≥ 1.10` (CACHE-SATURATED): the cache matters, and 15.63 MiB is already enough.
- **It is refuted as an explanation of the EXPONENT**, even when `ρ_B ≤ 0.80`, iff
  `Δ < 0.10` (CONSTANT-FACTOR).
- **The mmap story is refuted** iff `ρ_C > 0.80`.
- **The whole instrument is VOID** if Gate A fails on any scored run that cannot be re-run
  clean, if Gate P2 disagrees within a rung, or if any run's `write_ms ≤ 0`.
- **If every arm is inert** (`|ρ_X − 1| < 0.10` for all of B, C, D), the result is reported as
  **CACHE-INERT with the Gate A limit attached** — see above — and the next step is *not*
  another pragma arm: it is statement-level or `sqlite3_stmt_scanstatus` profiling inside the
  write phase. Registered now so an all-inert outcome is not quietly re-analysed.

#### Instrument — to be built and committed before any scored run (Gate 5)

| file | role |
|---|---|
| `eval/e1-ab-schedule.mjs` | arms, rungs, blocks, the seed-4409 within-block shuffle, Gate A's expectation table, state-dir namespacing |
| `eval/e1-ab-score.mjs` | within-block ratios, the ρ bands, the 2×2 outcome cells, Δ, the descriptive two-point slope |
| `eval/e1-ab-run.mjs` | the 24-run driver — resumable, journalled, **with a working VOID dequeue** |
| `eval/e1-ab-report.mjs` | the journal→scorer seam |

**Two inherited defects must be dealt with, because HANDOFF §5 forbids reusing an instrument
without fixing its defects:**

1. **The VOID queue has no dequeue** (RR6). A void that is later re-run clean stays in
   `loadJournal`'s map, pinning `scoreable` false forever. Unexercised in E1-PHASE (0 voids),
   but Gate A makes a void *plausible* here, so the new driver implements the dequeue and a
   test exercises void → re-run → `scoreable: true`.
2. **`fitSeries` reports spurious precision on quantized series** (RR4). **Does not apply** —
   this instrument computes no OLS fit. The one slope it reports is a two-point ratio,
   explicitly labelled descriptive, over values of 1.4 s and 500 s where millisecond
   quantization is ~0.0002%.

**`eval/e1-common.mjs` is touched, and the change is additive.** `runColdIndex` needs to pass
the two flags and parse the `pragmas:` line. It gains an optional extra-args parameter
defaulting to none, plus a `parsePragmas` export. **E1's and E1-PHASE's call paths must be
byte-for-byte unchanged in behaviour**, pinned by a test that calls it with no extra args and
asserts the argv it builds. Neither E1's nor E1-PHASE's scored records are re-scored, re-fitted,
or touched in any way.

#### Declared prior exposure (P0 precedent)

Three things were seen before this registration was written, and none of them tuned a threshold:

1. **E1-PHASE's T9 control write times** (500,885 / 497,485 / 504,941 ms) are published data on
   the **previous** binary. Every statistic here is a ratio against a control **re-measured on
   this binary**, so the old absolutes cannot enter. They did inform the ~8.9 min/run cost
   estimate and hence the block count.
2. **T1 and T9 `graph.db` sizes**, measured today from retained artifacts. These *did* set arm
   B's size, via the pre-stated rule "≥2× T9's database". That is a design input chosen from a
   size, not a threshold chosen from a timing.
3. **A `pragmas:` smoke run** on a one-file corpus while building the lever, which printed
   `{"cache_size":-65536,"mmap_size":268435456}`. It produced no tier timing.

No T1 or T9 timing on the current binary has been observed by anyone at the time of this
commit.

#### Costs

24 runs. 12 at T9 (~8.9 min each on the previous binary) and 12 at T1 (~2.7 s each):
**~2 hours** if the arms are neutral, and materially longer if arm D is slow — a 2× arm-D
penalty adds ~27 min. Peak transient disk is one T9 state dir at a time (~420 MiB), wiped per
run. **Machine must be otherwise idle**, as for E1 and E1-PHASE.

#### Design Reserve (pre-thought, NOT commitments)

Recorded so that if any of these is later promoted, the promotion is visible as a change of
plan rather than as improvisation:

- **A 1 MiB cache arm**, if arm D at 2 MiB proves inert — a stronger positive control.
- **A combined arm** (large cache + mmap). Deliberately excluded: it is fix-shaped, and this
  is a probe.
- **An FTS5 arm** — building the trigram index in a second pass, or `'rebuild'` after bulk
  insert — to attack the mechanism candidate this experiment cannot touch. That is a different
  instrument and would need its own registration.
- **`wal_autocheckpoint` as an arm.** Named because it is the interaction this design holds
  constant rather than isolates.

#### What is deliberately NOT done

No pragma is set in product code, in either direction, on the strength of this. `MAST_SPEC`
documentation of `--cache-size-mib` / `--mmap-size-mib` (and of the still-undocumented
`--phase-timing` / `ENABLE_MAST_PHASE_TIMING`) is a separate, non-measurement item and is not
folded in here. E1-PHASE is not re-run and E1 is not re-scored.

#### AMENDMENT 1 — 2026-08-13, pre-run, post-adversarial-review

The registration above was committed at `315272d` **before** the review was commissioned, so
everything here is provably a response to it rather than absorbed into the original text. Per
§6 and the standing rule that this reviewer has been wrong before, **every load-bearing claim
was verified against source or recomputed before being accepted**. One was rejected on
verification; one was accepted but its severity corrected; and one recommendation was accepted
in its diagnosis and **replaced with a better remedy**, which is recorded as such rather than
passed off as the reviewer's.

**No threshold from the original registration is loosened. One is deleted as degenerate and
replaced by a stricter one; the rest are additions.**

##### A1 — arm C is structurally incapable of reaching the mechanism. VERIFIED at source; arm demoted.

The review's blocking finding reproduces exactly. In `sqlite3.c` (SQLite 3.53.2, vendored):

```c
const int bMmapOk = (pgno>1
 && (pPager->eState==PAGER_READER || (flags & PAGER_GET_READONLY))
);                                                        /* :65261–65263 */
```

and in `btreeCursor`, a **write** cursor gets `pCur->curPagerFlags = 0` (`:77886`) while only a
read-only cursor gets `PAGER_GET_READONLY` (`:77889`). Inside an open write transaction
`eState` is a WRITER state, so **page fetches made through write cursors — which is exactly the
11 indices' B-tree insertion traversals, the hypothesised miss source — can never be served
from the memory map.** A third gate compounds it: `if( bMmapOk && iFrame==0 )` (`:65286`) skips
mmap for any page still resident in the WAL, and a bulk load with 4 MiB autocheckpoints always
has a rolling set of hot pages there.

So `ρ_C ≈ 1` is close to predetermined, and the original registration's claim that arm C
"isolates the read-path syscall/copy cost" of index-maintenance misses is **wrong**. Worse, arm
C was named as the mitigation for the OS-page-cache counter-prior; that mitigation was hollow.

**Change:** arm C is **removed from T1 and T9** and **retained at T5 only** (3 runs, ~90 s).
It is re-registered as what it actually is: **a source-contradiction tripwire, not a mechanism
arm.** Its registered reading is stated in advance and is asymmetric on purpose —

- `ρ_C(T5) > 0.80` — **expected**, predicted by the source reading above. It is **weak
  evidence** and may not be reported as "the mmap story is refuted by measurement"; the
  refutation is analytic, from `:65261` and `:77886`, and the run merely fails to contradict it.
- `ρ_C(T5) ≤ 0.80` — **contradicts the source reading**, is a finding in its own right, and
  triggers a dedicated probe rather than any conclusion here.

Keeping it at the cheap rung preserves an empirical datum against the registered discriminator
that E1-PHASE named ("a `cache_size` / `mmap_size` A/B") for ~1.5 minutes of machine time,
rather than narrowing that discriminator purely on my own reading of a 250k-line amalgamation.
Spending 27 minutes at T9 for a structurally foreordained null is what is refused.

*One reviewer sub-claim died under its own verification and is recorded because it strengthens
Gate A:* a **runtime** mmap failure is not invisible to Gate A. `unixMapfile` sets
`pFd->mmapSizeMax = 0` on `MAP_FAILED` (`:45838–45843`) and `PRAGMA mmap_size` reads back
through that field, so the echo would print `0`, mismatch arm C's expectation, and VOID. Gate A
is blind to the *structural* gating above — but that is not a failure mode, it is physics.

##### A2 — Δ is withdrawn as degenerate. The per-arm slope replaces it, and the replacement is not the one recommended.

**The diagnosis is accepted and verified.** Every candidate mechanism predicts `ρ_B(T1) ≈ 1`,
because T1's database is only 1.32× the default cache and there is almost no miss cost there
for a larger cache to remove. So `Δ = ρ_B(T1) − ρ_B(T9) ≈ 1 − ρ_B(T9)`, and the gate
"`Δ ≥ 0.10` given `ρ_B(T9) ≤ 0.80`" reduces to "`≥ 0.20 − ε ≥ 0.10`" — **SIZE-COUPLED fires
almost automatically whenever it is consulted at all.** The label that flatters the exponent
story was the near-automatic one, and the direction-of-error statement did not name it. That is
the same unregistered-lever-shaped bias this program has now been caught by four times.
Independently: T1's write spread across E1-PHASE's reps is **8.63%** (1,414 / 1,452 / 1,536 ms),
so Δ's T1 leg sits at roughly 2σ of its own noise.

**`Δ` is deleted as a decision statistic.** It is reported descriptively and adjudicates nothing.

**The replacement, and why it is not the reviewer's.** The review recommended adding a middle
rung and deciding on a three-point slope. The middle rung is adopted (A3) — but *not for that
reason*, because the recommendation rests on an arithmetic error of omission. In a three-point
OLS with evenly spaced `ln N`, **the midpoint carries 0.09% of the slope's leverage** against
33.5% at each endpoint (computed on this ladder's actual chunk counts). On E1-PHASE's control
data the three-point slope is **1.9613** against the two-point slope's **1.9614** — identical to
four decimals. Adding T5 buys **no slope precision at all**, and a registration claiming
otherwise would be making a promise the arithmetic does not keep.

**What actually makes the slope a clean size-coupling test is simpler, and it was already in the
design.** A constant-factor speedup multiplies write time by a fixed `ρ` at every rung, which
shifts the intercept of `ln(write) ~ ln(chunks)` and **leaves the slope exactly unchanged**. The
slope moves *if and only if* `ρ` varies with `N`. So the per-arm slope is non-degenerate by
construction, and needs no second statistic beside it. It is hereby **promoted from "descriptive,
no outcome depends on it" to the registered exponent test**:

| `b̂_write(B)` | outcome | licenses |
|---|---|---|
| < **1.35** | **EXPONENT-EXPLAINED** | the enlarged cache removes the super-linearity *by this program's own standing definition* — 1.35 is E1's pre-registered, immutable threshold, not a number invented here |
| 1.35 ≤ `b̂_write(B)` ≤ `b̂_write(A) − 0.20` | **EXPONENT-REDUCED** | materially flattens the growth; write remains super-linear |
| > `b̂_write(A) − 0.20` | **EXPONENT-UNTOUCHED** | whatever the level effect, the cache does not explain the exponent |

**Slopes are computed within each block** (3 per arm), and the **median of the three** is the
statistic; the spread of the three is reported, and a spread above 0.20 is a finding. Computing
within-block preserves the drift cancellation that the ratio estimator was chosen for.

**The 0.20 bar's power, computed rather than asserted.** Propagating E1-PHASE's own within-rung
spreads (T1 8.63%, T9 1.50%) through the endpoint leverages, with a median of three, gives a
slope σ of **≈0.0085**. The bar is therefore ~20σ. It is left deliberately far above σ because
that σ is estimated from *within-session* repetitions and this schedule runs ~90 minutes; I
would rather the test be blunt than have a marginal call decided by a noise model I have not
validated across blocks.

**A number the level test alone cannot deliver, and the reason this promotion matters.** At
`ρ_B(T9) = 0.20` — the CACHE-DOMINANT *floor* — arm B's write at T9 is ~100 s against a
linear extrapolation from T1 of ~28 s, a two-point slope of **1.424**. Still super-linear. So
even the strongest level result the registration can report would **not** have licensed "the
cache explains the exponent", and without this amendment there was no registered statistic that
could have refused that reading.

##### A3 — T5 is added for arms A, B, D. What it actually buys, stated honestly.

Not slope precision (A2). It buys two things:

1. **A dose–response curve on the cache multiple.** T5's `graph.db` is **95,203,328 B = 90.8 MiB
   = 5.81×** the 15.63 MiB cache, against T1's 1.32× and T9's 26.8×. `ρ_B` measured at three
   multiples spanning 20× says *where the effect turns on*, which is the size-coupling evidence
   Δ was supposed to provide and could not.
2. **A curvature reading.** E1-PHASE found write is itself a mixture. On the control's three
   rungs the split halves are **`b_lo` = 1.8770** (T1→T5) and **`b_hi` = 2.0465** (T5→T9). Both
   are reported per arm. **A cache cliff should flatten `b_hi` specifically** — the half where
   the database most exceeds the cache. `b_hi(B) < b_hi(A) − 0.20` is registered as a
   **corroborating** reading of EXPONENT-REDUCED/EXPLAINED; it is not an independent hurdle and
   does not gate any outcome.

Cost: 9 runs at ~30 s ≈ **4.5 minutes**.

##### A4 — arm D's lever-connectivity check moves to T1, where it has power. VERIFIED arithmetic.

The review's computation reproduces. Under a uniform-access model at T9 (107,212 pages), a
15.63 MiB cache holds 3.73% and a 2 MiB cache holds 0.47%, so **miss volume rises only 1.034×**
— even if misses were 100% of write's excess, `ρ_D(T9) ≈ 1.03`, below its own 1.10 bar and
inside noise. Presenting `ρ_D(T9) ≥ 1.10` as a general proof that the lever is connected was
wrong.

At **T1** (5,266 pages) the same model gives 76.0% vs 9.5% residency and a **3.76×** rise in
miss volume. Those three runs are already in the schedule and no registered statistic read them.

**Change:** **`ρ_D(T1) ≥ 1.10` is the lever-connectivity check.** `ρ_D(T9)` is demoted to a
working-set probe and reported without a threshold. The 2×2 outcome table's `ρ_D` axis is
re-keyed to **`ρ_D(T1)`**; every cell's wording is otherwise unchanged.

Note the model's own limit: uniform access is the *wrong* model for B-tree maintenance, where
interior nodes are hot. It is used here only to establish which rung has power, and that
conclusion is robust to the model — T1's cache holds most of the file and T9's holds almost
none of it under any access pattern.

##### A5 — three holes in the outcome set, patched. VERIFIED against the registration's own text.

The set claimed exhaustiveness and did not have it:

- **`ρ_X > 1.10` on any arm (the lever makes things WORSE)** fell into the `ρ_B > 0.80` row and
  would have been labelled CACHE-SATURATED or CACHE-INERT, both false. **Now: INTERFERENCE —
  reported, no mechanism cell claimed, and the RESULT must offer or refuse an explanation.**
- **`ρ_D ≤ 0.90` (shrinking the cache HELPS)** was filed as "shrinking is free", which it is
  not. **Now: reported anomaly; the CACHE-INERT cell may not be claimed while it holds.**
- **The all-inert clause used `|ρ_X − 1| < 0.10`, a third partition inconsistent with the 2×2.**
  `(ρ_B = 0.85, ρ_D = 1.05)` is CACHE-INERT by the cells but not "all inert" by the clause, so
  which caveat attached was ambiguous. **Now restated in the table's own terms: the Gate A
  limit attaches whenever the outcome is CACHE-INERT *and* `ρ_C(T5) > 0.80`** — i.e. when no
  arm anywhere moved the clock.

A fourth hole the review raised — a joint `(CACHE-INERT, MMAP-DOMINANT)` contradiction — is
dissolved rather than patched: under A1 arm C no longer produces a mechanism cell at all.

##### A6 — a VOID re-run breaks the pairing the primary estimator depends on. Rule registered.

The within-block ratio is justified by drift cancellation, which assumes the arm run and its
control run are temporally adjacent. A run VOIDed by Gate A/P/P2 and re-run later — possibly
after the whole schedule — silently violates that for exactly the runs the dequeue exists to
save. E1-PHASE's fits were pairing-free, so RR6's dequeue was bookkeeping; **here the pairing
is the estimator**, and the registration did not say which control a re-run pairs with.

**Rule:** a VOIDed cell is re-run **together with a fresh control run of the same rung**, and
that pair replaces the block's ratio. If the fresh control itself fails a gate, **the block's
ratio is dropped and the median is taken over the remaining blocks**, with the drop recorded as
a finding. A median over fewer than two blocks is a VOID of that arm.

**The journal records the block index and a monotonic run sequence number on every run** — the
registration assumed this and never said it.

##### A7 — Gate A's read-back coalesces a failed evidence read into a passing value. Fix registered; the review's severity corrected.

`src/indexer/index.ts` (from `2127ef7`):

```ts
cache_size: (await sql`PRAGMA cache_size`.execute(db)).rows[0]?.cache_size ?? 0,
mmap_size:  (await sql`PRAGMA mmap_size`.execute(db)).rows[0]?.mmap_size ?? 0,
```

**Accepted:** in an instrument whose stated role is "the direct analogue of Gate 0's content
hash", a failed evidence read must **throw**, not fall back to a value. `?? 0` reports
`mmap_size: 0`, which is the *expected* value for every retained arm.

**Severity corrected, because the review overstated it.** It claimed this "would pass Gate A on
3 of 4 arms". If the read-back returns no rows the `cache_size` read coalesces to `0` as well,
and `0` matches **no** arm's expectation (`-16000` / `-1048576` / `-2048`), so Gate A VOIDs. The
hole is narrower than claimed: it requires the `mmap_size` read alone to fail while
`cache_size` succeeds. The fix is adopted anyway — the principle does not depend on how narrow
the hole is — as a **red-first** change: a test that forces an empty read-back and asserts a
throw, before the `??` is removed.

##### A8 — `cache_spill` makes any arm-D penalty mechanistically ambiguous. Caveat registered.

VERIFIED: the spill threshold tracks the cache size (`sqlite3.c:57599`, `p->szSpill = mxPage`,
with the `res < p->szSpill` clamp at `:57602`). At 2 MiB (500 pages) a per-file transaction that
dirties more than ~500 pages spills to the WAL mid-transaction. **A `ρ_D ≥ 1.10` result
therefore mixes read-miss cost with spill mechanics and may not be reported as "read-path misses
corroborated".** Both are cache-size mechanisms, so arm D's role in the outcome table survives;
only the narration is constrained.

##### A9 — ordering, strengthened at zero cost.

A seeded shuffle of a block gives no positional balance: an arm can land in the thermally-hot
tail of two blocks out of three. With arm C removed from T9 (A1), the T9 cells are exactly
**3 arms × 3 blocks — a 3×3 Latin square**, which guarantees each arm occupies each position
exactly once. **T9 ordering is the Latin square**; T1 and T5 (2.7 s and 30 s per run) keep the
seed-4409 shuffle, where drift is not a credible confound.

##### A10 — a review claim REJECTED after verification, recorded so it cannot recirculate

The review states that `stdout_tail` will "now drop the `files:` line once `pragmas:` prints".
**False.** `eval/e1-common.mjs:329` is `stdout.trim().split('\n').slice(-3)`, and a phase-timed
run emits exactly three lines (`files:`, `phases:`, `pragmas:`), so all three are retained. This
was also confirmed empirically last session against the real `dist` binary. Nothing is dropped.

Two review nits are accepted as accurate but left unfixed, with reasons: `parseMebibytes` uses
`Number()`, so `0x10` and `1e3` pass the whole-number gate — no arm uses either form, and
tightening the parser is a product change with no bearing on this experiment; and
`--cache-size-mib 0` yields `PRAGMA cache_size = -0`, an untested edge no arm uses.

##### Revised design, superseding the corresponding rows above

| | registered `315272d` | **as amended** |
|---|---|---|
| arms | A, B, C, D at both rungs | **A, B, D** at all rungs; **C at T5 only** |
| rungs | T1, T9 | **T1, T5, T9** |
| runs | 24 | **30** (27 + 3 for arm C) |
| cache multiples probed | 1.32×, 26.8× | **1.32×, 5.81×, 26.8×** |
| exponent test | `Δ ≥ 0.10` (degenerate) | **`b̂_write(B)` vs 1.35 and vs `b̂_write(A) − 0.20`** |
| connectivity check | `ρ_D(T9) ≥ 1.10` (no power) | **`ρ_D(T1) ≥ 1.10`** |
| T9 ordering | seeded shuffle | **3×3 Latin square** |
| machine time | ~2 h | **~87 min** (80 min T9 + 6 min T5 + 0.4 min T1) |

The amended design is **cheaper and answers more**: dropping arm C's two expensive rungs frees
~27 minutes, of which ~4.5 buys the middle rung.

Gate P2 (work identity) now requires identical `chunk_count` across **all runs at a rung** — 9
at T1 and T9, 12 at T5.

##### Direction of error, revisited against the review

The review's audit — that two of four claimed compensations were real, and that the two genuine
leaks were Δ's auto-fire and the inevitable post-hoc promotion of a "descriptive" slope — is
**accepted, and both leaks are now closed by the same change** (A2): the slope is promoted with
a threshold *before* the data, and Δ is deleted rather than demoted, so there is no degenerate
statistic left to reach for.

**What remains uncompensated, stated plainly.** Arm D is a real positive control at T1 and a
weak one at T9 (A4), so a CACHE-INERT verdict rests on a connectivity proof taken at the rung
where the mechanism is *least* likely to be operating. That is the best available design at
this cost, and it is a genuine limit rather than one I can argue away. The RESULT must carry it.

#### AMENDMENT 2 — 2026-08-13, pre-run, found while building the instrument

One change, and it TIGHTENS a rule rather than relaxing one. Found by a test that failed
against `planPending` and turned out to be wrong about the registration rather than about the
code.

**AMENDMENT 1 A6 has a gap: the control run is SHARED.** A6 says a VOIDed cell is re-run
"together with a fresh control run of the same rung, and that pair replaces the block's ratio".
But one control run at a `(tier, block)` is the denominator for **every** arm in that block.
Superseding it to repair one arm silently re-pairs the *untouched* arms against a control
measured at a different time — reintroducing, for them, exactly the drift the repair existed to
remove. A6 as written fixes one ratio by quietly breaking the others.

**Corrected rule: an unresolved VOID at `(tier, block)` re-runs that whole block-pair group** —
the control and every arm at that rung — control first, so each pair is measured adjacently.
This holds A6's actual guarantee (every ratio is a temporally adjacent pair) for every arm
rather than for one. It applies symmetrically when the *control* is the cell that voided.

**Cost:** one extra run per repair at the affected rung — ~9 minutes at T9, seconds at T1/T5.
Zero if nothing voids, which is the expected case.

**Direction of error:** none available. This changes which runs are *collected* after a gate
failure, never which runs are *kept* or how any statistic is computed, and it cannot be steered
toward an outcome because a VOID is not under the investigator's control. Recorded anyway,
because the program's rule is that a deviation from registered text is disclosed rather than
absorbed.

#### AMENDMENT 3 — 2026-08-13, mid-run, DATA-INFORMED — positional balance at T1 and T5

**This amendment was made after seeing data, and every run collected under the previous design
is discarded unscored.** That is the condition under which it is legitimate, and it is stated
first so no reader has to look for it. Seven runs existed when this was written — all of block
1's T1 and T5 cells, all Gate A clean. **None of them enter the score.** The schedule restarts
from zero.

**What was wrong.** AMENDMENT 1 A9 gave T9 a Latin square and left T1 and T5 on a seeded
shuffle, reasoning that "at 2.7 s and 30 s per run, ordering is not a credible confound there".
That rationale addresses **drift** — a slow trend across an ~80-minute stretch. It does not
address **warm-up**: the OS page cache over the tier's 13,330 source files is cold for the first
run at a rung and warm for the rest, and that asymmetry is fully present inside a 30-second
window. A9's argument is sound about the thing it names and silent about the thing that bites.

The seeded shuffle then happened to produce a schedule with almost no positional variance:

```
T1 b1 D A B   b2 D A B   b3 B D A     A:2,2,3  B:3,3,1  D:1,1,2
T5 b1 A C B D b2 D C A B b3 D C A B   A:1,3,3  B:3,4,4  C:2,2,2  D:4,1,1
T9 b1 A B D   b2 B D A   b3 D A B     A:1,3,2  B:2,1,3  D:3,2,1   (balanced)
```

**Arm C holds position 2 in all three blocks.** Arm B is third or fourth in all three.

**Why that is disqualifying rather than untidy.** Arm C is the source-contradiction tripwire
registered in AMENDMENT 1 A1: the source reading says mmap cannot serve write-cursor page
fetches, so arm C must be inert, and a non-inert ρ_C is "a finding in its own right". With C
nailed to one position for every block, a positional effect and the arm-C effect are **perfectly
collinear** — there is no contrast in the design that separates them. A ρ_C of 0.67 would be
unreadable: it would be equally consistent with "the source reading is wrong" and with "position
2 is fast". The tripwire would fire and carry no information. A covariate cannot rescue this;
zero variance means there is nothing to regress against.

**The correction.** T1 and T5 get cyclic Latin squares, the same construction A9 already
registered for T9. T9's ordering is **unchanged**.

- **T1** (3 arms, 3 blocks) balances exactly — each arm holds each position once. Its square is
  **rotated by one relative to T9's** so that an arm's position at T1 is not perfectly correlated
  with its position at T9 within the same block. Without the rotation, a position effect whose
  *magnitude* differs by rung (a cold-cache penalty is larger at T9 than at T1) would fail to
  cancel in the block slope; a constant multiplicative factor cancels in a log-log slope exactly,
  a rung-varying one does not.
- **T5** (4 arms, 3 blocks) **cannot** be balanced exactly, and the reason is arithmetic, not
  effort: the position-sum over 3 blocks is 3·(1+2+3+4) = 30 across 4 arms, so the mean is 7.5
  and no integer assignment reaches it. Further, if every arm is required to hold three
  *distinct* positions, the only available sums are 1+2+3=6, 1+2+4=7, 1+3+4=8 and 2+3+4=9 — so
  the multiset {6,7,8,9} is **forced** for any all-distinct design. The cyclic square attains it
  and is therefore optimal in its class. Residual imbalance is ±1.5 around the mean and, unlike
  the shuffle's, is not concentrated on one arm.

**What this does NOT change.** No threshold, no estimator, no gate, no arm definition, no rung,
no block count, and not T9's order. `e1-ab-score.mjs` is untouched. This changes only the order
in which cells are visited within a block.

**Direction of error.** Balancing removes a confound; it does not push ρ toward or away from any
registered cut. The one honest statement available: under the discarded design, arm B and arm C
both sat in the early-middle positions and the control sat first in the one block that ran, so
if warm-up is real the discarded data would have **flattered** arms B and C — i.e. it would have
made the page-cache lever look more effective than it is. The corrected design should therefore
be expected to produce ρ_B and ρ_C **closer to 1.0**, not further from it. That prediction is
registered here so the re-run can falsify it.

**What is NOT claimed.** That the positional effect is real. It is not demonstrated: block 1's
T5 showed position 1 slow (24.5 s), positions 2–3 fast (16.5 s), and position 4 slow again
(25.7 s), which pure warm-up does not predict — though position 4 was arm D, the starved-cache
arm, where slowness is hypothesis-consistent. n=1 and ambiguous. The justification for this
amendment is **not** that the effect exists; it is that if it exists and the design is
unbalanced, it is unfixable after the fact, while the remedy costs ~2 minutes because every
discarded run is at a cheap rung.

**Cost:** re-running 7 T1/T5 cells, ≈2 minutes of the 87-minute schedule.

---

#### E1-AB RESULT — 2026-08-13, scored, post-adversarial-review

**E1-AB is a probe.** It cannot confirm, overturn or soften E1's SUPER-LINEAR verdict, and it
cannot re-adjudicate E1-PHASE: H1 (write-localised, mechanism unidentified) stands. No pragma
is shipped on the strength of it. That framing is carried from the registration verbatim and is
not weakened by anything below.

**What ran.** 30/30 registered runs, 0 voids, 0 driver findings, `scoreable: true`. Every run
passed **Gate A** with the correct per-arm pragma echo. **Gate P2** is identical within every
rung — T1 3,679 chunks (9 runs), T5 16,529 (12), T9 73,359 (9) — and those counts come from
`readGraphCounts`'s `SELECT COUNT(*)` against `graph.db` (`eval/e1-common.mjs:493`), **not** the
pre-write stdout counter, so the Q1/SCALE trap does not apply to them. `db_bytes` is
byte-identical across arms at every rung. Every number in `eval/results/e1-ab-verdict.json`
reproduces from the raw journal to four decimals; the adversarial reviewer recomputed them
independently and so did the author.

**The registered outcome, as the scorer returned it.**

| statistic | value |
|---|---|
| `MECHANISM` | **CACHE_IMPLICATED**, level **PARTIAL** |
| `EXPONENT` | **EXPONENT_REDUCED** |
| `rho_B(T9)` | 0.5132 |
| `rho_D(T1)` | 1.2123 (lever-connectivity, A4) |
| `rho_C(T5)` | 0.6921 — fires A1's source-contradiction tripwire |

Within-block write-phase ratios (median of three blocks):

| arm | T1 | T5 | T9 |
|---|---|---|---|
| B (cache 1024 MiB) | 0.9774 | 0.6871 | 0.5132 |
| D (cache 2 MiB) | 1.2123 | 1.0085 | **0.8486** |
| C (mmap 1024 MiB) | — | 0.6921 | — |

Per-block write slopes and their split halves (medians):

| arm | b_write | spread | b_lo (T1→T5) | b_hi (T5→T9) |
|---|---|---|---|---|
| A (control) | 1.9331 | 0.0546 | 1.7629 | 2.1197 |
| B | 1.7127 | 0.0224 | 1.5218 | **1.8965** |
| D | 1.8243 | 0.1236 | 1.6557 | 1.9947 |

---

##### The four published claims, as corrected by the adversarial review

**Claim 1 — WEAKENED. Not a page-cache residency signature; a cache-size-coupled pager
mechanism with the channel unresolved.**

`rho_B` rises monotonically with the cache multiple — 0.9774 at 1.32×, 0.6871 at 5.81×, 0.5132
at 26.8× — and that dose–response is exactly what A3 added T5 to obtain. But the residency
reading it invites is refuted by the arm in the same experiment: `rho_D(T9) = 0.8486` means the
T9 response to cache size is **non-monotone**, with the *default* 15.63 MiB cache the slowest of
the three sizes tested. A residency model cannot produce that, and A4's own power arithmetic
predicted `rho_D(T9) ≈ 1.03`.

Two escapes were tested and both fail. "A 2 MiB cache frees RAM for the OS unified buffer cache"
is quantitatively dead: the A−D footprint difference is ≤13.6 MiB on a 16 GiB machine. "A 1 GiB
cache causes memory pressure" is contradicted by B being the *fastest* arm at every rung.

The registered reading is therefore: **the write-phase cost is coupled to SQLite's cache-size
setting, and the channel is unresolved between read-miss volume and spill/eviction policy.**
A8's spill caveat was written for arm D and applies symmetrically to arm B: at 1 GiB, mid-
transaction spill is structurally impossible, so arm B changes *two* things at once, not one.
The instrument carries no WAL, spill or RSS counters, so **this data cannot discriminate the two
channels.** Stated as a limit, not as a hedge.

**Claim 2 — STANDS. The cache does not explain the super-linearity.** This is the strongest
result in the experiment. With eviction physically impossible — arm B's 1 GiB cache is 2.45× the
entire T9 database — the write slope is still 1.7127, and the top segment `b_hi(B) = 1.8965`
remains near-quadratic. Removing eviction entirely removes roughly a fifth of the excess
exponent.

The category-error concern about comparing a three-rung write-phase slope to E1's nine-rung
duration threshold of 1.35 is real and was checked rather than waved off. On E1's *own*
estimand — OLS of `ln(duration_ms)` on `ln(chunk_count)`, median of three blocks — the control
recomputes to **1.7625**, reproducing E1's `b = 1.7529` to 0.01, and arm B recomputes to
**1.5498**, still 0.20 above the threshold. The comparison survives on a like-for-like basis.
Both cross-checks are published here so the claim does not rest on the write-phase basis alone.

**Claim 3 — STRENGTHENED, and it is the most interesting number in the run.** `rho_D(T9) =
0.8486` carries **no registered flag**: A4 demoted `rho_D(T9)` to an unthresholded working-set
probe, and the scorer accordingly keys `D_HELPS_ANOMALY` to T1 only (`eval/e1-ab-score.mjs:224`),
where D correctly hurts at 1.2123. So the verdict JSON reads `findings: []` while the single
most model-breaking observation sits in the level table unflagged. **That is a gap in the
registered rule set, recorded here rather than repaired retroactively.** A5's INTERFERENCE text
says "any arm", which collides with D's positive-control role; the scorer's B-only reading is a
post-hoc resolution and is recorded as such.

**Claim 4 — WITHDRAWN AS DRAFTED. The AMENDMENT 3 prediction was satisfied, not falsified.**
The author's first write-up said the prediction "was not confirmed". That is wrong in direction.
Comparing block 1 to block 1 against the quarantined runs, every comparable statistic moved
**toward** 1.0 exactly as registered: `rho_C` 0.6720 → 0.6921, `rho_B(T5)` 0.6710 → 0.6871,
`rho_B(T1)` 0.9279 → 0.9774. The honest statement is that the prediction was **directionally
satisfied and quantitatively empty** — every move is ≤0.05, inside the blocks' own spread
(B/T1 spread 0.079, B/T5 0.066), so it was too weak to adjudicate the positional question it was
registered to test. A prediction that cannot fail at the effect size available is not a risk.

---

##### The mmap tripwire resolves — and re-points the mechanism

`rho_C(T5) = 0.6921` against `rho_B(T5) = 0.6871`. The two arms land on top of each other.

A1 argued from source that mmap cannot serve write-cursor page fetches. **That reading is
correct and is re-verified here**: `btreeCursor` gives write cursors `curPagerFlags = 0`
(`sqlite3.c:77886`). It was *incomplete*. The immediately following branch gives read cursors
`PAGER_GET_READONLY` (`:77889`), and FTS5 fetches segment blocks through
`sqlite3_blob_open(pConfig->db, ..., 0, &p->pReader)` in `fts5DataRead` (`:251470`) — flags `0`,
a **read-only** blob handle, and therefore mmap-eligible *inside a write transaction*.

So arm C was never inert, and nothing in the source reading was wrong. The traffic mmap
accelerates is read traffic occurring during the write phase, and the coincidence of `rho_C` and
`rho_B` at T5 points both arms at the same population: **FTS5 segment merge reads, not B-tree
insertion traversals.** The tripwire did its job — it caught an incomplete source argument that
three reviews had passed over.

---

##### Residual weaknesses, recorded

1. **EXPONENT_REDUCED fired by 0.0204.** `b_A − b_B = 1.9331 − 1.7127 = 0.2204` against
   `SLOPE_MATERIAL_DELTA = 0.20`. The threshold's own docstring
   (`eval/e1-ab-score.mjs:57-63`) justifies 0.20 as "deliberately blunt … a marginal call
   decided by an unvalidated noise model is worse than a bar that can only fire on an obvious
   effect", citing σ ≈ 0.0085. On that σ the *bar* is ~20σ but the *outcome* is ~2.4σ. This is
   the marginal call the bar existed to refuse. **EXPONENT_REDUCED is reported at its registered
   value and simultaneously flagged as weakly attained.** Claim 2 does not depend on it —
   `b_hi(B) = 1.8965` and the duration-basis 1.5498 carry that claim.
2. **A3's corroborating curvature reading also fires narrowly.** `b_hi(A) − b_hi(B) = 2.1197 −
   1.8965 = 0.2232` against its 0.20 bar, a margin of 0.0232, and it **fails in block 2**
   (0.1609). A3 registered this as corroborating and non-gating; it corroborates weakly.
3. **The connectivity cell is the one the scorer flagged as noisy.** `rho_D(T1)` carries
   `spread_finding: true` (blocks 1.566 / 1.154 / 1.212, spread 0.412). A4 keys the entire
   mechanism classification on this cell. Connectivity is nonetheless robust: the *minimum*
   block ratio, 1.154, still clears the 1.10 bar. The finding is raised in the JSON and printed
   nowhere by the reporter — an instrument defect, logged.
4. **Both Gate 3 retakes retained the warmer passing attempt** (D/T1/b2 and A/T1/b3), and both
   retentions move *toward* connectivity firing: attempt 1 of D/T1/b2 would have given a ratio of
   1.0795, **below** the bar. Recomputed under first-attempt substitution the median is 1.1719 —
   still fires. Reported per the registered Gate 3 reconciliation clause, with the bias direction
   named.
5. **T5 is optimal, not balanced, and the tripwire arm drew the warm end.** The Latin square
   gives arm C positions 4/3/2 — position-sum 9, the maximum of the forced `{6,7,8,9}` multiset —
   so C never ran first at T5. AMENDMENT 3's arithmetic proves the multiset is forced; it says
   nothing about which arm receives the 9, and the amendment should not have described T5 as
   balanced. Empirically bounded at ≲3% against a 31% effect (arm B ran first at T5/b2 and kept
   its full effect), so `rho_C` is not threatened.
6. **AMENDMENT 3 understated prior exposure.** It says seven runs existed. A full diagnostic
   A/T9 run (540,136 ms) had also been observed before the restart, disclosed only in
   `eval/results/discarded-amendment3/README.md`. The ordering flaw was knowable before the run
   and was acted on only after data showed arm C fast. The discard itself is verified complete
   and honest — same Gate 0 hash, clean timestamp partition — but the disclosure belonged in the
   amendment, not only in the quarantine.

---

##### What this licenses, and what it does not

**Licensed:** the write phase's cost is coupled to SQLite's cache-size setting, strongly and
with a monotone dose–response in corpus size; and **that coupling does not account for the
super-linear exponent**, which survives at 1.7127 (write basis) / 1.5498 (duration basis) with
eviction made impossible.

**Not licensed:** any statement that page-cache residency *is* the mechanism; any channel
attribution between read-miss volume and spill policy; any reading of `rho_D(T9)`; any pragma
change shipped to `mast`. H1 stands unchanged — write-localised, mechanism unidentified.

**Successor probe.** The FTS5 finding gives it a target the previous rounds did not have: an
arm that isolates FTS5 segment-merge read traffic, and an instrument that carries WAL, spill and
RSS counters so the two candidate channels can be told apart. `rho_D(T9) < 1.0` is its second
target and needs an explanation before any cache story is published.

Adversarial review in full: `eval/results/e1-ab-results-review.md`. Every source claim above was
re-verified against the amalgamation and the scorer by the author before being recorded here.

---

#### E1-FTS PRE-REGISTRATION — 2026-08-14, pre-run, post-adversarial-design-review

**The question. H-DELETE-SCAN:** is the per-file FTS5 delete-scan at
`src/graph/populate.ts:318-319` the mechanism behind the write phase's super-linear exponent?

This supersedes the merge hypothesis the author drafted first. That draft is recorded here as
withdrawn, not quietly replaced: it proposed that FTS5 segment merging produced the exponent, and
the adversarial design review killed it on the source before a line was written —
`fts5IndexAutomerge` schedules work proportional to leaves-flushed × level-count
(`sqlite3.c:255626-255645`, `FTS5_WORK_UNIT = 64` at `:250651`), which is amortised O(N log N) and
can contribute perhaps +0.05–0.1 to an exponent, never the +0.9 at issue. The same review found
that the author's proposed `fts_ms` timer would have missed FTS5's segment writes entirely, since
those happen at COMMIT via `fts5SyncMethod` (`:262278`; `xCommit` is a documented no-op at
`:262302`) rather than inside the INSERT — a structural bias toward a **false null**.

##### Epistemic status, stated before the design so it cannot be overclaimed afterwards

**This is not a discovery probe. The mechanism is already established statically.** What is not
established is its magnitude *inside a build*, and whether removing it removes the exponent. That
is what this experiment measures, and it is all it measures.

The design was chosen **after** seeing the evidence below. That is legitimate here only because
the evidence is static and observational — it is prior evidence, not a result of this experiment,
and it is published in this registration so a reader can discount it appropriately. No run
collected under this registration informed its design.

**Prior evidence, verified independently by the author before registering:**

1. **The deletes are full table scans.** `EXPLAIN QUERY PLAN` against the retained
   `phase-run-T9-r3/graph.db` (opened plain-readonly, never `?mode=ro&immutable=1`):

   | statement | plan |
   |---|---|
   | `DELETE FROM chunk_fts WHERE file_path = ?` | `SCAN chunk_fts VIRTUAL TABLE INDEX 0:` |
   | `DELETE FROM identifier_fts WHERE file_path = ?` | `SCAN identifier_fts VIRTUAL TABLE INDEX 0:` |
   | `DELETE FROM chunks WHERE file_path = ?` | `SEARCH chunks USING INDEX idx_chunks_file_path` |

   The ordinary table uses its index; FTS5 cannot, because `xBestIndex`
   (`sqlite3.c:260775-260860`) will not consume an equality constraint on an ordinary column.

2. **They run unconditionally on the cold path**, `populate.ts:318-319`, with no guard on whether
   the file was previously indexed. The comment there reads "Delete existing rows by file_path
   (UNINDEXED column, supported by FTS5)" — true about support, silent about cost, and that is
   where this hid through E1, E1-PHASE and E1-AB.

3. **On a cold build every one of those scans matches zero rows**, because nothing for that file
   has ever been written. The work is not merely quadratic; it is quadratic and entirely wasted.

4. **The quadratic model predicts the measured write times.** With `N` = files and `F` = FTS5
   bytes, scan work over a cold run is `SUM_i F*(i-1)/N ≈ N*F/2`. Fitting the single constant `k`
   in `write_ms ≈ k*N*F` on **T9 alone** and predicting the rest:

   | tier | N | measured write_ms | predicted | err |
   |---|---|---|---|---|
   | T1 | 656 | 1,452 | 1,225 | −15.6% |
   | T3 | 1,393 | 4,555 | 5,504 | +20.8% |
   | T5 | 2,880 | 23,725 | 23,695 | **−0.1%** |
   | T7 | 5,976 | 97,660 | 102,015 | +4.5% |
   | T9 | 13,330 | 500,885 | 500,885 | 0.0% (fitted) |

   The linear null model `write_ms ≈ k*chunks` is wrong by **+1630%** at T1. The quadratic model's
   own implied exponent, `ln(N*F ratio)/ln(chunk ratio) = 6.035/2.993 = 2.02`, sits beside
   E1-PHASE's measured `b_write = 1.9685`. T1 and T3 deviate in the direction and roughly the
   magnitude expected, since fixed per-file work still dominates before the quadratic term does.

   **This table is warm, readonly, out-of-transaction prior evidence.** In-build scans run inside
   `BEGIN IMMEDIATE` against a cache that is missing. The shares are order-of-magnitude priors and
   are explicitly **not** registered as thresholds.

5. It retro-explains E1-AB. A scan is read-cursor traffic and therefore mmap-eligible inside a
   write transaction (`sqlite3.c:77889`, `:251470`), which is why arm C was not inert and why the
   cache dose-response tracked database size.

##### The arms

| arm | what it does | role |
|---|---|---|
| **A** | control — the exact production path | every ratio is taken against this arm inside its own block |
| **G** | identical, except the two DELETE statements at `populate.ts:318-319` are skipped under a driver-injected flag | the causal test, and the fix rehearsal |

**Arm F — "skip FTS5 writes entirely" — is registered as CUT, with the reason.** It was the
author's proposed causal arm and it is unusable: it shrinks the database by ~69%, and E1-AB
established that write time is coupled to database size, so arm F would confound "FTS work
removed" with "smaller database" in the direction that **flatters** a positive result. Arm G has
no such confound: skipping deletes that match nothing leaves the finished database
**byte-identical**. The author believed no confound-free causal arm existed; the review found one.

##### Ladder, blocks, and the estimator

**T1/T3/T5/T7/T9 × 3 blocks**, both arms interleaved within a block. Five rungs, not E1-AB's
three: a three-rung slope is determined by three points with no residual freedom and no honest
interval, which E1-AB's own results review named as a weakness. Not E1's nine, because the
marginal rungs cost more than the precision buys here.

Blocks are contiguous and the primary estimator is a **within-block ratio**, so drift cancels by
construction — inherited from E1-AB unchanged. Within-block arm order is a **Latin square**
(AMENDMENT 3's lesson, carried forward: with 2 arms × 3 blocks exact positional balance is not
attainable, so the order alternates and the imbalance is recorded rather than described as
balanced).

##### What is instrumented

Four spans **tiling** the write phase, each **timed directly — none by subtraction**:

- `fts_del_ms` — the two DELETE statements
- `fts_ins_ms` — the two batched INSERT loops
- `commit_ms` — the per-file transaction commit, where FTS5's segment flush actually happens
- `rest_ms` — chunks, symbols, imports

Timed directly because a single blended `fts_ms` would mix a population with `b ≈ 2` (the deletes)
against a roughly linear one (the inserts), and because `rest = write − fts` would silently absorb
any cost the other timers missed — which is exactly how the author's first design would have
produced a false null. The existing `phaseMs` record (`src/indexer/index.ts:81`) is unchanged;
these are additive.

Timer overhead is quantitatively closed, not assumed: 43.5 ns per `Date.now()`, 0.016% of T1's
write and 0.0009% of T9's, slope bias < 0.001. It was worth checking because an overhead that is a
larger fraction of a small rung's time biases the slope, which is the one quantity being measured.

##### Gates

- **Tiling ≥ 0.95** per run — the four spans must account for the write phase. The analogue of
  E1-PHASE's `GATE_P_FLOOR` (`eval/e1-phase-schedule.mjs:32`), same floor and same reason.
- **`db_bytes(G) == db_bytes(A)`** per rung. This is what makes arm G confound-free, so it is a
  gate and not an observation; a mismatch voids the arm.
- **Gate 0 (binary identity) and Gate 3 (dual clocks)** inherited from E1-PHASE unchanged.
- **Fresh binary ⇒ no absolute-time comparison** with E1, E1-PHASE or E1-AB records. Both arms
  share this binary, which is what keeps the comparison internally valid. E1-AB's registered
  consequence applies verbatim.

##### Registered outcomes

**MECHANISM_IDENTIFIED** iff all four hold:

1. `b_fts_del ≥ 1.6`
2. `fts_del/write ≥ 0.50` at T9
3. `write_A/write_G ≥ 2` at T9
4. `b_write(G) ≤ 1.35` — the immutable E1 linearity threshold, reused unchanged

**PARTIAL** iff the decomposition conditions (1-2) hold but `b_rest > 1.35`, or the intervention
conditions (3-4) fail. **PARTIAL is a first-class outcome, not a degraded one**: `chunks` carries a
TEXT primary key whose autoindex is a plausible second super-linear term, and if it is real then
removing the delete-scan will reduce the exponent without flattening it. Registered in advance so
that result cannot be reported as a disappointment or as a null.

**NULL** iff `b_fts_del < 1.6`. This would mean the static model above is wrong about in-build
behaviour, which is a publishable finding in its own right.

**Instrument-validity check, adjudicating nothing:**
`|(write_A − write_G) − fts_del_A| ≤ 0.15 · fts_del_A` at T7 and T9. Two independent measurements
of the same quantity; disagreement condemns the instrument, not the hypothesis.

##### Direction of error, and what this cannot license

**Direction of error.** The author arrives at this experiment already believing the hypothesis, on
the strength of a model that fits four rungs. That is the condition under which a favourable
result is least informative and an unfavourable one most informative. The registered NULL band
exists to be reachable, and the honest expectation is recorded here: **MECHANISM_IDENTIFIED is
expected.** If it is returned, it confirms a prediction made in advance; it is not a discovery
made by the experiment.

**This cannot license:** any statement about the *update* path (arm G's condition is cold-build
only — an incremental reindex genuinely must delete, and for that path the delete-scan is a real
cost needing a different fix); any claim that the exponent is now *explained* if PARTIAL is
returned; any re-adjudication of E1's SUPER-LINEAR verdict, which stands regardless; and any
explanation of E1-AB's `rho_D(T9) = 0.8486`, which the scan mechanism does not obviously produce
and which remains open.

**Not shipped on the strength of this.** The fix — guarding both DELETEs on whether the file's
`files` row previously existed, which the F12 monotonic-guard SELECT at `populate.ts:216-220`
already knows — is a separate change, verified by re-running **E1's full 9-rung ladder** against
the committed scorer and the immutable 1.35 threshold. Arm G is a rehearsal of that guard, not the
guard itself.

**Cost:** 30 runs, ≈ 45–50 minutes.

**Design review:** `eval/results/e1-fts-design-review.md`. It is the reason this registration
exists in this form: it withdrew the author's mechanism, found the real one, caught a false-null
bias in the author's proposed instrument, and replaced an unusable arm with a confound-free one —
all before any code was written.

##### AMENDMENT 1 — 2026-08-14, pre-run, instrument-informed, no data collected

**Four spans become six.** `txn` and `lock` are added. Nothing else in the registration changes:
the arms, the ladder, the blocks, the estimator, the gates, the registered outcomes and every
numeric threshold stand exactly as written above.

**Why.** The registration named four spans and asserted they tile the write phase. Built and run
against a 56-file smoke corpus, they tiled it to **0.746** — against a registered gate of 0.95.
The unattributed remainder was **0.72 ms per file**, and it decomposes into two things the design
simply forgot:

| span | what it is | share of that smoke build's write phase |
|---|---|---|
| `txn` | connection checkout, the two `busy_timeout` pragmas, `BEGIN IMMEDIATE` | 6.8% |
| `lock` | `structure.lock` acquire + release, once per 16-file batch (F1) | 13.2% |

With both added the same build tiles to **0.989**.

**Why this mattered more than a failed gate.** Both are roughly constant per file (`txn`) or per
batch (`lock`), so their share *shrinks* as the ladder climbs — projected at ~33% of T1's write
phase and ~2% of T9's. The registered gate would therefore have voided **T1**, the cheapest rung
and the one that anchors the growth exponent, while passing T9, the rung where the answer is least
in doubt. A gate that fails only where the measurement is hardest is worse than no gate.

The second consequence is the one that would have been invisible. Had the remainder been swept
into `rest` — the obvious repair, and the one a subtraction-based design would have made
automatically — then `b_rest` would have carried a per-file constant. A constant per file is
linear in `N`, which pulls any fitted exponent toward 1.0, so `b_rest > 1.35` — the **PARTIAL**
condition — would have been biased toward not firing. The registration's ban on computing spans by
subtraction is what prevented that, and it prevented it before any data existed.

**No registered statistic changes meaning.** `rest` was already defined as "chunks, symbols,
imports" and timed directly, so `txn` and `lock` were never inside it — they were unattributed,
not misattributed. `fts_del/write` keeps `phaseMs.write` as its denominator. This amendment adds
visibility; it moves nothing between existing buckets.

**Legitimacy.** No run has been collected under the four-span design, scored or otherwise. This is
instrument construction, not a data-informed redesign, and so does not incur E1-AB AMENDMENT 3's
obligation to discard prior runs — there are none to discard.

**Clock: `performance.now()`, not `Date.now()`.** The registration costed the timers against
`Date.now()` at 43.5 ns. Measured on this machine, `Date.now()` costs 65.3 ns/call and yields only
**33 distinct values across a 200,000-call burst** — roughly 1 ms granularity. `performance.now()`
costs **34.8 ns/call** with full sub-microsecond resolution. At T1 a per-file FTS delete runs well
under a millisecond, so `Date.now()` would round each one to 0 or 1 and turn the anchor rung into a
coin flip. The substituted clock is both cheaper and less biased, so the deviation runs in the
direction of a harder test. Overhead with six spans: ~12 timer calls per file ≈ 418 ns, which is
0.019% of T1's write phase and 0.001% of T9's.

**Not evidence of anything.** The smoke build above is 56 files — two orders of magnitude below
T1. Its span shares (`fts_del` at 4.6%) are reported here to justify the amendment and for no
other purpose. They are not a prior, not a prediction, and not comparable to any rung.

##### AMENDMENT 2 — 2026-08-14, pre-run, no data collected

**`b_rest ≤ 1.35` is a fifth blocking condition on MECHANISM_IDENTIFIED.** The registration's two
outcome clauses contradict each other and this resolves the contradiction before any data exists.

The MECHANISM_IDENTIFIED clause reads "iff all four hold" and lists conditions 1-4, which do not
include `b_rest`. The PARTIAL clause reads "iff the decomposition conditions (1-2) hold but
`b_rest > 1.35`, **or** the intervention conditions (3-4) fail." Those disagree about exactly one
case: all four registered conditions hold *and* `b_rest > 1.35`. The first clause returns
MECHANISM_IDENTIFIED; the second returns PARTIAL.

**Resolved in favour of PARTIAL**, because the PARTIAL clause is the one that mentions `b_rest` at
all, and because the substantive reason PARTIAL was registered as first-class says the same thing:
`chunks` carries a TEXT primary key whose autoindex is a plausible second super-linear term, and a
surviving second term means the exponent has been *reduced*, not *explained*. Reporting that as
MECHANISM_IDENTIFIED would claim the stronger of the two.

The resolution is recorded because it is an interpretation of ambiguous registered text, and the
direction it resolves in is the one **less** favourable to the author's expected outcome. It was
found by a test written against the registration's words rather than against the implementation —
`eval/__tests__/e1-fts-score.test.mjs`, "returns PARTIAL when a second super-linear term survives
in rest" — which is why it surfaced before the run rather than during the results review.

**One further reading fixed here, also before data.** The registration names the condition
"`fts_del/write ≥ 0.50` at T9" without saying whether that is the median run's own share or the
median of the three per-run shares. Both are computed and both are reported; the one that
**adjudicates** is the median run's own share, following E1-PHASE's H1 precedent. Fixing it in code
now removes the option of choosing once the two are seen to disagree.

##### AMENDMENT 3 — 2026-08-14, mid-run, instrument defect. No scored run affected.

**The span and the clock in a record must come from the same attempt.** They did not, and the
first schedule produced one false VOID because of it.

**The defect.** Gate 3 retakes a cell up to three times. When every attempt misses,
`selectFitted` (`eval/e1-schedule.mjs:187-191`, E1's, unchanged and unchangeable) retains the
**first** attempt's clock and phases. The driver paired that with `run.write_spans` — the **last**
attempt's. The tiling gate then divided one attempt's spans by another attempt's write phase.

It fired on `G#T3#b1`, the only cell in the schedule that missed Gate 3 on all three attempts.
The gate recorded `tiling 0.7318` and voided the run. Recomputed from that same void record, the
attempt's own spans sum to 2,513.0 ms against its own write phase of 2,527 ms — **0.9945**. The
run was fine; the gate was comparing two different runs. In the opposite direction the same defect
would have produced a false PASS.

**No scored run is affected, and the verification is reproducible rather than asserted.** All 29
retained runs have `gate3.ok === true`, so `selectFitted` returned the current attempt for every
one of them and the fitted spans are the same object either way. Recomputing tiling from each
retained record directly gives a minimum of **0.9937** across all 29. Check both from
`eval/results/e1-fts-runs.jsonl`:

- `runs.filter(r => !r.gate3.ok).length === 0`
- `min(sum(values(r.write_spans)) / r.write_ms) === 0.9937`

**This does not trigger E1-AB AMENDMENT 3's discard obligation.** That obligation exists because a
design changed *after seeing data* can be shaped by it, so the data collected under the old design
must go. Here the change is provably a no-op on every run that was retained — not "we believe it
made no difference", but "the branch it alters was never taken by any scored run". The one cell it
did alter was voided and scored nothing. The voided pair re-runs, which is what the estimator
requires anyway: `G#T3#b1`'s partner `A#T3#b1` is re-run with it so the pair stays temporally
adjacent.

**What it cost to find.** Nothing was lost, but only because the gate failed loudly and the void
record retained the measurement that disproved it. A tiling gate that had silently passed the
inverted case would have put a mis-scaled `fts_del/write` into the record with no trace.

##### AMENDMENT 4 — 2026-08-14, post-run, summary defect. No scored run affected.

**Interruption detection must be repair-aware.** After the voided `T3/b1` pair was repaired, the
summary reported **five INTERRUPTED attempts that never happened**.

`orphanedAttempts` (`eval/e1-schedule.mjs:135-157`, E1's) counts every `attempt_start` for a cell
across the whole journal and subtracts the attempt count of the **last** terminal record. That is
correct for a schedule in which each cell runs once. E1-FTS is the first schedule here to both
repair pairs and resume, so a cell that legitimately ran twice — first pass, then repair — had
both passes' attempts charged against only the second pass's count, and the first pass's attempts
were reported as interruptions.

**Not cosmetic.** Orphan counts feed `remainingAttempts`, which SHRINKS a resumed cell's Gate 3
retake budget; at the limit it reaches zero and the driver voids the cell with
`retake_cap_exhausted_by_interruptions` — a cell voided for interruptions that did not occur. It
did not bite this schedule, because orphans are computed once at the start of an invocation and
the repair ran within the same one. Any subsequent resume would have hit it.

`ftsOrphanedAttempts` applies E1's own rule per SEGMENT instead of per key: each terminal record
closes a segment and consumes the last `n` starts in it; leftovers were genuinely killed, and
starts still pending at the end of the journal were genuinely interrupted. `e1-schedule.mjs` is
E1's scored instrument and is **not** modified — the defect there is recorded here rather than
patched in place, and E1-AB's completed record is unaffected because that schedule was never
resumed after a repair.

**No scored run is affected.** Orphan counts touch only the findings text and the retake budget of
runs not yet taken. The 30 scored records are byte-identical. The corrected summary reads
`0 interrupted`, with the two findings that are real: `VOID RESOLVED G#T3#b1` and
`SUPERSEDED A#T3#b1`.

#### E1-FTS RESULT — 2026-08-16, scored, post-adversarial-review

**MECHANISM_IDENTIFIED.** The per-file FTS5 delete-scan carries the write phase's super-linear
exponent. All five conditions met; the smallest margin is 8x.

##### What ran

30/30 runs, `scoreable: true`. Gate 0 pinned `dist` at `d863c5d5…`; Gate 1, Gate 3 and Gate P
inherited and clean; minimum tiling **0.9937** against the 0.95 floor; chunk counts identical
across both arms at every rung; 15/15 database-identity pairs equal. One cell voided and was
repaired (AMENDMENT 3); interruption reporting was corrected (AMENDMENT 4). Neither touched a
scored record.

##### The registered conditions

| condition | measured | bar | margin |
|---|---|---|---|
| `b_fts_del` | **2.3454** | >= 1.6 | 1.47x |
| T9 `fts_del/write` | **91.7%** | >= 50% | 1.83x |
| T9 `write_A/write_G` | **15.96** | >= 2 | 7.98x |
| `b_write(G)` | **1.0956** | <= 1.35 | |
| `b_rest` | **1.1768** | <= 1.35 | |

Span shares of arm A's write phase, by rung: `fts_del` 27.8% -> 43.4% -> 72.5% -> 84.7% -> 91.7%.
Intervention ratio: 1.368 -> 1.835 -> 4.020 -> 7.620 -> 15.957 (T9 blocks 15.417 / 16.419 / 15.957;
spreads 13.5% / 7.5% / 11.5% / 3.0% / 6.3%). End-to-end at T9: 499.2 s -> 58.8 s, 8.5x — smaller
than the write-phase figure because parse then dominates.

##### Five claims the adversarial review corrected

The review is `eval/results/e1-fts-results-review.md`. It reimplemented the fold, the OLS, the HC3
intervals, every median and all fifteen block ratios independently and matched the verdict exactly.
The verdict survived; five statements about it did not, and every correction below was
re-verified against source and journal before being recorded.

1. **"Byte-identical" was false — it is byte-COUNT identical.** The gate reads
   `statSync(...).size` (`eval/e1-common.mjs:587`). Content was digested only on the 56-file smoke
   corpus (`src/graph/__tests__/write-spans.test.ts`). **No scored run's FTS content was ever
   verified**, and the schedule does not even record a `chunk_fts` row count. Size equality across
   15 pairs spanning five orders of magnitude is strong evidence for arm G's premise; it is not the
   proof the original wording claimed.

2. **"The same quantity by two independent routes" is refuted by this experiment's own journal.**
   Arm G is faster at NON-delete work too. Median non-delete spans, arm A minus arm G: T5 **+64 ms**,
   T7 **+1,925 ms**, T9 **+7,858 ms**; `rest` alone at T9 is 7,090 ms (A) against 4,166 ms (G),
   **+70%**. So `write_A - write_G` is the delete span PLUS a real secondary effect — almost
   certainly page-cache eviction by the scans, which is what E1-AB's cache dose-response predicts.
   The validity check passed honestly at 2.1%, because the spillover is small relative to the span;
   the description of what it demonstrated was wrong, and the spillover itself went unreported.

3. **"Replicates E1-PHASE on a different binary" overstated it.** The chunk counts are
   digit-identical (3679 / 7761 / 16529 / 34691 / 73359): same corpus manifest, same tier trees,
   same machine, same imported estimator. `b_write(A) = 1.9379` against E1-PHASE's `1.9685` is a
   **repeatability check under instrument perturbation** — worth having, since levels moved up to
   11% while the slope held — but not an independent replication.

4. **The interval was quoted for something the scorer disclaims.** The claim "the model's 2.02 lies
   outside [2.303, 2.388]" leans on an HC3 interval that this scorer explicitly registers as
   "context, not a bar", and that is anticonservative here: 15 runs at 5 rungs have residuals
   clustered by rung. **The conclusion survives on better evidence.** Every adjacent local slope of
   `ln(fts_del)` on `ln(chunks)` — 2.270, 2.536, 2.222, 2.253 — exceeds 2.02. The weakest local
   slope beats the model without any interval being invoked.

5. **`b_rest = 1.1768` is the spillover-contaminated number.** It is arm A's, and finding 2 shows
   arm A's `rest` carries eviction cost the deletes caused. Arm G's uncontaminated rest exponent is
   **1.0124** — a materially stronger result, and it was sitting in the journal unreported.

##### What stands

The intervention result is unaffected by finding 2: the spillover is a causal CONSEQUENCE of the
deletes, so `write_A/write_G` remains the honest measure of what removing them buys. What finding 2
costs is the decomposition's precision, not the intervention's validity — `fts_del` slightly
under-states the deletes' full cost rather than over-stating it, which is the safe direction.

The monotone climb of the intervention ratio across five rungs cannot be produced by a constant
factor: a constant shifts a log-log intercept and leaves the slope alone. AMENDMENT 2's
contradiction was real and was resolved toward the stricter reading. AMENDMENT 3's repair is
provably immaterial, and the repaired pair drifted TOGETHER — its ratio, 1.803, sits inside the
range of the blocks it was compared against, which is the within-block design demonstrating itself.

##### What this does and does not license

**Licensed.** The delete-scan is the mechanism. The fix — guarding both DELETEs on whether the
file's `files` row previously existed, which the F12 SELECT at `populate.ts:216-220` already
knows — is worth building.

**NOT licensed.** Any claim about the UPDATE path, where the deletes are real work and need a
different fix. Any re-adjudication of E1's SUPER-LINEAR verdict, which stands. Any explanation of
E1-AB's `rho_D(T9) = 0.8486`, still open. Any statement that arm G's content was verified. And —
the top residual threat — **any extrapolation beyond T9 or to a different size-to-cache ratio.**
The T3->T5 local slope of 2.536 against neighbours near 2.23 indicates a regime change, plausibly
the FTS tables outgrowing the 15.6 MiB page cache, so the fitted 2.35 blends two regimes.

**MECHANISM_IDENTIFIED was registered in advance as the EXPECTED outcome.** This confirms a
prediction; it discovers nothing. The informative content is in the corrections above and in the
magnitude, which exceeded the prediction that motivated the design.

##### Residual weaknesses, ranked by threat to the conclusion

1. **T3->T5 curvature, unexplained.** Limits extrapolation. Does not threaten the mechanism.
2. **Content identity never verified on a scored run.** Size is a proxy. Cheap to close: record
   `chunk_fts` / `identifier_fts` row counts, or a content digest, per run.
3. **Spillover unmeasured as such.** The eviction effect is visible in the spans but was never
   given its own estimate.
4. **The HC3 interval is anticonservative** and should not be quoted for anything. A cluster
   bootstrap over blocks would be the honest interval.
5. **`b_fts_del` exceeds the motivating model by 0.33** and the gap is unexplained. Candidate:
   FTS5 segment-count growth adding per-scan overhead beyond raw bytes. Untested.

##### ADDENDUM — 2026-08-16: two review weaknesses closed, no re-run required

Residual weaknesses 2 and 3 above are now instrumented. Neither changes the verdict.

**3 — the eviction spillover now has its own estimate.** Arm A's non-delete spans minus arm G's,
within a block, medianed:

| rung | spillover | share of the intervention delta | where it lands (top 3) |
|---|---|---|---|
| T1 | **-20 ms** | -5.3% | noise-dominated |
| T3 | 228 ms | 10.3% | commit 133, fts_ins 45, rest 41 |
| T5 | 540 ms | 3.4% | rest 193, fts_ins 157, commit 88 |
| T7 | 2,020 ms | 2.5% | fts_ins 736, rest 677, commit 435 |
| T9 | **7,928 ms** | **1.8%** | rest 2,924, fts_ins 2,251, commit 1,936 |

**This strengthens the decomposition rather than weakening it.** The spillover grows in absolute
terms but SHRINKS as a share of the intervention delta, from 10.3% at T3 to 1.8% at T9 — so at the
rung that adjudicates, **98.2% of `write_A - write_G` is the directly-timed delete span**. The
review's finding 2 stands as a correction to the *description* of the validity check; its
quantitative effect on the T9 result is under two percent.

T1's value is NEGATIVE (-20 ms, -5.3%), which the eviction story does not predict. It is reported
rather than clamped: at 1.5 s of write phase the rung is noise-dominated, and a contradiction that
only appears where the signal is smallest is the expected shape of noise rather than of a rival
mechanism. Recorded so a future reader can check that reading rather than take it.

**2 — FTS content identity is now recorded per run.** `readGraphCounts` captures
`chunk_fts_count` and `identifier_fts_count` (read AFTER the timed run, so the measurement is
untouched), and the database-identity gate compares them. For an arm that differs only by skipping
DELETEs, extra or missing rows are the sole way content can diverge, so these counts are necessary
and sufficient — a full digest would be stronger but answers a question this arm cannot pose.

**The completed schedule is not retroactively graded against it.** Those 30 runs recorded no
counts, and a check added afterwards must not fail an experiment that never ran under it. The gate
reports `content_not_recorded` and `content_checked: false`, and the re-scored verdict states
plainly: **content verified on 0 of 15 pairs.** Weakness 2 is therefore closed for future
schedules and remains open, and openly labelled, for this one.

##### Not shipped on the strength of this

Arm G is a rehearsal of the guard, not the guard. The fix is a separate change, verified by
re-running **E1's full 9-rung ladder** against the committed scorer and the immutable 1.35
threshold.

---

#### E1-VERIFY RESULT — 2026-08-17, the guard against E1's own ladder

**HOLDS.** E1's ladder, re-run against the shipped FTS delete guard and scored by `scoreE1`
untouched at the immutable 1.35 threshold, returns **b = 1.0825**. E1 measured **1.7529** and
returned SUPER_LINEAR.

Note which verdict this is. E1's table is deliberately asymmetric: SUPER_LINEAR needs the HC3
lower bound above the bar, HOLDS needs **all four** intervals below it. All four classify `below`.

##### What ran

27/27 runs (9 rungs x 3 reps), **0 voids**. Gate 0 pinned `dist` at `b77f0ae3…`; **Gate 0b clean**
(`src_newer_by_ms: 0`) — the gate that did not exist when E1, E1-PHASE, E1-AB and E1-FTS ran. `c`
was re-measured on this binary at **15 ms** (n=10, 14–19), because E1's stored `c` was taken on a
different one and a stale additive constant biases `b` *downward*, toward the answer this run
wants.

Scored by `eval/e1-verify-score.mjs`, which computes nothing: it renames `corpus` to `tier` and
calls `scoreE1`. The fit, the HC3 interval, the cluster bootstrap, the lack-of-fit test, the five
triggers and the verdict rule are E1's. Writing a faithful new scorer here would have been marking
my own homework with a ruler I had just made.

##### The fit

| fit | b | HC3 | cluster bootstrap |
|---|---|---|---|
| adjusted (primary) | **1.0825** | [1.0651, 1.0998] | [1.042, 1.122] |
| raw | 1.0806 | [1.0631, 1.0981] | [1.039, 1.122] |
| by file (`b_file`) | 1.0837 | | |

Lack of fit **quiet**: F = 1.9141, p = 0.1264, departure 1.40%. Triggers 3/4/5 **quiet** (t3 ratio
1.0210 against 1.5; t4 all per-tier rates 0; t5 `b_chunk` 1.0825 vs `b_file` 1.0837). No
qualifiers, no reasons.

##### `fts_del` is zero

**0 ms in all 27 runs — max 0, sum 0.** The span E1-FTS measured at 91.7% of T9's write phase, with
its own exponent of 2.3454, does not appear at any rung. The descriptive write-phase log-log slope
falls from E1-PHASE's `b_write = 1.9685` to **1.1136**, and the write phase stops dominating: it
was **94.01%** of T9 and is now **51.3%** (44.8–53.1% across the ladder), with parse at 36.3%.

> **[Correction, 2026-08-17, post-review]** The parse figure is wrong: T9 parse/duration is
> **34.5%** (per-rep 34.04 / 34.49 / 34.48). 36.3% does not reproduce under any estimator tried —
> per-rep, per-rung median, ratio-of-medians, against `external_ms`, or with `c = 15` subtracted.
> Every other number in this subsection reproduces exactly, including the 51.3% it sits beside.
> Nothing downstream depends on it. Found by adversarial review of the FINDINGS.md index.

##### The guard skips work, not rows

`chunk_fts_count === chunk_count` in **27 of 27** runs; 0 parse errors throughout. This is the
check that separates a correct guard from a fast one — skipping the deletes *and* losing rows would
also have produced a flat exponent.

##### One Gate 3 miss, and what it revealed

Five cells needed a retake. One — **T3#r3** — failed on all three attempts (deltas 510, 593,
513 ms against a 500 ms floor) and E1's rule retained the first attempt, `gate3_finding` recorded.

The overshoot is 13 ms, and its cause is worth recording: Gate 3's floor is `max(500 ms, 5% of
fitted)`, and the ~510 ms is fixed process startup that the internal clock correctly excludes. On
the pre-guard binary T3 took 7.2 s and that overhead was invisible under the 5% arm. **The guard's
own speedup shrank the runs until a constant became visible.** The floor is now marginally tight at
the small rungs — a note for any future ladder, not a defect in this one.

##### Sensitivity

The verdict does not depend on any of it:

| perturbation | b | HC3 upper | verdict |
|---|---|---|---|
| all 27 (registered) | 1.0825 | 1.0998 | HOLDS |
| drop T3#r3 | 1.0839 | 1.1013 | HOLDS |
| external clock throughout | 1.0353 | 1.0577 | HOLDS |
| `c = 0` | 1.0806 | 1.0981 | HOLDS |
| `c = 30` | 1.0843 | 1.1015 | HOLDS |

Every upper bound sits below 1.11 against a bar of 1.35.

##### Descriptive, not registered: the wall clock

T9's median build goes **538,591 ms → 62,136 ms**, ~8.7x. This is *not* a registered comparison —
different binary, `c` re-measured — but it lands where the prior work predicted. E1-PHASE put write
at 94.01% of T9 and E1-FTS put the delete-scan at 91.7% of write, making the scan ~86% of T9 and
predicting ~74 s. Observed 62 s, ~16% better, plausibly because a smaller segment churn also
cheapens the commit. Three independently-registered measurements agreeing to within 16% is
coherence that is hard to obtain by accident.

##### What this does NOT establish

- **Ladder only.** E1's 5-corpus PANEL was out of scope, as registered; E1 records it as
  `panel_supporting_only`. No claim is made about it.
- **`ρ_D(T9) = 0.8486` from E1-AB remains unexplained.** The exponent is gone; that correlation was
  never the same question and is not answered here.
- **Absolute timings are not comparable to E1's ladder.** The exponent is what was compared.
- **Linear is not proven, and cannot be.** `b = 1.08` with an upper bound of 1.10 is what was
  measured over 3.7k–73k chunks. It is a statement about this range, not an asymptote.

##### The near-miss that changed the gates

The guard was written, tested, linted and committed at `1dba79b` — and `dist/` was never rebuilt.
The first two E1-VERIFY cells measured a two-day-old binary. The only signal was `fts_del 956 ms`
on a cold build, a span the guard makes exactly zero; a subtler effect would have run all 27 cells
against the wrong binary and scored them.

Gate 0 could not see it, and the reason generalises. Its `schema_version` check compares binary to
source but the version had not changed. Its content hash pins the binary across a *resume* — it
detects `dist/` changing mid-schedule and says nothing about whether `dist/` ever corresponded to
`src/`. **A stale build is perfectly self-consistent.** Every experiment in this program ran under
that blind spot.

**GATE 0b** (`12bf47c`) compares the newest `.ts` under `src/` to the newest artifact under `dist/`
and throws, naming the offending file. Zero tolerance, because `tsc` rewrites only outputs whose
input changed — a tolerance window is precisely how a one-file edit slips through, and a one-file
edit is what this was. The two invalid runs, the pin carrying the stale hash, and the calibration
taken on it are quarantined under `eval/results/discarded-stale-dist/` with the diagnosis.

##### Commits

`1dba79b` guard + tests · `12bf47c` Gate 0b + quarantine + rebuild · `bf4854d` E1-VERIFY results.

---

## Stage 4.5: Scale — the actual target
**Goal**: MAST is "Monorepo AST search". Make the scale target explicit and measured,
because it changes several decisions already taken.
**Status**: **S1 Complete; scale target MEASURED** (vscode@`5ebbe53`, 2026-08-17). The stage's
own forward-looking analysis is **substantially superseded** — it was written before E1 and before
Stage 7 deleted the vector store. **Read the STAGE 4.5 CORRECTION block at the end of this stage
before acting on anything between here and Stage 5.**

**S1 (added 2026-08-07, promoted from HANDOFF §5's defect list): batch
`replaceChunksForFile`'s insert.** `src/store/sqliteChunkStore.ts:82` issues ONE
multi-row `INSERT` for all of a file's chunks; at 11 columns/row, SQLite's
32,766-parameter ceiling caps a single file at ~2,979 chunks, and a larger file's
insert rolls back entirely — loud (`write_errors` + CLI exit 1) but the file is then
silently absent from the index for any orchestration that gates only on exit code.
Found via vscode's whale fixture files. This is the known write-path correctness
defect at the 150k-chunk target; fix = chunked inserts inside the same transaction.

**S1 result (2026-08-07):** fixed the whole defect class, not just the named site —
a survey of every multi-row write in `store/` and `graph/` found 8 sites sharing the
same SQLite `MAX_VARIABLE_NUMBER=32,766` ceiling (better-sqlite3 12.11.1 / SQLite
3.53.2):

| # | site | file:region | cols/row | rows/batch (`⌊32766/cols⌋`) |
|---|---|---|---|---|
| 1 | `chunks` insert | `store/sqliteChunkStore.ts` `replaceChunksForFile` | 11 | 2,978 |
| 2 | `chunks` insert (production path) | `graph/populate.ts` `replaceChunksInline` (`populateFile`'s default, no-override path) | 11 | 2,978 |
| 3 | `symbols` insert | `graph/populate.ts` `populateFile` | 7 | 4,680 |
| 4 | `imports` insert | `graph/populate.ts` `populateFile` | 5 | 6,553 |
| 5 | `chunk_fts` insert | `graph/populate.ts` `populateFile` | 4 | 8,191 |
| 6 | `identifier_fts` insert | `graph/populate.ts` `populateFile` | 3 | 10,922 |
| 7 | `edges` insert (`onConflict(doNothing())`) | `graph/populate.ts` `insertEdges` | 6 | 5,461 |
| 8 | two `IN`-list SELECTs (`fromNames`, `structuralToNames`) | `graph/populate.ts` `insertEdges` | 1 param/name | 32,766 |

Site 2, not site 1, is the one that actually fired on vscode — `populateFile`'s
default path writes `chunks` inline via `replaceChunksInline`, not through
`SqliteChunkStore`; `SqliteChunkStore.replaceChunksForFile` is a parallel write path
(used directly, and as the write-failure test injection point) with the identical bug.

**Design.** One shared, pure, unit-tested helper pair in a new module,
`src/graph/sqliteBatch.ts`: `SQLITE_MAX_VARIABLES = 32_766` (exported constant, WHY
sourced from better-sqlite3/SQLite's `MAX_VARIABLE_NUMBER` default) plus
`chunkRowsForSqlite<T extends object>(rows)`, which computes batch size as
`Math.floor(SQLITE_MAX_VARIABLES / columnsPerRow)` with `columnsPerRow` read from
`Object.keys(rows[0]).length` (every call site builds rows through one fixed-shape
mapper, so row 0's key count is authoritative — documented as an explicit assumption
in the TSDoc), and a sibling `chunkValuesForSqlite<T>(values, paramsPerValue = 1)` for
the bare-scalar `IN`-list sites (site 8). Both return `[]` for empty input, not `[[]]`.
Placed in `graph/` (not `store/`) because `store/sqliteChunkStore.ts` already imports
`Db` from `../graph/db.js` — `store -> graph` is the existing dependency direction, and
`graph/` importing from `store/` would add a new one; mast is one flat align component
so this is a placement choice, not a conformance requirement, but the existing edge
direction is the more legible default. `pnpm align:check` was re-run post-fix to
confirm no new edge was introduced (see Verification below).

**Atomicity preserved.** Every batch runs inside the SAME `db.transaction()`/`trx` the
unbatched call used — batching is applied to the STATEMENT, not the transaction
boundary. A whale file's chunks still commit or roll back atomically together with its
symbols/edges/imports/FTS rows; see the WHY-comment at `store/sqliteChunkStore.ts`'s
`replaceChunksForFile` (first fixed site) and the fuller one at `graph/populate.ts`'s
`replaceChunksInline` (the production path). Site 7's `.onConflict((oc) =>
oc.doNothing())` is re-applied per batch (each batch is its own statement). Site 8's
`structuralToMap` first-row-wins dedup is preserved exactly: `structuralToNames` is
already deduped via `Set` before batching, so each name lands in exactly one
`IN`-list batch — cross-batch collisions are structurally impossible, and the
within-batch dedup loop (`if (!structuralToMap.has(row.name))`) runs unchanged,
processing batches in their original order.

**Red-first evidence (§5).** Unit spec `src/graph/__tests__/sqliteBatch.test.ts` (10
tests: empty input, single row, exactly-at-ceiling batch boundary, ceiling+1 spill, a
1-column max-batch-size shape, content/order preservation, plus the `chunkValuesForSqlite`
equivalents) was written against a stub that threw `not implemented` — confirmed RED
(10/10 failing) before the helper was implemented, then green after.
Integration red: `src/graph/__tests__/whale-file.test.ts` calls `populateFile` directly
with a synthesized extraction (3,000 chunks × 11 cols = 33,000 params; 5,000 symbols ×
7 cols = 35,000 params; matching identifier rows) — on unfixed code this failed with:

```
SqliteError: too many SQL variables
  at replaceChunksInline (src/graph/populate.ts:254:8)
```

Sibling red test added to `src/store/__tests__/sqliteChunkStore.test.ts`
("`replaceChunksForFile` writes a whale-scale chunk set past the SQLite
bound-parameter ceiling", 3,000 chunks) failed identically on unfixed code:

```
SqliteError: too many SQL variables
  at src/store/sqliteChunkStore.ts:82:71
```

Both became green after the fix, asserting `written: true` / exact DB row counts for
chunks and symbols, and the removed-count contract (`chunksRemoved` /
`replaceChunksForFile`'s return value) held across a whale-scale replace.

**Deliberate test-budget call (§5.5).** Sites 7 (edges) and 8 (the two `IN`-list
SELECTs) are covered by the shared helper's unit tests plus code review, not a
dedicated whale-scale integration fixture — building a fixture with >5,461
RESOLVABLE edges (site 7's cap) requires thousands of cross-referencing symbols with
real POTENTIAL_CALL/IMPLEMENTS/EXTENDS resolution, which is disproportionate effort
for a mechanical batching change already proven correct by the shared helper's tests
and by sites 3–6 (which use the identical `chunkRowsForSqlite` call) landing 5,000
symbols correctly in the whale-file integration test.

**Verification (2026-08-07):**
- `pnpm -F mast test`: **483 passed (37 files)** — baseline 471/35 plus 12 new
  (10 helper unit tests, 1 whale-file integration test, 1 sibling
  `SqliteChunkStore` whale test).
- `pnpm -F mast typecheck`: clean.
- `pnpm -F mast lint`: clean.
- `pnpm align:check` (repo root): `baselined debt: 324 → 324 (0)`; red only on the 2
  pre-existing non-mast violations (`application/ui` import cycle,
  `apiDomain -> apiDb`) — no new debt introduced by this change.

**Measured chunk counts** (mast defaults, `.ts/.tsx/.js/.jsx/.md`, test/spec excluded):

| corpus | files | chunks |
|---|---|---|
| **vscode** | 8,653 | **152,969** |
| **backstage** | 7,801 | **89,515** |
| **n8n** | 9,117 | **49,509** |
| strapi | 3,548 | ~23k (est) |
| kluster (self) | 1,799 | 14,212 |
| directus | 2,089 | 7,205 |
| nest | 1,333 | 5,030 |

**[Correction, 2026-08-02 — see Q1/SCALE below]** *(itself SUPERSEDED 2026-08-17 — the 152,969
figure was right, and the gap was the S1 defect; see CORRECTION §4)*: vscode's true chunk count is **138,440**,
read from `graph.db`'s `chunks` table after indexing. 152,969 was the CLI stdout counter,
which silently includes two files whose chunk writes failed deterministically on SQLite's
32,766-parameter INSERT ceiling (`replaceChunksForFile`, `src/store/sqliteChunkStore.ts`).
See the Q1/SCALE registration's corpus-truth-correction subsection for the full root cause
and the product-defect finding.

**vscode is 10× kluster's own index.** Every measurement in this document was taken on
a 5k–14k chunk corpus. The real target is **150k+**.

### ~~What breaks at that scale — and what doesn't~~ — **SUPERSEDED, see the CORRECTION block**

> Kept verbatim for the record. Precisely: E1 **falsified** the indexing half of "already
> sublinear" (measured `b = 1.75`); the query-side sub-claims in that same paragraph — BM25 costs
> O(matching docs), sub-ms recursive CTEs — were never tested by E1, which measured indexing only,
> and are neither confirmed nor refuted. The vector paragraph is **moot**, not falsified: Stage 7
> deleted the subsystem rather than measuring it wrong. And the "incremental is O(changed files)"
> line is **still wrong today** — see CORRECTION §5, the one item here that is not merely
> historical.

**Already sublinear, no work needed**: FTS5 is an inverted index (BM25 costs
O(matching docs), not O(total)); graph queries use covering indexes with sub-ms
recursive CTEs; incremental indexing is O(changed files) — 379 ms for one file at any
corpus size. Post-M1 chunk storage is O(N).

**The vector subsystem is the only component that degrades**, on three axes —
***MOOT: the vector store was deleted at `1522ef1` (Stage 7). Kept for the record.***

| | n8n 49.5k | backstage 89.5k | **vscode 153k** |
|---|---|---|---|
| Brute-force cosine (768-d, measured 0.955 ms/864 vec) | 55 ms | 99 ms | **169 ms** |
| Vector memory (f32) | 152 MB | 275 MB | **470 MB** |
| Embed time @ measured 5.88 chunks/s | 2.3 h | 4.2 h | **7.2 h** |

169 ms of scan against a current `mast_search` p50 of **144 ms total**.

### ~~🔴 The 7.2 h figure is an implementation artifact, not a model cost~~ — **FALSIFIED for batching (2026-08-01)**

> **Original claim (kept for the record):** `Embedder.embed()` accepts
> `chunks: readonly Chunk[]` but **loops one at a time**. Transformers.js accepts an
> **array** for batched inference; this does N separate forward passes. Compounding it:
> `dtype: 'fp32'` — no quantization — and a single forked worker (no multi-core).
> ⇒ "Q1/M2 are currently being decided against an embedder plausibly 10–20× slower than
> it should be."

**The batching component of that claim is now measured and false.**
Evidence: `eval/embedder-batching.json`; harnesses `eval/embedder-batching.mjs`
(arms E/D) and `eval/embedder-batching-lengthprobe.mjs`.

| arm (identical texts ⇒ zero padding) | speedup |
|---|---|
| batch-16 vs 16× sequential @ 64 tok | **1.09×** |
| batch-16 vs 16× sequential @ 514 tok | **1.00×** |

Per-chunk cost is flat across B=1…32. The mechanism: **`cpu/wall ≈ 5.9×` on a
`batch=1` call** (12 logical cores) — ORT's intra-op pool already saturates ~6 cores on
a single item, so batching has no parallelism left to claim. Worse, batching *adds*
failure modes: mixed-length batches pad to longest against unfused-ALiBi O(L²)
attention (a 16-chunk long batch measured ~59× slower than sequential), and a fixed
batch count with no token cap makes `[16,12,8192,8192]` fp32 ≈ **51.5 GB** reachable —
an OOM the per-chunk path structurally cannot hit.

**⇒ The batched-inference implementation was reverted** (preserved in `git stash`:
*"mast: batched-inference attempt — FALSIFIED"*). The 7.2 h vscode estimate **stands**.
It is not primarily an implementation artifact.

**Consequences:**
- **[R6] is no longer "pending a re-measure."** Its retraction of the M2 recommendation
  was predicated on fixing the embedder and re-measuring. That is done; batching was not
  the fix. R6 must be re-decided on its own merits.
- **Two levers remain live and untested**, and now carry the whole hypothesis:
  **`dtype: 'q8'` quantization** and **multi-process embedding**. Headroom for the
  latter is bounded — one process already draws ~6 of 12 cores.
- **Single-host caveat.** All of the above is Apple M2 Pro (ARM). ORT CPU kernels and
  thread-pool behaviour differ on x86 and in the SDD container; the "batch=1 already
  saturates" conclusion should be re-confirmed there before being treated as universal.

**Latent defect found while measuring, and still present:** `runEmbed`
(`indexer/index.ts:552–553`) slices pending chunks into 32-chunk windows, and
`selectPendingChunks` is a pure filter over `getAllChunks()`, so those windows preserve
**file order** — chunk lengths within a window are correlated, not random. Any future
batching attempt must account for this: a file with one large class yields adjacent long
chunks, so the pathological all-long batch arises routinely from file locality rather
than being a rare draw.

### ~~[R6] M2 recommendation RETRACTED — pending this / now un-blocked, must be re-decided~~ — **DECIDED 2026-08-06 (Stage 7): vectors deleted**

"Drop Lance, use SQLite BLOB + JS brute-force cosine" was scoped to ~14k chunks and
**inverts at the real target**: at 153k, brute force needs 169 ms and 470 MB, so an ANN
index becomes mandatory — which means Lance (has IVF-PQ, unused) or `sqlite-vec`, *not*
JS. Precedent: GitNexus caps embedding at 50k nodes by default and skips it above that.

**Status change (2026-08-01).** The retraction was explicitly "pending" a re-measure of
the embedder. That re-measure is complete and the embed cost did **not** move — batching
was falsified (see above), so the 7.2 h / 470 MB / 169 ms figures this retraction was
argued against all still hold. R6 is therefore no longer blocked on an embedder fix; it
is a live decision to be made on its own merits, against the *unchanged* numbers. The
only remaining way the inputs move is q8 and multi-process, and neither changes the
*query-side* brute-force cost (169 ms) or the *memory* cost (470 MB) that drive R6 —
they only affect build time. **R6 can be decided now.**

### Scaling levers that are NOT vectors, by leverage — **3 of 7 since falsified or moot, see CORRECTION §6**

1. **Scoping — highest leverage, already built, barely used.** `mast_project_skeleton`
   takes `directory`/`max_depth`; `mast_search` takes `file_pattern`/`chunk_type`/
   `only_exported`. A monorepo task touches 1–2 packages: scoping turns vscode into a
   5k-chunk problem, where every strategy works. Make the §12 prompt scope by default.
2. **Identifier decomposition at index time** — index `checkAuthToken` also as
   `check auth token` in a second FTS column. Makes conceptual queries hit *lexically*.
   Zero query cost, tiny index cost; best value/effort ratio here. (The zero-result
   assist already splits terms — this promotes it from fallback to first-class.)
3. **Graph expansion from lexical seeds** — a lexical hit expanded via
   `POTENTIAL_CALL`/`IMPLEMENTS`/`PARENT_OF` yields a semantic neighbourhood using
   indexes that already exist. This is what GitNexus's process-grouping does.
4. **Per-package / federated indexes** — one state dir per workspace package; query the
   relevant ones. Matches pnpm workspaces and makes reindexing parallel.
5. **Coarse-to-fine embedding** — embed only shells + top-level declarations
   (measured: `class_shell`+`function`+`interface`+`type` = 1,727 of 5,029 = **34%**),
   then use FTS/graph within the matched class. Cuts embed cost ~66%. Note
   `is_exported` filtering is NOT a useful lever — **81% of chunks are exported**.
6. **Result budgets (`maxTokens`)** — grows in value with corpus size.
7. **ANN** — only if vectors survive Q1, and only above ~50k chunks.

**The synthesis**: the subsystem costing 7.2 h to build, 470 MB to hold, and 169 ms per
query is the one whose value has *never been measured* (Q1/E4). And the live index has
been 83% unembedded — i.e. running lexical-only in practice — without anyone noticing a
quality problem.

---

### STAGE 4.5 CORRECTION — 2026-08-17, appended

Everything above from "What breaks at that scale" onward was written **before E1** (the scaling
ladder) and **before Stage 7** (the vector deletion). It reads as current guidance and is largely
not. This block records what replaced it.

**Why appended, not edited in place.** The house rule — amendments are appended, never edited —
protects *registrations*, where editing would destroy the audit trail that makes pre-registration
mean anything. Stage 4.5 is a plan stage, so the rule does not bind it automatically. It is
appended anyway, for three reasons. The stale claims are **falsified predictions**, and the
falsification is the valuable part; deleting a prediction erases the record that we predicted
wrong. This stage already models the convention twice — the inline `[Correction, 2026-08-02]` block
and the struck-through-with-original-kept 7.2 h section. And parts of the stage are **evidence**
(the S1 result table, the batching falsification with its measured arms), which must not be edited
at all. The inline markers added above are navigational — a reader who stops at a stale heading is
told to come here — and they alter no claim.

#### 1. "Already sublinear, no work needed" — FALSIFIED, then repaired

E1 measured the cold-build ladder at **`b = 1.7529`** (HC3 [1.6599, 1.8458]) — the registered
adjusted primary, per the E1 RESULT above — verdict `SUPER_LINEAR`, on nine nested subsets of n8n.
The claim was wrong when written.

The mechanism was found four experiments later: `DELETE FROM chunk_fts WHERE file_path = ?` is a
**full scan of the FTS5 table**, because `xBestIndex` cannot consume an equality constraint on an
ordinary column. E1-FTS measured that span at **91.7% of T9's write phase** with its own exponent
of **2.3454**. The guard (`1dba79b`) skips it, and E1-VERIFY re-ran the whole ladder to confirm:
**`b = 1.0825`**, HC3 [1.0651, 1.0998], `HOLDS`, T9 **538.6 s → 62.1 s**.

So the claim is true again **for cold builds** — but by repair, not because it was ever safe to
assume. See §5 for where it is still false.

#### 2. "The vector subsystem is the only component that degrades" — MOOT

The vector store was deleted at `1522ef1` (Stage 7, M2 arm D). The table of embed times, vector
memory and brute-force cosine costs describes a subsystem that no longer exists. Search is
**lexical BM25 + the declaration-exact ranker (ranker D)**.

Consequently the whole 7.2 h / 470 MB / 169 ms argument, `[R6]`, and levers 5 and 7 below are
historical. They are correct as records of what was measured; none of them is a live decision.

#### 3. The real open scaling question is `edges`, not vectors

Nothing in this stage anticipated it. After the FTS guard, `edges` is the only phase near the
super-linear bar, and it is **23.1% of the vscode build**.

- E1-PHASE scored it at **1.4360**, HC3 [1.2333, 1.6388] — the CI **straddles** the 1.35 bar, and
  E1-PHASE's own H2 did not fire because its bar was 1.6.
- **It is algorithmic, not cache.** E1-EDGES was registered to test the page-cache hypothesis and
  retired the same day: E1-AB had already run the lever with a 2× stronger arm. Across a **512×**
  cache span the T5→T9 growth ratio moves 3.287 → 3.315, and the T9 level moves ~2%, against a
  registered 1.5 bar. See § E1-EDGES AMENDMENT 1.
- **There is a knee**, visible in E1-VERIFY's nine-rung ladder: ms/edge is flat at ~0.057 through
  16.5k chunks, then climbs 3.1× over the last four rungs (.0569 → .0656 → .0764 → .1117 → .1753).

The mechanism is **unidentified**, and the phase must be instrumented before it is A/B'd again.

#### 4. The 150k target is MEASURED, and the corpus-count correction is superseded

vscode@`5ebbe53`, single cold build against the guard (`eval/results/vscode-build.json`):

**8,653 files · 152,969 chunks · 118,299 symbols · 174,844 edges · 793.8 MiB · 124,878 ms** (2.08
min), with `parse_errors` 0, **`write_errors` 0**, `fts_del` 0 ms.

This **supersedes the 2026-08-02 correction above**. That correction concluded vscode's "true"
count was 138,440 and that 152,969 was an inflated stdout counter. The stdout counter was right:
152,969 − 138,440 = **14,529 chunks exactly** — the whale-file tail that the S1 defect was dropping.
S1 fixed it; the tail is now in the database. The correction's *root cause* was sound and its
*conclusion about the true count* was not.

The loss was **loud, not silent** — the 2026-08-02 record is explicit about this (`write_errors=2`,
CLI exit code 1), and the gap it identified was narrower: orchestration that gates on exit code
alone, without also checking `write_errors`, would drop the file silently. Describing S1 as
"silently dropping" the tail, as an earlier revision of this block did, overstates the original
finding it is correcting.

Against a per-phase projection from T9: total **−9.0%**, walk −42.5%, parse −0.7%, write −28.7%,
**edges +21.7%**. Everything beats projection except edges — and most of that overshoot is edge
*density* (vscode is 1.14 edges/chunk against n8n's 0.66, a 1.73× ratio), not per-edge slowdown.

#### 5. STILL FALSE: "incremental indexing is O(changed files) — 379 ms for one file at any corpus size"

This is the one line above that is not merely historical.

**What is new here is the contradiction, not the fact.** The codebase already knew the incremental
path pays the deletes, in three committed places: `e1-fts-verdict.json`'s `what_this_is` ("it
licenses nothing about the UPDATE path, where the deletes are real work"), the CLI's refusal to
combine `--unsafe-skip-fts-deletes` with `--incremental` (`src/cli/index-cmd.ts:106`), and a test
that pins it (`src/graph/__tests__/fts-delete-guard.test.ts:93`, "runs the delete-scan for a file
that was indexed before"). None of them was connected to Stage 4.5's "O(changed files) at any
corpus size" claim, which has sat here contradicted and unmarked. That connection is the finding.

The FTS guard is conditional (`graph/populate.ts:503`):

```ts
const fileHadPreviousVersion = existing !== undefined;
if (options.skipFtsDeletes !== true && fileHadPreviousVersion) { /* the two DELETEs */ }
```

It skips the delete only for a file **never indexed before**. On a cold build every file is new, so
it skips 100% of them — which is exactly why `fts_del` is 0 ms in all 27 E1-VERIFY runs. But
**re-indexing a file that already exists still runs both full-scan DELETEs**, and that is the
defining case of incremental indexing: a changed file is by definition one we have already seen.

The full-scan cost grows with total corpus size, so per-changed-file incremental cost is **O(corpus),
not O(changed files)** — precisely the claim above. The scan mechanism is *measured* (E1-FTS,
exponent 2.3454); its persistence on the incremental path is a *code read*; its magnitude at 150k
is **unmeasured**. The 379 ms figure carries no citation anywhere in this document, and no eval
harness measures incremental re-index cost at all.

There is a second, smaller instance on the same path: `removeDeletedFiles`
(`graph/populate.ts:1116`, deletes at `:1129-1130`) runs the same two full-scan FTS deletes per
*deleted* file, unconditionally. It must stay — `chunk_fts` / `identifier_fts` are FTS5 virtual
tables and do not participate in the foreign-key cascade — but it carries the same per-corpus cost.

**This is not a defect report and no fix is proposed here** — the ladder is cold-build-only by
construction and structurally cannot see this. It is registered as an open question so that
E1-VERIFY's `fts_del = 0` is not read as evidence that incremental is fixed. It is evidence that a
cold build has no existing files.

#### 6. The seven scaling levers, re-scored

| # | lever | status |
|---|---|---|
| 1 | Scoping | **Live, unchanged** — still the highest-leverage item here |
| 2 | Identifier decomposition at index time | **FALSIFIED** — Q1/RESERVE measured it **HARMFUL**, not neutral; the stop rule fired. Q1/RESERVE-2 found the shipped TRIGRAM tokenizer was doing the work instead. |
| 3 | Graph expansion from lexical seeds | Live, untested |
| 4 | Per-package / federated indexes | Live, untested |
| 5 | Coarse-to-fine embedding | **MOOT** — no embeddings |
| 6 | Result budgets (`maxTokens`) | Live, unchanged |
| 7 | ANN | **MOOT** — "only if vectors survive Q1"; they did not |

The gap lever 2 was meant to close was instead closed by the **declaration-exact ranker** (Q1/DECLEX
— "GAP CLOSED", the S-ident scale caveat **DISCHARGED**). The fusion alternative, Q1/IDFUSE, scored
`INERT-LEVER`.

#### 7. Where this is consolidated

All of the above, plus every other settled finding and refuted hypothesis, is indexed in
**`packages/mast/FINDINGS.md`**. Per `.claude/CLAUDE.md`, that file must be read before any new
pre-registration is written — §1 (data recorded but never scored) and §3 (dead hypotheses).

---

