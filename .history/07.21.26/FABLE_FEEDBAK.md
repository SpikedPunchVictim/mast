# MAST — Fable Feedback & Recommended Betterments

> Source: Fable 5 review session, 2026-07-03. Basis: full read of `MAST_SPEC.md`
> (all 2,071 lines), a scan of the implemented source tree under `src/`, and live
> usage of the MCP tools against this repo's index (1,503 files / 11,142 chunks,
> hybrid mode, 26 stale files at session start).
>
> Overall assessment: the implementation is mature and tracks the spec closely —
> all ten MCP tools exist, the extractor/graph/locking paths are tested, and there
> are no TODO markers in the source. These tasks are therefore not "finish the
> spec" work; they sand down the friction points an agent actually hits in use.
> Ranked by leverage.

---

## Task 1 — Zero-result assist in `mast_search`

**Status:** Approved.

**Priority:** Highest. **Effort:** ~1 day.

**Why this matters:** The repo's `CLAUDE.md` has to instruct agents *"When a query
returns nothing, change vocabulary — don't repeat it"* — that rule exists because
dead-end queries are a real, observed failure mode, and it is currently mitigated
in the prompt instead of fixed in the tool. An agent that strikes out twice tends
to fall back to `Grep`/`Read`, which is exactly the token-expensive behavior MAST
exists to prevent. Handling the miss server-side (relaxed retry + "did you mean"
candidates) converts a dead end into a redirect and saves at least one full agent
round-trip per miss — and misses compound across a task.

**Behavior:** When hybrid/lexical search returns 0 results (or all results fall
below `similarity_threshold`), the tool automatically: (a) splits camelCase /
snake_case query terms and retries FTS, (b) runs an `identifier_fts` near-miss
pass, and (c) returns a `suggestions: [{ symbol, file_path, reason }]` field with
close symbol names (trigram similarity against the `symbols` table). The response
remains `results: []` — suggestions are advisory, never silently substituted.

**Files to update:**
- `src/mcp/tools/search.ts` — response shape (`suggestions` field), zod schema
- `src/search/hybrid.ts` — relaxation/retry orchestration on empty result set
- `src/search/fts.ts` — identifier near-miss query against `identifier_fts`
- `src/graph/queries.ts` — trigram-similarity symbol-name lookup
- `src/ast/types.ts` — `SearchResponse` type
- `src/search/__tests__/search.test.ts`, `src/mcp/tools/__tests__/tools.test.ts` — tests
- `MAST_SPEC.md` §9 `mast_search` — document the new field and trigger conditions

---

## Task 2 — Index markdown documents

**Status:** Approved.

> Implementation note: shipping markdown as a second extractor exposed that the
> old `LanguageExtractor` interface (tree-sitter `Tree` parameter, chunks-only
> return) forced language if-cases into extract.ts, populate.ts, and the
> indexer. Per constitution §4 (the second implementation defines the
> contract), the interface was widened inside this task: `extract(src,
> filePath, mtime, options) → { language, chunks, symbols, imports, edges,
> identifierRows }`, with parsing internal to each extractor. This also removed
> a pre-existing leak — populate.ts calling the TS-specific `extractIdentifiers`
> on every chunk regardless of language. See MAST_SPEC.md §13.4.

**Priority:** High — biggest payoff for the SDD pipeline. **Effort:** ~2–3 days.

**Why this matters:** MAST only indexes `.ts/.tsx/.js/.jsx`, but a large share of
this repo's knowledge lives in `.md` files — `ARCHITECTURE_V3.md`, the
`IMPLEMENTATION_PLAN.md` files, `MAST_SPEC.md` itself, the fold/sdd design docs.
For the SDD pipeline specifically, specs and plans are *inputs to every task*, so
making them semantically searchable is likely worth more tokens than any remaining
code-side optimization. The `LanguageExtractor` interface (§13.4) was explicitly
designed for this kind of addition, and prose is well within the Jina code model's
training distribution, so the change drops into the existing pipeline.

**Behavior:** New extractor chunks markdown by heading — one chunk per `##`
section (configurable depth), `chunk_type: "doc"`, heading path as `symbol_name`
(e.g. `MAST_SPEC.md > 7. Index Lifecycle > 7.3 Hybrid Search`). Doc chunks get
embeddings + FTS rows but no graph symbols/edges.

**Files to update:**
- `src/ast/extractors/markdown.ts` — **new**: heading-based `LanguageExtractor`
- `src/ast/extract.ts` — dispatch `.md` to the new extractor
- `src/ast/types.ts` — add `"doc"` to the `chunk_type` union
- `src/store/config.ts` — add `.md` to default `file_extensions`
- `src/graph/populate.ts` — verify doc chunks (no symbols/imports) pass through gracefully; still write `chunk_fts` rows
- `src/mcp/tools/search.ts` — extend `chunk_type` enum in the zod schema
- `src/ast/extractors/__tests__/markdown.test.ts` — **new**: extractor tests + fixtures
- `MAST_SPEC.md` §10.1, §13.4 — document the doc chunking strategy
- Note: `exclude_patterns` in existing `.mast/config.json` state dirs may need `node_modules/**` re-checked for vendored `.md` noise (READMEs in dependencies) — decide index-time policy before shipping.

---

## Task 3 — Make `mast_status` explain *why* the index isn't fresh

**Status:** Approved.

**Priority:** Medium-high. **Effort:** ~1 day.

**Why this matters:** `mast_status` currently reports `stale_files: 26,
index_fresh: false`, which conflates two very different states: Phase 1 staleness
(chunk line coordinates lag disk — corrected by JIT on read) versus Phase 2
backlog (parsing is current but embeddings lag, so semantic ranking is degraded).
The spec positions `mast_status` as *the* diagnostic tool an agent reaches for
when search results look wrong (§9), so an ambiguous freshness signal undermines
its entire purpose. A `pending_embeddings` count plus a `freshness_cause` field
makes "why does search feel off?" self-diagnosable without opening
`file_manifest.json` by hand.

**Behavior:** Add to `StatusResult`: `pending_embeddings: <n>` (chunks in
`chunks.lance` with no matching `content_hash` in `vectors.lance`) and
`freshness_cause: "phase1_stale" | "embedding_backlog" | "both" | null`.

**Files to update:**
- `src/mcp/tools/status.ts` — compute + expose the new fields
- `src/cli/status.ts` — print the new fields in human + `--json` output
- `src/store/lance.ts` — query helper: count chunks lacking a current vector
- `src/ast/types.ts` — `StatusResult` type
- `src/mcp/tools/__tests__/tools.test.ts`, `src/cli/__tests__/cli.test.ts` — tests
- `MAST_SPEC.md` §8 `mast status`, §9 `mast_status` — document the new fields

---

## Task 4 — Collapse shell/method duplicates in search results

**Status:** Approved.

**Priority:** Medium. **Effort:** ~1 day.

**Why this matters:** Class decomposition (§10.1) means one query can return both
`AuthService.validateSession` (method chunk) and `AuthService` (class shell) whose
synthesized outline repeats the same signature — the agent pays twice for one
fact. Grouping child hits under their `parent_symbol`, or suppressing the shell
when one of its methods already ranks higher, returns strictly fewer tokens for
the same information. "Chunks not files → fewer tokens" is the product thesis
(§14); this is that thesis applied to MAST's own output.

**Behavior:** Post-RRF pass: when a `method` chunk and its parent `class_shell`
both appear in the top `limit`, keep the higher-ranked one and attach a
`related: { parent_symbol | methods_matched }` hint to it. Purely a presentation
change — ranking math is untouched.

**Files to update:**
- `src/search/hybrid.ts` — post-RRF grouping/suppression pass
- `src/mcp/tools/search.ts` — response shape (`related` hint)
- `src/ast/types.ts` — `SearchResponse` type
- `src/search/__tests__/search.test.ts` — tests (shell+method collision fixture)
- `MAST_SPEC.md` §9 `mast_search` — document the dedup rule

---

## Task 5 — Honest tokenizer labeling in telemetry

**Status:** Approved.

**Priority:** Medium (labeling fix, not a rewrite). **Effort:** ~half day.

**Why this matters:** §14.5 calls `@anthropic-ai/tokenizer` "ground truth," but
that package (`^0.0.4`) implements the Claude 2-era tokenizer — Anthropic never
published the Claude 3+ vocabulary, so counts drift for every model that actually
consumes MAST output today. The telemetry section is admirably honest about the
counterfactual being an upper bound (§14.2), and the tokenizer deserves the same
honesty, because the defensibility of the savings number is the whole point of
§14. The savings *ratio* mostly cancels the per-count error, so relabeling as
approximate preserves the thesis while surviving scrutiny.

**Behavior:** Report `tokenizer: "@anthropic-ai/tokenizer (claude-2 era,
approximate for current models)"` in `mast_efficiency` output and the
`mast metrics` footer. Optionally support the API `count_tokens` endpoint as an
opt-in exact mode where an API key is available.

**Files to update:**
- `src/telemetry/tokenizer.ts` — label constant; optional exact-mode hook
- `src/telemetry/metrics.ts` — carry label through aggregates
- `src/mcp/tools/efficiency.ts` — output field
- `src/cli/metrics-cmd.ts` — footer text
- `src/telemetry/__tests__/metrics.test.ts` — tests
- `MAST_SPEC.md` §14.5 — replace the "ground truth" claim with the approximate framing

---

## Task 6 — Optional `--watch` mode for interactive (non-container) use

**Status:** Approved.

**Priority:** Medium-low (quality-of-life; correctness already covered by JIT). **Effort:** ~1–2 days.

**Why this matters:** The spec's no-daemon stance (§3) is right for the SDD
container, where the startup ladder (§7.4) covers freshness — but local
interactive development has no equivalent hook: git hooks are opt-in and only
fire on commit/checkout, which is exactly why this session started with 26 stale
files. JIT re-parse guarantees line-coordinate correctness, so this is purely a
semantic-ranking-quality improvement — the difference between `mode: "hybrid"`
meaning "current" versus "current as of last reindex." Scoped as an opt-in flag,
it doesn't reopen the daemon non-goal for the pipeline.

**Behavior:** `mast serve --watch` starts a chokidar watcher over
`file_extensions` (respecting `exclude_patterns`), debounces (~500ms), and feeds
changed paths through the existing incremental Phase 1 + background embedder,
acquiring `structure.lock`/`vectors.lock` exactly as `mast_reindex` does.

**Files to update:**
- `src/indexer/watcher.ts` — **new**: chokidar watcher + debounce
- `src/cli/serve.ts` — `--watch` flag
- `src/mcp/startup.ts` — wire watcher into serve lifecycle (after Step 4 kickoff)
- `src/mcp/server.ts` — clean shutdown of the watcher
- `package.json` — add `chokidar` dependency
- `src/indexer/__tests__/watcher.test.ts` — **new**: debounce + lock-contention tests
- `MAST_SPEC.md` §3 (non-goals caveat), §8 `mast serve`, §11 — document the flag

---

## Task 7 — `mast_rename_impact` composed tool

**Status:** Approved.

**Priority:** Medium (promoted from note N2). **Effort:** ~1–2 days.

**Why this matters:** The verified/potential split in `mast_callers` (§10.3) is
the right contract, but agents doing a rename must manually stitch together
callers + potential matches + re-export chains. A single composed tool returning
all three as an explicit refactor checklist ("N verified sites, M review-required
sites, K barrel exports to update") packages the existing data into the workflow
agents actually run.

> Implementation note: N2 assumed a "re-export chain walk" existed to reuse —
> it did not. `RE_EXPORTS` edges and `re_export_files` were schema-only (§6.3
> described them; nothing ever wrote them), and `export … from` statements
> produced no chunks, symbols, or imports. Delivering the `barrel_exports`
> section therefore required closing that extraction gap minimally: named
> re-exports now emit marker symbols (kind `export`, excluded from symbol
> lookups) + RE_EXPORTS edges through the existing symbols/edges pipeline, and
> `export *` emits `re_export_files` rows in the existing pass-2 insert. The
> same §13.7 resolver is reused — no new resolution heuristics.

**Behavior:** `mast_rename_impact { symbol, file_path? }` returns
`declaration_sites` (symbols table), `verified_callers` (direct POTENTIAL_CALL
edges — no `transitive` option in v1), `potential_matches` (identifier_fts, the
shared mast_callers implementation, framed as mandatory review sites),
`barrel_exports` (RE_EXPORTS edges + recursive `re_export_files` star chain),
and a `summary` with per-category counts plus a checklist sentence.

**Files updated:**
- `src/mcp/tools/rename-impact.ts` — **new**: the composed tool
- `src/mcp/server.ts` — registration
- `src/graph/queries.ts` — `queryBarrelExports`; `querySymbolByName` excludes marker rows
- `src/ast/extractors/typescript.ts` — `extractReExports` + marker symbols/edges
- `src/ast/extractor.ts` — `starReExports` on `FileExtraction`
- `src/graph/populate.ts` — `insertReExportFiles`; edge to-resolution skips markers
- `src/indexer/index.ts` — pass-2 star re-export insertion
- `src/mcp/tools/_helpers.ts` — shared `collectPotentialMatches` (reused by mast_callers)
- `src/ast/extractors/__tests__/re-export.test.ts` — **new**; `src/mcp/tools/__tests__/tools.test.ts` — tool tests
- `MAST_SPEC.md` §7.4/§9.0 tool lists, §9 new tool section, §10.1 re-export note
- `packages/workbench/sdd/fold-runner/entrypoint.mjs` + task-pipeline prompts — allowlist + usage examples

---

## Task 8 — NodeNext `.js` specifier resolution

**Status:** Approved.

**Priority:** Medium (promoted from note N3). **Effort:** ~half day.

**Why this matters:** The §13.7 path resolver probes relative specifiers against real
files, but NodeNext/ESM TypeScript writes the *compiled* extension in the specifier —
`import { Repo } from './repo.js'` — while the on-disk source is `./repo.ts`. The probe
had no `.js`→`.ts` substitution, so every such import left `imports.resolved_path` NULL,
and `export *` barrels written with `.js` specifiers produced no `re_export_files` rows
(directly weakening `mast_rename_impact`'s `barrel_exports` section from Task 7). This is
invisible in a repo that omits extensions but breaks the moment a package sets
`"moduleResolution": "NodeNext"` and writes conformant specifiers.

**Behavior:** When a relative specifier carries a JS-family extension, the resolver looks
up the TypeScript source first and falls back to the literal file, matching tsc's "file
extension substitution" order (verified against the TypeScript Modules Reference via
context7): `.js`→`.ts`,`.tsx`,`.js`; `.jsx`→`.tsx`,`.jsx`; `.mjs`→`.mts`,`.mjs`;
`.cjs`→`.cts`,`.cjs`. **Precedence is source-first**: when both `x.ts` and a real `x.js`
exist, `./x.js` resolves to `x.ts` (the `.js` names the output), per tsc. A genuine `.js`
with no `.ts` source still resolves to itself. `.d.ts` is out of scope (MAST indexes
implementation files).

> Placement note: the remap lives in `import-resolver.ts` (not the TS extractor). The
> resolver is already a JS/TS-module-resolution component consumed only by
> `typescript.ts`; it owns `CANDIDATE_EXTS`, tsconfig aliases, workspace packages, and
> `index.*` probing. NodeNext extension substitution is the same class of rule and is
> cohesive there. The extractor keeps emitting the raw specifier and delegating — the
> parse/resolve boundary is preserved. (The one pre-existing smell is that the resolver
> is *named* as if generic; an optional follow-up is to rename it to signal JS/TS scope.)

**Files updated:**
- `src/indexer/import-resolver.ts` — `JS_TO_TS_EXTS` table + source-first probe branch
- `src/indexer/__tests__/import-resolver.test.ts` — 5 cases (`.js`→`.ts`/`.tsx`,
  `.mjs`→`.mts`, `.cjs`→`.cts`, real-`.js` fallback, both-exist precedence)
- `src/ast/extractors/__tests__/re-export.test.ts` — `.js`-specifier star barrel resolves
- `MAST_SPEC.md` §13.7 — new "NodeNext `.js` specifier substitution" subsection

**Verification:** `pnpm typecheck` clean; `pnpm test` 273/273 (was 267; +5 resolver, +1
re-export); `pnpm lint` clean.

---

## Task 9 — Replace the absolute cosine gate with rank-based vector inclusion

**Status:** Implemented, pending approval.

**Priority:** High (promoted from N1 bake-off supplementary finding 1 — the
highest-leverage finding of the run). **Effort:** ~half day + eval validation.

**Why this matters:** The shipped `similarity_threshold: 0.70` gated vector
results by absolute cosine before RRF, but 0/28 gold-set conceptual queries
produce a jina cosine ≥ 0.70 — shipped hybrid search silently collapsed to
lexical-only on exactly the query class the vector layer exists for (measured:
hybrid NDCG@10 0.000 gated vs 0.580 ungated on the frozen gold set). Absolute
cosine scales are also model-specific (gemma clears 0.70 on 11/28 queries, SFR
on 4/28, gte on 0/28), so the gate would break differently under any future
model swap.

**Behavior:** All top-pool vector candidates (4× `limit` per ranker, §7.3) feed
RRF by rank; `mode: "hybrid"` whenever the vector store returns hits. **No
cosine floor replaces the gate** — evidence, not vibes: measured top-1 cosines
for relevant gold queries (0.399–0.664, median 0.571) *interleave* with top-1
cosines for deliberately nonsensical junk queries (0.411–0.537, median 0.502),
so no absolute cutoff separates relevant from junk on this model; any
junk-rejecting floor would also reject roughly half the gold queries
(`eval/results/task9-score-before.json > cosineEvidence`). `similarity_score`
stays in results as advisory confidence. The `similarity_threshold` config key
is **removed** (never-shipped stance — no back-compat, no replacement knob).
Task 1 interaction: the zero-result assist still triggers on empty results; a
warm hybrid index now rarely empties (vector neighbors ARE the answer to
near-miss queries), so the assist naturally scopes to lexical mode, cold/empty
indexes, and post-filter-emptied sets.

**Measured validation** (`eval/score-only.mjs`, frozen gold set, incumbent,
no re-embedding — before/after JSONs in `eval/results/`):

| Variant | NDCG@10 | Recall@10 | MRR |
| --- | --: | --: | --: |
| Before (shipped `similarity_threshold: 0.70`) | 0.000 | 0.000 | 0.000 |
| **After (rank-based inclusion)** | **0.5795** | **0.7083** | **0.5813** |

The after numbers match the bake-off's `hyb θ=0` reference (0.580) exactly —
the change recovers the full vector contribution with no regression against
the ungated ceiling.

**Files updated:**
- `src/search/hybrid.ts` — gate removed; rank-based inclusion + evidence why-comment; `HybridSearchConfig` loses `similarity_threshold`
- `src/ast/types.ts` + `src/store/config.ts` — config key removed (tombstone comment)
- `src/mcp/tools/search.ts` — call-site config
- `src/search/vector.ts` — `score` TSDoc: advisory, never gates
- `src/search/__tests__/search.test.ts` — configs updated; new rank-based-inclusion describe (vector-only hybrid results, sub-0.70 inclusion, Task 1 interaction)
- `eval/score-only.mjs` — **new**: score-only before/after harness + cosine evidence; `eval/results/task9-score-{before,after}.json`; `eval/README.md` note
- `MAST_SPEC.md` §4.1 (key removed + rationale), §7.3 (rank-based inclusion + both findings), §9 (mode discriminator, advisory `similarity_score`, zero-result trigger rewording)

---

## Smaller notes (not yet scoped as tasks)

### N1 — Embedding model re-evaluation (research task)

**Status: Approved — keep the incumbent.** See "N1 bake-off results
(run 2026-07-10)" below. No model was switched. The bake-off's supplementary
finding 1 (the miscalibrated `similarity_threshold` gate) was promoted to
Task 9 and implemented.

`jinaai/jina-embeddings-v2-base-code` is a 2023-era model; three years is a long
time in embedding land, and the model choice bounds hybrid-search quality more
than any ranking tweak. Per the research protocol (repo `CLAUDE.md` §6), no
specific successor should be claimed better without a benchmark run — the task is
to build a small retrieval eval (20–30 known query→chunk pairs from this repo)
and score candidate ONNX-runnable code embedders against the incumbent.
Touches: `MAST_SPEC.md` §7.2/§13.3 (record findings), `src/indexer/embedder.ts`
+ `src/store/config.ts` (only if a switch wins; schema version bump per §7.4
since vectors are invalidated).

A researched candidate list for the bake-off was produced 2026-07-09 — see
"### N1 candidate models" below. It narrows the field to ONNX-runnable code
retrievers; it does **not** pick a winner (that requires the eval run above).

#### N1 candidate models (researched 2026-07-09)

Hard constraints applied: must run locally in Node via `@huggingface/transformers`
(Transformers.js) with ONNX weights on the HF Hub or trivially convertible; no
API-only models; ≤1.5B params (prefer ≤600M); code-retrieval-relevant. ONNX
presence was verified against the HF API file listing (`/api/models/<id>`,
checked 2026-07-09); dims/context from each repo's `config.json`. **Incumbent:**
`jinaai/jina-embeddings-v2-base-code` — 161M, 768 dims, 8192 ctx, Apache-2.0,
`JinaBertForMaskedLM`, ONNX on Hub (runs today).

CoIR citations: Qodo blog (qodo.ai/blog/qodo-embed-1-code-embedding-code-retrieval),
CodeXEmbed/SFR paper (arxiv 2411.12644), CoIR benchmark (ACL 2025, github.com/CoIR-team/coir).

| Model | Params | Dims | Ctx | ONNX on Hub | License | Code evidence | Why it might beat incumbent / main risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Alibaba-NLP/gte-modernbert-base** | ~149M | 768 | 8192 | **Yes** (full quant set, main repo) | Apache-2.0 | Strong MTEB/CoIR for size; ModernBERT backbone tuned for code+text | Drop-in size/dims/ctx match to incumbent, permissive license, modern backbone. Risk: general (not code-specialized) — gain may be modest. |
| **Salesforce/SFR-Embedding-Code-400M_R** | ~400M | (see repo) | 8192 | **Yes** (full quant set, main repo) | **CC-BY-NC-4.0** | CoIR 61.9 NDCG@10 (400M variant); CodeXEmbed family, #1 CoIR at release | Purpose-built code retriever, ONNX already published. Risk: **non-commercial license** blocks production unless cleared; 400M is 2.5× incumbent compute. |
| **onnx-community/embeddinggemma-300m-ONNX** | 300M | 768 (MRL 512/256/128) | 2048 | **Yes** (official Transformers.js example) | Gemma (terms) | 2025 SoTA-for-size (MTEB 69.67 EN); "Code Retrieval" a documented task | Modern, on-device-tuned, Matryoshka dims. Risk: **2048 ctx is a downgrade** from 8k (long chunks truncate); code eval not code-specialized; Gemma license terms. |
| **nomic-ai/CodeRankEmbed** | 137M | 768 | 8192 | **No** (needs conversion; Nomic-BERT, feasible) | **MIT** | CoIR 60.1 NDCG@10; code-specialized retriever | Ideal profile — tiny, permissive (MIT), code-specific, 8k ctx — *if* ONNX export succeeds. Risk: conversion unproven for Transformers.js; verify before committing. |
| Qodo/Qodo-Embed-1-1.5B | 1.5B | 1536 | 32768 | No (no onnx-community mirror; convert) | RAIL-M ("other") | **CoIR 68.53** — best open score at ≤1.5B | Highest measured code-retrieval ceiling. Risk: 1.5B pushes the size budget; ONNX conversion + RAIL license review both required. Reference/ceiling only. |
| jinaai/jina-embeddings-v3 | ~572M | 1024 | 8194 | Yes (main repo) | CC-BY-NC-4.0 | General retrieval SoTA; task-LoRA adapters | Newer Jina, ONNX ready. Risk: general text (not code); NC license; larger dims raise index size. |
| jinaai/jina-code-embeddings-0.5b / 1.5b | 0.5B / 1.5B | — | — | No | CC-BY-NC-4.0 | 2025 code-specific Jina (successor line to incumbent) | Direct code successor to the incumbent family. Risk: **no ONNX** on Hub and **NC license** — double blocker; watch for a permissive/ONNX release. |
| Snowflake/snowflake-arctic-embed-m-v2.0 | ~305M | 768 | 8192 | Yes (full quant set) | Apache-2.0 | Strong MTEB multilingual retrieval | Permissive, ONNX-ready, 8k. Risk: general/multilingual, not code-tuned. |
| BAAI/bge-m3 | ~568M | 1024 | 8194 | Yes (main repo) | MIT | Strong general multilingual retrieval (dense/sparse/colbert) | Permissive, battle-tested, ONNX-ready. Risk: general not code; 1024 dims + 568M heavier than incumbent. |

**Recommended finalists for the bake-off (run the 20–30 pair eval against the incumbent):**

1. **Alibaba-NLP/gte-modernbert-base** — lowest-risk upgrade: Apache-2.0, ONNX
   on Hub today, exact size/dims/8k-ctx match to the incumbent, modern backbone.
   If it wins even marginally it's a clean, licensable swap.
2. **Salesforce/SFR-Embedding-Code-400M_R** — the best code-*specialized* retriever
   with ONNX already published (CoIR 61.9); measures the code-specific ceiling.
   Carry it through the eval but flag the **CC-BY-NC-4.0** license as a hard
   production gate to resolve before adoption.
3. **onnx-community/embeddinggemma-300m-ONNX** — a 2025 SoTA-for-size Google model
   that runs in Transformers.js today; the 2048-ctx cap is the key thing the eval
   must stress (does chunk truncation cost recall on this repo's larger chunks?).
4. **nomic-ai/CodeRankEmbed** — the ideal profile (137M, MIT, code-specific, 8k) if
   ONNX conversion lands; spend the first hour confirming a working Transformers.js
   export, and drop it if conversion is not clean.

Optionally include **Qodo-Embed-1-1.5B** as a non-shipping *ceiling reference* (best
CoIR score) to know how much headroom exists above the shippable finalists; do not
plan to adopt it without clearing size, ONNX conversion, and RAIL-license review.

Rationale: the finalists span the two axes that matter — permissive-and-drop-in
(gte-modernbert) vs. code-specialized-but-encumbered (SFR-Code, CodeRankEmbed) —
plus a modern generalist (embeddingGemma) to test whether 2025 general models have
closed the gap on code without the license friction. The incumbent stays the
control. **Uncertainty stated plainly:** ONNX presence was verified from Hub file
listings, but Transformers.js runtime compatibility (op coverage, pooling/prompt
handling) is *not* proven for any candidate until it embeds real chunks in the
harness — CodeRankEmbed and Qodo have no published ONNX at all and may not convert
cleanly. Exact param counts for SFR-Code/gte-modernbert are approximate (repos state
size loosely); confirm from the safetensors index if it affects the size budget.

**Excluded — API-only (cannot run locally in Node):** `voyage-code-3` (Voyage AI),
OpenAI `text-embedding-3-large`, Cohere `embed-*`. Frequently top code leaderboards
but disqualified by the local-ONNX constraint; listed only for benchmark context.
**Excluded — too large / no ONNX:** `nomic-ai/nomic-embed-code` (7B), Qodo-Embed-1-7B.

#### N1 evaluation rubric

A model swap touches more than result quality — dims drive `vectors.lance` size,
weights drive container RAM and §13.8 pre-warm time, and any winner pays a §7.4
schema bump (full re-embed). "Highest NDCG wins" is therefore not the decision
rule. The bake-off scores candidates as follows.

**Gating constraints (pass/fail, not scored).** Applied before any scoring — a
model failing any of these is out regardless of quality:
- Runs in Node via `@huggingface/transformers` on ONNX weights (proven by
  embedding real chunks in the harness, not by Hub file listing alone).
- ≤1.5B params (prefer ≤600M).
- License usable in production (this is why SFR-Code's CC-BY-NC and Qodo's
  RAIL-M are adoption blockers, even though both may run in the eval as
  reference points).

**Scored axes.** Weights are proposed defaults, not gospel — the bake-off report
should revisit them if the results expose a different tradeoff surface:

| Axis | Metric | Why it matters in MAST | Weight |
| --- | --- | --- | --- |
| Retrieval quality | NDCG@10 + Recall@10 + MRR on the gold set | The whole reason to switch | ~50% |
| Query latency | ms to embed one short query | Hot path of every `mast_search`; an agent waits on it per call | ~15% |
| Index throughput | chunks/sec batch-embedding this repo (~11k chunks) | Drives reindex and Dockerfile pre-warm (§13.8); amortized, not per-call | ~10% |
| Vector storage / dims | dims → `vectors.lance` size + ANN/RRF cost | Incumbent is 768; a 1024/1536 model inflates the index ~1.3–2× | ~10% |
| Model footprint | weights RAM + download size | SDD container budget; 400M/1.5B is a bigger pre-warm than the 161M incumbent | ~10% |
| Quantization robustness | quality delta int8/q4 vs fp32 | MAST ships *quantized* ONNX in Node — the number that ships is the quantized one, not the fp32 leaderboard score | ~5% |

**Methodology (two rules that keep the quality number honest):**

1. **Score hybrid end-to-end, not just cosine.** MAST's shipped metric is the
   hybrid result (FTS + vector + RRF), so measure both pure-vector (isolates the
   model) and full-hybrid (measures shipped impact). A better vector model can be
   washed out where FTS already nails the query — and only shines where lexical
   search fails.
2. **Draw the gold set from real misses.** The highest-value queries are the
   zero-result / near-miss cases Task 1 was built to catch; hand-picked softball
   pairs flatter every model equally and decide nothing. Seed the 20–30 pairs
   from observed dead-end queries against this repo's index.

**Decision rule — minimum meaningful improvement.** Because a switch forces a
schema-version bump and a full re-embed (§7.4), a marginal win doesn't clear the
bar. Proposed defaults (revisit in the report):
- Adopt only if hybrid NDCG@10 improves **≥3–5%** over the incumbent, AND
- query latency ≤ **1.5×** incumbent, AND
- vector index size ≤ **1.3×** incumbent — unless the quality gain is large
  enough to argue the exception explicitly.
- Matryoshka models (e.g. embeddingGemma) are additionally tested at truncated
  512/768 dims to buy quality without the storage hit.
- Ties or sub-threshold wins keep the incumbent — no churn without a payoff.

### N1 bake-off results (run 2026-07-10)

Harness: `eval/` (standalone `.mjs` scripts importing the compiled `dist/`
pipeline — real `runIndex`, real `hybridSearch`/RRF, real `LanceStore`; see
`eval/README.md` for the re-run recipe). Corpus: a fresh Phase-1 index of this
repo into a throwaway scratchpad state dir — **1,678 files / 12,853 chunks**
(`.ts/.tsx/.js/.jsx/.md`). Gold set: `eval/gold-set.json`, **28 queries / 43
verified targets**, hand-constructed to reproduce the Task-1 zero-result class
(conceptual synonym queries, near-miss vocabulary, qualified method names,
cross-file concepts) and frozen (verified against the corpus) before any model
was scored. Vector pool: a frozen 3,006-chunk subset (all gold targets + seeded
random distractors, seed 20260709) — full-corpus fp32 embedding measured ~56
min/model on this machine, which would have made the 5-model tail impractical;
the FTS side of hybrid remains full-corpus. All models scored at fp32 with the
shipped recipe (`pooling: mean`, `normalize: true`, no task prompts) — exactly
what `src/indexer/embedder.ts` would do on a naive swap.

**Ran:** incumbent, gte-modernbert-base, embeddinggemma-300m, SFR-Code-400M_R
(reference only). **Dropped:** CodeRankEmbed — gate failed per the 3-attempts
rule: (1) official repo has no ONNX (`Could not locate file .../onnx/model.onnx`);
(2) community ONNX mirrors exist (e.g. `Zenabius/CodeRankEmbed-onnx`) but are
unofficial third-party weight conversions — running untrusted converted weights
was denied and is outside the sanctioned eval path; (3) in-house conversion
needs a Python/optimum toolchain this repo doesn't carry. **Incompatible,
dropped** — revisit if nomic-ai publishes official ONNX (profile remains ideal:
137M, MIT, code-specific, 8k ctx).

#### Scored table (fp32, shipped recipe; quality = frozen gold set)

`hyb θ=0` is RRF over full-corpus FTS + subset vectors with the 0.70 similarity
gate removed; `hyb θ=.70` is the exact shipped config (see the threshold finding
below for why it zeroes). NDCG counts only the first chunk matching each target.

| Model | Role | License | dims | NDCG@10 vec | Recall@10 vec | MRR vec | NDCG@10 hyb θ=0 | NDCG@10 hyb θ=.70 | q-lat ms (med) | thru ch/s (b=32) | dl MB | RAM after load MB | proj. vec payload MB (12.8k) |
| --- | --- | --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| **jina-v2-base-code (incumbent)** | baseline | Apache-2.0 | 768 | **0.595** | **0.708** | **0.605** | **0.580** | 0.000 | **12** | 5.88 | 614 | 565 | 38 |
| SFR-Embedding-Code-400M_R | reference | **CC-BY-NC-4.0** | 1024 | 0.632 | 0.726 | 0.641 | 0.618 | 0.093 | 36 | 1.72 | 1,665 | 1,926 | 50 |
| embeddinggemma-300m | finalist | Gemma terms | 768 | 0.414 | 0.548 | 0.388 | 0.392 | 0.142 | 14 | 6.36 | 1,198 | 984 | 38 |
| gte-modernbert-base | finalist | Apache-2.0 | 768 | 0.206 | 0.250 | 0.229 | 0.190 | 0.000 | 13 | 5.80 | 572 | 1,119 | 38 |
| CodeRankEmbed | finalist | MIT | — | — | — | — | — | — | — | — | — | — | — |

#### Weighted composite (rubric weights: quality .50, latency .15, throughput .10, storage .10, footprint .10, quant .05)

Each axis is a ratio to the incumbent (capped at 3.0). Quality axis uses hybrid
θ=0 (mean of NDCG/Recall/MRR) — the discriminating hybrid number, since the
shipped 0.70 gate zeroes every model equally (see below). Weights kept at the
proposed defaults; nothing in the results argued for re-weighting — the quality
axis alone already decides the ranking, and no candidate wins any axis by enough
to flip the outcome under any sane re-weighting.

| Model | quality (.50) | latency (.15) | thru (.10) | storage (.10) | footprint (.10) | **composite** |
| --- | --: | --: | --: | --: | --: | --: |
| **jina-v2-base-code (incumbent)** | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | **1.000** |
| embeddinggemma-300m | 0.69 | 0.86 | 1.08 | 1.00 | 0.51 | 0.784 |
| SFR-Embedding-Code-400M_R | 1.05 | 0.33 | 0.29 | 0.75 | 0.37 | 0.766 |
| gte-modernbert-base | 0.34 | 0.92 | 0.99 | 1.00 | 1.07 | 0.664 |

#### embeddinggemma 2048-ctx truncation analysis

Measured with embeddinggemma's own tokenizer (`eval/truncation-analysis.mjs`):
**1 of 44 gold-target chunks** exceeds 2048 tokens (q19, an ~11k-char plan-doc
chunk at 3,012 tokens; median gold target is 174 tokens); 0.53% of the 3,006-chunk
subset and 0.40% of a ¼ corpus sample truncate (corpus max: 15,941 tokens).
**The 2048 cap is a near non-issue on this corpus** — MAST's chunking (§10.1)
keeps chunks far below it — and embeddinggemma actually scored 1.0 NDCG on q19
(the truncating query) because the doc's opening tokens carry the signal. Its
loss to the incumbent (0.414 vs 0.595 pure-vector) is distributed across
ordinary code queries, not concentrated in long chunks; ctx is not the reason
to reject it.

#### Supplementary findings (change how the next bake-off should be read)

1. **The shipped `similarity_threshold: 0.70` is miscalibrated for the incumbent
   on conceptual queries — the highest-leverage finding of the run.** 0/28 gold
   queries produced a jina cosine ≥ 0.70, so shipped hybrid discards the entire
   vector side and collapses to lexical (NDCG 0 on this gold set, whose queries
   are built to defeat lexical matching) — on exactly the query class embeddings
   exist to serve. Cosine scales are also model-specific (gemma clears 0.70 on
   11/28, SFR on 4/28, gte on 0/28), so any model swap without threshold
   recalibration changes behavior unpredictably — an unbudgeted cost on top of
   the §7.4 re-embed. Recommend a follow-up task: recalibrate the vector gate
   (or replace the absolute-cosine gate with rank-based inclusion) independent
   of any model decision.
2. **Recipe sensitivity is large; MAST's hardcoded mean-pool is a hidden
   compatibility constraint.** Probes under each model's recommended recipe
   (`eval/run-recipe.mjs`, pure-vector): gte-modernbert with CLS pooling scores
   **0.496 vs 0.206** mean-pooled (the shipped path silently costs it ~2.4×);
   embeddinggemma with its documented query/document prompts scores **0.623 vs
   0.414** — pulling roughly even with the incumbent (0.595), still short of the
   +3–5% adoption bar and requiring prompt+pooling plumbing in `embedder.ts`
   that doesn't exist today. Any future bake-off (and any swap) must treat
   pooling/prompt as part of the model contract.
3. **Quantization is essentially free on the modern backbone.** gte-modernbert
   q8: quality flat (pure-vector 0.207 vs 0.206 fp32; hyb θ=0 0.195 vs 0.190),
   query latency halved (7ms vs 13ms), throughput ~1.9× (10.7 vs 5.8 ch/s).
   If container pre-warm (§13.8) or CPU budget ever pinches, shipping a
   quantized dtype is a cheap lever — worth a probe on the incumbent's own ONNX.

#### Recommendation (decision rule applied)

**Keep the incumbent — no switch.** Applying the rubric's minimum-meaningful-
improvement rule to hybrid NDCG@10 (θ=0): gte-modernbert −67% and
embeddinggemma −32% are nowhere near the +3–5% floor (embeddinggemma reaches
parity only under a prompt recipe MAST doesn't implement, and parity is not a
payoff). SFR-Code-400M_R is the only model that beats the incumbent (+6.6%
hybrid, +6.2% pure-vector) — it confirms code-specialization is what buys
quality here (both generalists lost badly) — but it fails the license gating
constraint outright (CC-BY-NC-4.0), fails the latency rule at 3.0× (36ms vs
12ms), runs 0.29× throughput, and inflates vectors ~1.33× (1024 dims), so even
license clearance wouldn't make it a clean adopt. The 2023-era incumbent
remains the best shippable code embedder in the ONNX/Transformers.js field it
competed in; the field's code-specialized successors (jina-code-v2 line,
CodeRankEmbed, Qodo) are all blocked on license or missing ONNX, not on
quality. Re-run this bake-off when one of those publishes permissive official
ONNX — and land the threshold-recalibration follow-up (finding 1) first, since
it costs nothing and recovers more shipped-search quality than any available
model swap.

**Caveats that bound the conclusion:** the gold set is hand-built (no production
miss-log exists yet) and 28 queries separate tiers, not near-ties — the
incumbent-vs-SFR gap (+6%) is within the set's resolution, but the finalists'
losses (−32%/−67%) are not; the vector pool was a 3,006-chunk frozen subset
(43 gold needles vs ~2,960 distractors), so absolute NDCG values are easier
than full-corpus but model *ranking* is unaffected (identical pool per model);
throughput/latency are single-machine CPU numbers (Apple Silicon, wasm/onnx
CPU EP) — container numbers will differ in scale but not in ordering.

### N2 — `mast_rename_impact` composed tool
Promoted to Task 7 above.

### N3 — NodeNext `.js` specifier resolution
Promoted to Task 8 above.
