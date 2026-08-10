# MAST Implementation Plan

## Stage 1: Scaffold — Package structure, types, config
**Goal**: Compilable package skeleton — all source files with correct signatures, no implementations.
**Success Criteria**: `tsc --noEmit` passes across all scaffold files.
**Status**: Complete

Files:
- `package.json` — dependencies pinned to latest verified versions
- `tsconfig.json` — extends monorepo base
- `src/ast/types.ts` — all domain types and MCP I/O shapes
- `src/store/config.ts` — config resolution (CLI flag → mast.config.json → defaults)
- `src/store/lock.ts` — structure.lock + vectors.lock manager (stub)
- `src/store/lance.ts` — LanceDB table operations (stub)
- `src/graph/db.ts` — SQLite schema DDL + connection helper (stub)
- `src/graph/queries.ts` — graph query functions (stub)
- `src/graph/populate.ts` — graph population from AST (stub)
- `src/graph/local-type-env.ts` — POTENTIAL_CALL resolver (stub)
- `src/ast/parser.ts` — tree-sitter setup + LanguageExtractor interface (stub)
- `src/ast/extract.ts` — language dispatch (stub)
- `src/ast/extractors/typescript.ts` — TS/JS extractor (stub)
- `src/indexer/walker.ts` — file discovery (stub)
- `src/indexer/chunker.ts` — Phase 1 orchestration (stub)
- `src/indexer/embedder.ts` — Phase 2 in-process embedder (stub)
- `src/indexer/background-embedder.ts` — forked embedder host (stub)
- `src/indexer/index.ts` — Phase 1 + 2 coordinator (stub)
- `src/search/fts.ts` — FTS5 BM25 queries (stub)
- `src/search/vector.ts` — LanceDB vector search (stub)
- `src/search/hybrid.ts` — RRF fusion (stub)
- `src/telemetry/tokenizer.ts` — token counting wrapper (stub)
- `src/telemetry/metrics.ts` — metrics table + batch writer (stub)
- `src/mcp/staleness.ts` — JIT staleness checker (stub)
- `src/mcp/tools/*.ts` — all 10 MCP tools (stubs)
- `src/mcp/server.ts` — server factory (stub)
- `src/cli/*.ts` — CLI commands (stubs)

---

## Stage 2: AST Extraction (Phase 1 — parse)
**Goal**: `mast index --phase1-only` correctly parses TypeScript/JavaScript files into chunks.
**Success Criteria**:
- [x] Walker discovers files matching config extensions and exclude patterns
- [x] TypeScript extractor decomposes classes into shell + method chunks
- [x] Two-pass walk correctly sets `is_exported` for separately-exported declarations
- [x] `declaration_hash` and `body_hash` are stable across identical source
- [x] `chunk_split_threshold` sub-chunking works for large functions
**Tests**: Unit tests for `TypeScriptExtractor` against fixture files covering each chunk type.
**Status**: Complete

---

## Stage 3: Storage (SQLite graph + LanceDB chunks)
**Goal**: Phase 1 results persist correctly and can be queried.
**Success Criteria**:
- [x] SQLite schema initialises in WAL mode with correct indexes
- [x] Graph population (imports, symbols, edges) is transactional per file
- [x] Delete-and-replace on incremental reindex keeps graph consistent
- [x] LanceDB chunk table creates, inserts, and queries correctly
- [x] FTS5 `chunk_fts` and `identifier_fts` populated in same transaction
**Tests**: Integration tests against a temp directory with fixture files.
**Status**: Complete

---

## Stage 4: CLI + Indexer (full Phase 1)
**Goal**: `mast init` and `mast index` work end-to-end.
**Success Criteria**:
- [x] `mast init .` creates state dir, writes config.json, runs full Phase 1
- [x] `mast index --incremental` only reindexes changed files
- [x] `mast status` shows accurate file count and staleness
- [x] Lock acquisition prevents concurrent writes
- [x] Deleted file cleanup removes stale chunks from all stores
**Tests**: CLI integration tests against a temp project.
**Status**: Complete

---

## Stage 5: Embeddings
**Goal**: `mast index` generates vectors for all chunks.
**Success Criteria**:
- [ ] `jinaai/jina-embeddings-v2-base-code` loads via @huggingface/transformers v4
- [ ] Embedding cache (content-hash keyed `.json` files) prevents redundant calls
- [ ] Background embedder forks correctly and IPCs progress to parent
- [ ] `vectors.lance` table populated; vector search returns ranked results
**Tests**: Unit tests for `runEmbed` orchestration; integration test verifying vectors stored and `searchVectors` returns results.
**Status**: Complete

> Note: Dynamic dimension detection (model swap support) deferred to Stage 8.

---

## Stage 6: Search (FTS5 + hybrid RRF)
**Goal**: `mast_search` returns correct ranked results in both lexical and hybrid modes.
**Success Criteria**:
- [x] FTS5 trigram tokenizer surfaces camelCase identifiers
- [x] Vector search returns cosine-ranked results from LanceDB
- [x] RRF correctly fuses BM25 and vector ranks
- [x] `mode: "lexical"` during embedding warm-up, `mode: "hybrid"` after
- [x] `only_exported`, `chunk_type`, `file_pattern`, `language` filters work
**Tests**: Search correctness tests against a real fixture corpus.
**Status**: Complete

> Note: SQLite FTS5 LIKE on UNINDEXED columns is unreliable with MATCH — both
> `filePattern` and `language` filters are materialised via the `files` table
> and passed as IN lists to avoid this SQLite quirk.

---

## Stage 7: MCP Tools
**Goal**: All 10 MCP tools work correctly against a live index.
**Success Criteria**:
- [x] `mast_search` — hybrid/lexical, with `_stats`
- [x] `mast_project_skeleton` — directory + depth scoping
- [x] `mast_exports` — signatures + TSDoc from chunks
- [x] `mast_signature` — type_context resolution (stub returns []; deferred to Stage 8)
- [x] `mast_callers` — verified (graph) + potential (identifier_fts) partition
- [x] `mast_dependencies` — import table query
- [x] `mast_implementors` — IMPLEMENTS edge query
- [x] `mast_reindex` — synchronous, returns ReindexResult
- [x] `mast_status` — health snapshot with live stale_files count
- [ ] `mast_efficiency` — session + global aggregation (deferred to Stage 9)
- [x] JIT staleness check on every read tool
**Tests**: MCP tool handler unit tests with in-memory index fixtures (25 tests).
**Status**: Complete

> Note: `extractEdges` in TypeScriptExtractor also fixed here — IMPLEMENTS and
> PARENT_OF edges were never being inserted (index.ts hardcoded `edges: []`).
> `type_context` resolution in `mast_signature` is a stub returning []; full
> implementation deferred to Stage 8 alongside resolveTypeContext.

---

## Stage 8: Startup Ladder + MCP Server
**Goal**: `mast serve` implements the four-step startup ladder from §7.4.
**Success Criteria**:
- [x] Steps 1–3 complete in < 4s (server accepts connections before Phase 2)
- [x] Step 4 runs Phase 1 + Phase 2 in background forked process
- [x] `mast_search` reports `mode: "lexical"` then flips to `"hybrid"` on completion
- [x] Seed index copy logic in entrypoint script works
**Tests**: Integration test for startup sequence with mock embedding (6 tests).
**Status**: Complete

> Also completed in Stage 8: `resolveTypeContext` (3-priority type lookup),
> dynamic embedding dimension detection via `embedder.load()` probe,
> `extractTypeNames` in `mast_signature` to populate `type_context`.

---

## Stage 9: Telemetry
**Goal**: All read tools emit `_stats`; `mast metrics` and `mast_efficiency` work.
**Success Criteria**:
- [x] Non-blocking batch write to `metrics` table (< 1ms per call)
- [x] `mast metrics --since 7d --by-tool` prints correct table
- [x] `mast_efficiency` aggregates session data and self-reports
- [x] Rotation (`--rollup`, `--vacuum`) works
**Tests**: Unit tests for batch writer and aggregation queries (15 tests); `mast_efficiency` MCP tool tests (3 tests).
**Status**: Complete
