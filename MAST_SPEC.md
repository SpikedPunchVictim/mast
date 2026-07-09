# MAST — Monorepo AST Search Tool
## Technical Specification

---

## 1. Overview

**mast** is a semantic code search engine exposed over two surfaces: an MCP server
(used by the agent inside the claude-runner container) and a CLI (used by humans and
hooks outside the container). It replaces ad-hoc `Grep`, `Glob`, and whole-file `Read`
calls with targeted, index-backed queries that return structured subsets of code rather
than full file contents.

A single on-disk index — written to a configurable state directory — is shared by both
surfaces. The index persists on the mounted workspace volume across container runs,
so each new container inherits the index built by previous tasks.

---

## 2. Goals

- Return **chunks not files**: every query response contains only the lines the agent
  needs, not the full file.
- **Zero BT involvement** after init: the MCP server startup check keeps the index
  fresh automatically.
- **Configurable state directory**: the SDD pipeline writes state under
  `.kluster/.mast`; the default for standalone use is `.mast` at the project root.
- **Synchronous freshness on demand**: the agent can call `mast_reindex` mid-task after
  writing files and be guaranteed the next query sees those changes.
- **Single codebase, two surfaces**: the same index and query engine backs both the
  MCP tools and CLI commands.

## 3. Non-Goals

- Code generation or explanation.
- PR review, wiki generation, story generation.
- A persistent background daemon — freshness is handled by the startup check and
  `mast_reindex`.
- Support for non-TypeScript/JavaScript projects in v1 (AST layer is extensible but
  v1 targets the SDD stack).

---

## 4. Configuration

Config is resolved in this priority order:

1. CLI flag `--state-dir <path>` (or env `MAST_STATE_DIR`)
2. `mast.config.json` in the project root
3. Default: `<project_root>/.mast`

### 4.1 `mast.config.json`

```json
{
  "state_dir": ".kluster/.mast",
  "project_root": ".",
  "file_extensions": [".ts", ".tsx", ".js", ".jsx", ".md"],
  "exclude_patterns": [
    "node_modules/**",
    "dist/**",
    "coverage/**",
    ".kluster/**",
    "**/*.test.ts",
    "**/*.spec.ts"
  ],
  "embedding_model": "jinaai/jina-embeddings-v2-base-code",
  "similarity_threshold": 0.70,
  "rrf_k": 60,
  "chunk_split_threshold": 100,
  "context_lines": 3,
  "markdown_heading_depth": 2
}
```

`rrf_k` is the constant in the Reciprocal Rank Fusion formula (see §7.3). The default
of 60 is standard. Higher values reduce the influence of rank differences.

`chunk_split_threshold` is the line count above which a single declaration is split
into overlapping sub-chunks. Below this threshold, a declaration is always one chunk
regardless of length.

`context_lines` controls how many source lines before and after a chunk's AST
boundaries are included in the stored `content` field. When a chunk's AST span is
`[start_line, end_line]`, the stored content covers
`[max(1, start_line - context_lines), min(file_lines, end_line + context_lines)]`.
This gives agents surrounding context (e.g., the `const` binding before a function
expression, or the closing brace of an enclosing block) without requiring a full file
read. The `start_line` and `end_line` fields in the chunk record always reflect the
AST declaration boundaries, not the expanded content boundaries.

`markdown_heading_depth` is the maximum ATX heading level that starts a new `doc`
chunk when indexing markdown files (§10.1). Headings deeper than this fold into
their enclosing section. The default of 2 means one chunk per `##` section.

Vendored markdown noise (dependency READMEs and the like) is handled by the
existing `exclude_patterns` — `node_modules/**` is authoritative; there is no
markdown-specific exclusion logic.

### 4.2 SDD Pipeline Configuration

The claude-runner passes `--state-dir` at serve time:

```json
// claude-runner/.mcp.json
{
  "mcpServers": {
    "mast": {
      "command": "mast",
      "args": ["serve", "--state-dir", "/workspace/.kluster/.mast"],
      "type": "stdio"
    }
  }
}
```

This is the only configuration change needed in the SDD pipeline after `mast init`.

---

## 5. Storage Layout

```
<state_dir>/
├── config.json              # Resolved active config (written at init)
├── index.json               # Index metadata: last_indexed, file_count, schema_version
├── file_manifest.json       # {path: mtime} snapshot from last index run
├── structure.lock              # Advisory write lock for chunks/graph/FTS (Phase 1 + JIT re-parse)
├── vectors.lock              # Advisory write lock for vectors (Phase 2 background embedding)
├── lance/
│   ├── chunks.lance/        # Phase 1: parsed code chunks (LanceDB table)
│   └── vectors.lance/       # Phase 2: embedded vectors (LanceDB table)
├── graph.db                 # Knowledge graph + FTS5 index (SQLite, WAL mode)
└── embed_cache/             # Per-content-hash embedding cache
    └── <model_id>/
        └── <sha256>.npy
```

`index.json` example:
```json
{
  "schema_version": "1.1.0",
  "last_indexed": "2026-05-13T14:22:00Z",
  "file_count": 142,
  "chunk_count": 1840,
  "model": "jinaai/jina-embeddings-v2-base-code"
}
```

---

## 6. Data Model

### 6.1 Chunk (Phase 1 — `chunks.lance`)

| Field | Type | Description |
|---|---|---|
| `chunk_id` | `str` | `sha256(file_path + ":" + start_line)` |
| `file_path` | `str` | Relative to `project_root` |
| `start_line` | `int` | 1-indexed |
| `end_line` | `int` | 1-indexed, inclusive |
| `content` | `str` | Raw source text of the chunk |
| `chunk_type` | `str` | `function` \| `method` \| `class_shell` \| `interface` \| `type` \| `export` \| `block` \| `doc` |
| `symbol_name` | `str \| None` | Top-level symbol name if applicable. For `method` chunks, qualified as `ClassName.methodName`. For `doc` chunks, the heading path (§10.1). |
| `parent_symbol` | `str \| None` | For `method` chunks, the enclosing class name (unqualified). `None` for all other chunk types. Enables fast "find all methods of class X" queries against `chunks.lance` without joining the graph. |
| `is_exported` | `bool` | True if the declaration carries an `export` modifier. For `method` chunks, inherited from the enclosing `class_shell`'s `is_exported` *and* the method's accessibility (anything not `private` is treated as exported when the class is exported). |
| `language` | `str` | `typescript` \| `javascript` \| `markdown` |
| `file_mtime` | `float` | File mtime at index time — used for staleness detection |

`is_exported` enables `mast_search` to filter results to public API surface only,
which is the correct scope when an agent is looking for a service to call rather than
an internal utility to modify.

**`class_shell` content is synthesized, not raw source.** For a `class_shell` chunk,
the stored `content` field is the class declaration line followed by every member
signature (with TSDoc comments), ordered as they appear in source — but with method
bodies stripped. This is the "outline" view used for orientation and for
`mast_signature` calls that target a class rather than a specific method. The raw
class body source is *not* stored as a single chunk; it is decomposed into N
`method` chunks, each with its own embedding (see §10.1).

### 6.2 Vector Entry (Phase 2 — `vectors.lance`)

| Field | Type | Description |
|---|---|---|
| `chunk_id` | `str` | FK → `chunks.chunk_id` |
| `embedding` | `list[float]` | Dense vector from embedding model |
| `model_version` | `str` | Identifies the embedding model used |
| `content_hash` | `str` | `sha256` of the chunk content this vector was computed from. Set by the embed orchestration (not the model). A chunk is "already embedded" only when a stored vector matches BOTH its `chunk_id` AND its current `content_hash` — so an in-place edit (same `chunk_id`, new content) is re-embedded. See §7.1. |

### 6.3 Knowledge Graph (SQLite — `graph.db`)

SQLite with WAL mode replaces KuzuDB. WAL mode is correct for containerised
shared-volume access: it tolerates concurrent readers and a single writer without
exclusive locks that can deadlock across container boundaries.

Recursive CTEs handle multi-hop graph traversal (callers of callers, transitive
dependency chains) with sub-millisecond latency at monorepo scale.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS files (
  id       INTEGER PRIMARY KEY,
  path     TEXT NOT NULL UNIQUE,
  language TEXT NOT NULL,
  mtime    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL,   -- function | class | interface | type | const
  file_id          INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  line             INTEGER NOT NULL,
  is_exported      INTEGER NOT NULL DEFAULT 0,  -- boolean
  declaration_hash TEXT,            -- sha256 of signature text only (excludes body)
  body_hash        TEXT             -- sha256 of body text only (excludes signature)
  -- If both declaration_hash and body_hash are unchanged on incremental reindex:
  -- skip KG rebuild (Phase 1) AND skip re-embedding (Phase 2) for this symbol.
);

CREATE TABLE IF NOT EXISTS edges (
  from_id    INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  to_id      INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  edge_type  TEXT NOT NULL,
  resolution TEXT,    -- POTENTIAL_CALL only: which §10.3.1 rule matched
                      -- (import | field_type | parameter_type | new_expression | same_file)
  call_line  INTEGER, -- POTENTIAL_CALL only: 1-indexed source line of the call site
  context    TEXT,    -- POTENTIAL_CALL only: trimmed source text of the call-site line
  -- POTENTIAL_CALL | IMPLEMENTS | EXTENDS | RE_EXPORTS | PARENT_OF
  -- POTENTIAL_CALL: name-resolved reference. The local heuristic resolver (see §10.3)
  --                 produces these edges when it can statically link the receiver of a
  --                 method call to a known symbol. Coverage is partial by design — see
  --                 §10.3 for what the resolver catches and what it doesn't. Tools that
  --                 consume these edges (mast_callers) MUST also surface identifier-FTS
  --                 matches as "potential" results to compensate for missed edges.
  -- RE_EXPORTS:     file A re-exports a symbol from file B via export * or export { x }
  -- PARENT_OF:      class symbol → method symbol. Emitted once per method during
  --                 class_body decomposition (see §10.1). Enables "list all methods of X"
  --                 queries via a single indexed lookup.
  PRIMARY KEY (from_id, to_id, edge_type)
);

CREATE TABLE IF NOT EXISTS re_export_files (
  -- Tracks export * from '...' at the file level (no specific symbol known at parse time)
  from_file_id  INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  to_file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  PRIMARY KEY (from_file_id, to_file_id)
);

CREATE TABLE IF NOT EXISTS imports (
  file_id       INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  module        TEXT NOT NULL,
  symbols       TEXT NOT NULL,   -- JSON array of imported symbol names
  is_external   INTEGER NOT NULL DEFAULT 0,
  resolved_path TEXT             -- NULL for external modules; populated by path resolver
);

-- FTS5 with built-in content: stores content directly alongside the index structures.
-- snippet() works without any external table. Phase 1 inserts/updates/deletes directly
-- on chunk_fts; no sync logic required. Content duplication vs LanceDB is acceptable
-- at monorepo scale (~1-2 GB of source) and eliminates a whole class of consistency bugs.
-- trigram tokenizer: substring matching for camelCase identifiers, prose, and partial
-- queries. Used by mast_search BM25 ranking via bm25(chunk_fts) (returns negative scores).
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
  content,
  symbol_name UNINDEXED,   -- stored for retrieval; trigram on content already surfaces symbol names
  chunk_id    UNINDEXED,
  tokenize    = 'trigram'
);

-- Identifier-exact FTS: a search for "findUserByEmail" must match that identifier
-- exactly, NOT substrings like "findUser" or "findUserByEmailVerified". The trigram
-- tokenizer (above) is too noisy for this — it routinely returns dozens of false
-- positives on common method names. unicode61 with code-aware separators tokenizes
-- on identifier boundaries (.-_/()[]{}<>:;,=+*&|!?), giving exact-identifier match
-- semantics needed by mast_callers' "potential_matches" set (see §9 mast_callers).
--
-- The `identifiers` column is populated by Phase 1: it stores a whitespace-separated
-- list of every identifier token found in the chunk (deduplicated). Phase 1
-- extracts these via tree-sitter — no separate parse pass.
CREATE VIRTUAL TABLE IF NOT EXISTS identifier_fts USING fts5(
  identifiers,
  chunk_id    UNINDEXED,
  tokenize    = "unicode61 separators '.-_/()[]{}<>:;,=+*&|!?'"
);

-- Hot-path index: name lookup returns file_id, line, kind directly from the index
-- tree without touching table rows (covering index for mast_signature / mast_search).
CREATE INDEX IF NOT EXISTS idx_symbols_lookup   ON symbols(name, file_id, line, kind);
CREATE INDEX IF NOT EXISTS idx_symbols_file     ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_edges_from       ON edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to         ON edges(to_id);
CREATE INDEX IF NOT EXISTS idx_imports_file     ON imports(file_id);
CREATE INDEX IF NOT EXISTS idx_imports_resolved ON imports(resolved_path);
```

**Recursive CTE example — transitive callers (verified set only):**
```sql
WITH RECURSIVE callers(id) AS (
  SELECT from_id FROM edges
  WHERE to_id = :target_id AND edge_type = 'POTENTIAL_CALL'
  UNION
  SELECT e.from_id FROM edges e
  JOIN callers c ON e.to_id = c.id
  WHERE e.edge_type = 'POTENTIAL_CALL'
)
SELECT s.name, f.path, s.line
FROM symbols s
JOIN files f ON s.file_id = f.id
JOIN callers c ON s.id = c.id;
```

This CTE only returns callers the heuristic resolver could statically link. It is
the **verified** set. `mast_callers` MUST also run an `identifier_fts` query for
the symbol name and present those hits as a separate **potential** set — see §9
`mast_callers`.

**Recursive CTE example — barrel file / transitive re-export resolution:**

Used by `mast_signature` when the direct symbol lookup returns no result, indicating
the symbol may be re-exported through one or more barrel files.

Note: `re_export_files` edges are file-to-file (using `files.id`). `edges` with
`RE_EXPORTS` type are symbol-to-symbol (using `symbols.id`). The CTE below follows
the file-level chain from `re_export_files`, then locates the symbol in the terminal
file. This correctly separates file IDs from symbol IDs.

```sql
WITH RECURSIVE re_export_chain(file_id) AS (
  -- Start from the file where the agent queried the symbol
  SELECT :start_file_id
  UNION
  -- Follow export * from '...' edges to source files
  SELECT rf.to_file_id
  FROM re_export_files rf
  JOIN re_export_chain rec ON rf.from_file_id = rec.file_id
)
SELECT s.id, s.name, s.kind, s.line, f.path
FROM symbols s
JOIN files f ON s.file_id = f.id
JOIN re_export_chain rec ON s.file_id = rec.file_id
WHERE s.name = :symbol_name
  AND s.file_id != :start_file_id  -- exclude the barrel file itself
LIMIT 1;
```

---

## 7. Index Lifecycle

### 7.1 Two-Phase Indexing

**Phase 1 — Parse → Chunks**
1. Acquire write lock (`.mast.lock`) — see §7.6. Exit with error if lock cannot be
   acquired within the configured timeout.
2. Walk project files matching `file_extensions`, respecting `exclude_patterns`.
   Collect `{ path, mtime }` for every file found.
3. **Deleted file cleanup:** load `file_manifest.json` (previous scan's path set).
   Any path present in the manifest but absent from the current walk has been deleted.
   Remove its rows from `graph.db` `files` table (cascade deletes symbols, edges, and
   imports), and delete all matching chunks from `chunks.lance` and `vectors.lance`.
4. For each file to index (all files on full run; only files where
   `mtime > manifest[path]` on incremental run): wrap the parse in try/catch. On
   tree-sitter error, log at `warn` level with the file path and error message,
   increment `parse_errors`, and skip to the next file. Never abort the full run.
   On success: run the two-pass walk and extract chunks with type, symbol, `is_exported`,
   and `declaration_hash` metadata.
5. Write chunks to `chunks.lance`. Delete and replace all existing chunks for the
   same `file_path`. Update `chunk_fts`: `DELETE FROM chunk_fts WHERE chunk_id = ?`
   for removed chunks, `INSERT INTO chunk_fts(content, symbol_name, chunk_id) VALUES
   (?, ?, ?)` for new/changed chunks. No external table or trigger is needed — FTS5
   built-in content handles everything.
6. Populate `graph.db` from AST imports and relationships, wrapped in a single
   transaction per file (delete-and-replace). Record `RE_EXPORTS` edges from
   `export { x }` clauses and `re_export_files` rows from `export * from '...'`
   clauses.
7. **Stability hash optimisation (incremental only):** the `declaration_hash`
   (signature) and `body_hash` are computed from the AST (signature node vs body
   node), not by splitting chunk text.

   **Implementation note (deviates from the original per-symbol design):** the
   skip is applied at *file* granularity, and re-embedding is keyed on a separate
   vector content hash rather than `body_hash`:
   - **Re-embedding** is keyed on `vectors.content_hash` = `sha256(chunk content)`
     (see §6.2). A chunk is re-embedded iff its current content hash is not already
     stored — this captures any signature *or* body change and is strictly more
     correct for embeddings (which cover the whole chunk, not just the body). This
     supersedes the `body_hash`-driven re-embed skip described above.
   - **File-level skip:** a file whose mtime changed but whose chunked content is
     byte-identical (same chunk-id set AND same per-symbol `declaration_hash`/
     `body_hash` signature, and no `block` chunks) is not re-written at all. A
     true *per-symbol* KG-rebuild skip was rejected: under the per-file
     delete-and-replace model (step 6), symbols are re-inserted with new ids, so
     edges must be rebuilt — preserving them per-symbol would be invasive surgery
     on the hot path for marginal gain.

   **Class shells use a member-signature hash, not a body hash.** A `class_shell`
   chunk's content is the synthesized outline (declaration + member signatures + TSDoc;
   no method bodies — see §6.1). Its `body_hash` is therefore computed as
   `sha256(sorted(member_signature_text + member_doc_text).join("\n"))`, where each
   `member_signature_text` is the method's signature line stripped of body. This means:
   - Renaming a method → shell content changes → shell `body_hash` changes → shell
     re-embedded. Correct: the outline visible to the agent now lists a new name.
   - Editing a method body without changing its signature → shell `body_hash`
     **unchanged** → shell NOT re-embedded; only the affected `method` chunk is.
     Correct: the class's public interface didn't change, only its internals.
   - Adding or removing a method → shell content changes → shell re-embedded, plus
     the new/removed `method` chunk is added/deleted.

   Without this rule, the shell silently drifts out of sync with its members, and
   `mast_search "session validation"` returns a stale outline naming a method that
   no longer exists.
8. Write `file_manifest.json` with the current `{ path: mtime }` snapshot.
9. Write/update `index.json` with `last_indexed` and `file_count`.

Incremental variant: step 4 skips files where `mtime === manifest[path]`. Steps 3
(deleted file cleanup) and 8–9 always run.

**Phase 2 — Embed → Vectors**
1. Load embedding model (loaded once per `mast serve` session; loaded fresh per CLI call).
2. For each chunk in `chunks.lance` without a corresponding `vectors.lance` entry:
   a. Check embed cache (`<sha256(content)>.npy`) — use cached embedding if present.
   b. Otherwise, call model. Write to cache and to `vectors.lance`.
Phase 2 is resumable: a partial run (e.g. container killed) leaves Phase 1 intact and
resumes embedding from where it left off on next start. The write lock is released at
the end of Phase 2.

BM25 search is handled by the `chunk_fts` FTS5 virtual table in `graph.db`, populated
incrementally during Phase 1 (step 5). There is no separate serialization step.

### 7.2 Embedding Model

**`jinaai/jina-embeddings-v2-base-code`**

Chosen over general-purpose NLP models for three reasons:
- Code-specific training corpus — better semantic alignment for identifiers,
  type signatures, and programming patterns.
- 8,192-token context window — entire small files and large functions embed without
  truncation. General-purpose models (e.g. `all-MiniLM-L6-v2`) truncate at 256-512
  tokens, losing the tail of any non-trivial function.
- Currently top-tier on the CodeSearchNet benchmark for code retrieval tasks.

The 8k context window makes the chunk split threshold less critical — a 200-line
function still embeds in a single pass.

### 7.3 Hybrid Search with RRF

Search combines vector similarity (dense) and BM25 (sparse) using
**Reciprocal Rank Fusion**:

$$Score(d) = \sum_{r \in R} \frac{1}{k + r(d)}$$

Where $r(d)$ is the rank of document $d$ in ranker $R$, and $k$ is `rrf_k` (default 60).

RRF is used instead of weighted score addition because BM25 and vector similarity
scores are on incomparable scales. A document ranked #1 in BM25 (exact symbol match)
and #40 in vector search still scores well under RRF — which is the correct behaviour
for code queries that mix exact identifiers with conceptual descriptions.

Implementation: run vector search (top 50) and FTS5 BM25 search (top 50)
independently, then apply RRF to produce a unified ranked list. Return the top
`limit` results.

**FTS5 sign convention:** SQLite's `bm25(chunk_fts)` returns negative scores — more
negative means a better match. When sorting the FTS5 result set, sort ascending
(most negative first) before applying RRF ranks. Do not negate the scores; rank
position is all that RRF uses.

### 7.4 Startup Reindex (Primary Pipeline Hook)

When `mast serve` starts, the goal is **time-to-first-query in single-digit
seconds**, not a fully warm semantic layer. The discovery layer (graph + FTS) is
loaded synchronously; the semantic layer (embeddings) warms in a background
process while MCP connections are already being served. Cold-start dead time is
the single biggest UX risk to MAST adoption — see Failure 4 in the design
review — so this ladder is structured to eliminate it.

```
startup
  ├─ STEP 1 (sync, < 1s): bootstrap state directory
  │    ├─ if <state_dir> is missing or empty:
  │    │    └─ if /opt/mast-seed exists (Docker-baked seed, see §13.8):
  │    │         copy /opt/mast-seed → <state_dir>
  │    │    └─ else:
  │    │         run `mast init --no-index` to create config + empty state
  │    └─ load index.json (or create with schema_version + empty fields if missing)
  │
  ├─ STEP 2 (sync, < 2s): schema version + state load
  │    ├─ if index.json.schema_version != CURRENT_SCHEMA_VERSION:
  │    │    delete <state_dir>/lance/, graph.db, file_manifest.json, embed_cache/
  │    │    set needs_full_reindex = true
  │    │    write new index.json with updated schema_version
  │    ├─ open graph.db (better-sqlite3, WAL mode)
  │    └─ verify chunk_fts and identifier_fts tables exist (created on first init)
  │
  ├─ STEP 3 (sync, < 1s): open MCP transport — DISCOVERY LAYER READY
  │    ├─ register all read tools (mast_search, mast_signature, mast_exports,
  │    │  mast_project_skeleton, mast_callers, mast_dependencies,
  │    │  mast_implementors, mast_status, mast_efficiency)
  │    ├─ register write tools (mast_reindex)
  │    ├─ initial mode = "lexical" (mast_search returns mode: "lexical" until
  │    │  vectors are ready — see §9 mast_search)
  │    └─ accept incoming MCP connections
  │
  └─ STEP 4 (async, in forked child process): warm semantic layer
       ├─ scan filesystem: collect {path, mtime} for all matched files
       ├─ deleted_files = manifest_paths - scanned_paths
       │    └─ for each: delete chunks/symbols/vectors (acquire structure.lock + vectors.lock briefly)
       ├─ stale_files = [f for f in scanned if f.mtime > index.last_indexed
       │                 OR needs_full_reindex]
       ├─ acquire structure.lock
       │    ├─ run Phase 1 (parse) for stale_files
       │    ├─ update file_manifest.json + index.json.last_indexed
       │    └─ release structure.lock
       │    └─ FROM THIS POINT: discovery layer is up-to-date for stale files
       │       (mast_search lexical, mast_callers verified+potential, etc.)
       ├─ acquire vectors.lock
       │    ├─ load embedding model into the forked process (Transformers.js + ONNX)
       │    ├─ run Phase 2 (embed) for new/changed chunks, batched
       │    │    ├─ batch size: 32 chunks, with cache check per §7.1
       │    │    └─ post IPC progress message to parent every 100 chunks
       │    ├─ on completion: signal parent process; parent flips mast_search mode
       │    │  to "hybrid" for subsequent calls
       │    └─ release vectors.lock
       └─ keep child alive for future mast_reindex Phase 2 work; parent IPCs requests
```

**Forked process for the embedder.** Phase 2 runs in a `child_process.fork()`'d
Node process, not a worker thread or the main process. Rationale:
- Native ONNX runtime allocations are isolated; an OOM or segfault in the embedder
  cannot kill the MCP server. The agent's "brain" stays connected.
- The main MCP process keeps a small memory footprint (no model weights loaded
  in-process), so it can serve discovery-layer queries with low latency.
- IPC is well-defined: parent sends `embed(chunk_ids[])` requests; child responds
  with completion + per-chunk vector references. No shared memory complexity.

`CURRENT_SCHEMA_VERSION` is a constant in the mast binary (currently `"1.1.0"` —
bumped from `1.0.0` when `vectors.lance` gained `content_hash`; see §6.2/§7.1). A version
bump is required any time the SQLite schema, LanceDB table shape, or `index.json`
fields change. Incrementing without a state wipe causes a corrupt or partial index;
wiping without incrementing loses the protection. Both are bugs — treat the version
as a migration guard, not a display string.

(Backward-compatible additions that do not break reading an old table — e.g. the
`edges.resolution`/`call_line`/`context` columns added via `ALTER TABLE … ADD
COLUMN` — do NOT require a bump, since `openDatabase` migrates them in place.) On schema bump the seed index in
`/opt/mast-seed` is also invalidated and a full reindex runs in the background; the
discovery layer will be in `mode: "lexical"` until it completes.

**Fast first-task latency.** With a baked seed (§13.8), Steps 1–3 typically complete
in **2–4 seconds** on a cold container. Step 4 then warms in the background — for a
5K-file class-heavy repo (~20–30K chunks, see §10.1), this takes 20–30 minutes if
the seed itself needs to be rebuilt (e.g., schema bump), or under 2 minutes for the
incremental case (only files changed since the seed commit). The agent can begin
useful work as soon as Step 3 completes; the only restriction is that
`mast_search` results are FTS5-only until Step 4 finishes embedding.

This is the **only hook required for the SDD pipeline**. The BT orchestrator needs no
reindex calls. Files committed by the previous task are picked up by Step 4's
filesystem scan. JIT staleness handling (§9) covers files modified mid-task before
Step 4 has caught up to them.

### 7.5 Mid-Task Reindex (`mast_reindex` MCP tool)

The agent calls `mast_reindex` immediately after writing files, before querying for
symbols it just created. This is synchronous — the tool does not return until the index
is updated. Phase 1 only touches files with changed mtimes; Phase 2 only embeds new
chunks. For a typical single-file write this completes in <500ms.

### 7.6 Write Locking

Writes are split across **two advisory file locks**, both managed by `proper-lockfile`:

- **`<state_dir>/structure.lock`** — held during chunk parsing, graph population, and
  FTS index writes (`chunks.lance`, `graph.db`, `chunk_fts`, `identifier_fts`).
  Acquired by `mast index`, the startup full/incremental reindex, `mast_reindex`,
  and (importantly) the JIT re-parse triggered by stale-file detection inside any
  read tool — see §9 staleness handling.
- **`<state_dir>/vectors.lock`** — held during vector embedding writes
  (`vectors.lance`). Acquired by Phase 2, including the background embedder forked
  by `mast serve` (see §11.1).

**Why split?** A single global lock would force every JIT read-tool re-parse to wait
for the background embedder to finish — which can take minutes during cold start or
after a large `mast_reindex`. Phase 1 writes touch chunks/graph/FTS; Phase 2 writes
touch vectors. They modify disjoint files and can safely proceed in parallel. Splitting
the lock is what makes the "lexical-ready immediately, semantic warming in background"
model in §11.1 work without sacrificing read latency.

**Why `proper-lockfile`:** it writes the acquiring process's PID into the lock file and
checks liveness on encounter. If a container is killed mid-index and a `.lock` file is
left on the shared volume, the next process that tries to acquire the lock sees a PID
that is no longer running and breaks the stale lock automatically. No manual heartbeat
or timestamp logic is needed. Always pass `{ stale: 10000 }` (10 seconds) when calling
`lockfile.lock()`; this is the maximum age a lock file is considered valid without a
live PID, and ensures clean recovery from abrupt container exits on shared volumes.

**Behaviour by caller (structure.lock):**
- **CLI commands** (`mast index`): non-blocking — if the lock cannot be acquired within
  2 seconds, exit with a clear error message naming the operation that holds it.
- **`mast_reindex` MCP tool**: blocking with retries — attempt acquisition up to 5
  times with 1-second backoff, then return an error to the agent with the suggestion
  to retry after the current index run completes.
- **`mast serve` startup reindex**: blocking, same retry policy as `mast_reindex`.
- **JIT re-parse from a read tool**: blocking with short retries — attempt acquisition
  up to 3 times with 100ms backoff. On exhaustion, fall through to the TOCTOU policy
  (§9 staleness handling) and return the stale chunk with a `file_busy_returning_stale_cache`
  flag rather than blocking the agent indefinitely.

**Behaviour by caller (vectors.lock):**
- **Background embedder** (forked by `mast serve`, see §11.1): blocking, single
  long-lived holder for the duration of a batch.
- **`mast_reindex` MCP tool**: when invoked synchronously, acquires vectors.lock after
  releasing structure.lock. If the background embedder is mid-batch, waits with the same
  5×1s retry policy as structure.lock.

Only one writer runs at a time *per lock*. The two locks are independent: a JIT
re-parse holding structure.lock does not block a background embedder holding vectors.lock,
and vice versa. Concurrent readers (all MCP query tools) acquire neither lock — they
only `stat()` files for staleness detection (§9).

---

## 8. CLI Interface

### `mast init [path] [options]`

Initialise mast for a project.

```
Options:
  --state-dir <dir>         Where to write index state (default: <path>/.mast)
  --extensions <ext,...>    File extensions to index (default: .ts,.tsx,.js,.jsx)
  --exclude <pattern,...>   Glob patterns to exclude
  --no-index                Create config only, skip initial indexing
```

Creates `<state_dir>/`, writes `config.json`, runs full index (Phase 1 + 2).

---

### `mast index [path] [options]`

Build or update the index.

```
Options:
  --state-dir <dir>    State directory (resolved from config if omitted)
  --incremental        Only reindex files changed since last index run
  --phase1-only        Parse and chunk only, skip embedding
```

---

### `mast serve [options]`

Start the MCP server over stdio.

```
Options:
  --state-dir <dir>       State directory
  --no-startup-reindex    Skip the startup staleness check (not recommended)
```

The server runs until the parent process (Claude CLI) closes stdin. The embedding
model is loaded once at startup and reused for all `mast_search` calls within the
session.

---

### `mast status [path] [options]`

Print index health.

```
Options:
  --state-dir <dir>    State directory
  --json               Output as JSON
```

Output:
```
state_dir:      /workspace/.kluster/.mast
last_indexed:   2026-05-13T14:22:00Z (3 minutes ago)
indexed_files:  142
chunk_count:    1840
stale_files:    0
pending_embeddings: 0
parse_errors:   0
index_fresh:    true
freshness_cause: none
model:          jinaai/jina-embeddings-v2-base-code
```

`pending_embeddings` and `freshness_cause` carry the same semantics as the
`mast_status` MCP tool (§9) — `freshness_cause` prints `none` in human output
when the JSON value would be `null`. Both fields are included in `--json`
output. On a never-indexed project the state directory is not created as a
side effect of running `status`; `pending_embeddings` reports 0.

---

### `mast install-hooks [path]`

Write git hooks into `<path>/.git/hooks/`:
- `post-commit` → `mast index <path> --incremental`
- `post-checkout` → `mast index <path> --incremental`

For developer ergonomics outside the SDD pipeline. Not required for the automated
pipeline.

---

## 9. MCP Tools

All tools are exposed on the `mast` MCP server. Tool names follow the convention
`mast_<action>`.

---

### 9.0 Staleness Handling (All Read Tools)

Every read tool (`mast_search`, `mast_signature`, `mast_exports`,
`mast_project_skeleton`, `mast_callers`, `mast_dependencies`, `mast_implementors`)
performs a **mandatory server-side staleness check** before returning. This is
not optional and is not controlled by the caller — the index is responsible for
its own consistency, not the agent.

**The agent must never see a chunk whose line coordinates do not match the
current file on disk.** Returning stale line numbers leads directly to
agent-assisted corruption: the agent issues an `Edit` against the stale range
and overwrites unrelated logic. This class of failure does not surface as an
error — it surfaces as silent, hard-to-attribute breakage downstream.

**Just-In-Time (JIT) Phase 1 re-parse.** For every result a tool is about to
return:

1. `fs.stat()` the `file_path`. Compare disk `mtime` against the chunk's stored
   `file_mtime`.
2. If `disk_mtime <= stored_mtime` → return the result unchanged. Fast path.
3. If `disk_mtime > stored_mtime` → the chunk is stale. Acquire `structure.lock`
   (see §7.6), re-run Phase 1 for **this file only** (one tree-sitter parse,
   one transactional delete-and-replace against `chunks.lance`, `graph.db`,
   `chunk_fts`, `identifier_fts`), release `structure.lock`. Re-resolve the
   tool's result against the refreshed chunks. A single-file Phase 1 typically
   completes in 10–50ms.

The vector store (`vectors.lance`) is **not** updated by JIT. The refreshed
chunks may not have matching vectors until the next `mast_reindex` or
background embedder pass. Implication: *line coordinates and content are
always accurate; semantic search ranking may be slightly stale between an edit
and a `mast_reindex` call.* The agent prompt should still recommend
`mast_reindex` after substantive edits — not for safety (JIT covers it) but
for semantic relevance.

**TOCTOU Policy (file mid-write).** Between `stat()` and `parse()`, the file
may be in the middle of being written by another process (e.g., the agent's
own `Edit` tool, an editor save, a `git checkout`). Tree-sitter on partial
source either throws or produces a truncated tree. The policy:

1. On parse error or empty tree, sleep **50ms** and retry **once**.
2. If the second attempt also fails, return the **previous (stale) chunk** with
   a `file_busy_returning_stale_cache: true` flag on the result. Do not throw
   — the agent has no recovery for a thrown error, but it can interpret the
   flag.
3. If the file no longer exists (deleted), remove its rows from the graph and
   chunk stores and return whatever results remain (possibly empty).

**`identifier_fts` and `chunk_fts` updates.** The JIT re-parse rewrites the
FTS5 rows for the affected file in the same transaction as the chunk/graph
rewrite. There is no separate sync step.

**Concurrency.** Two simultaneous read tools targeting different stale files
each acquire `structure.lock` briefly and serialize on it. This is intentional
and bounded: lock holding is per-file-parse (10–50ms), not per-tool-call. The
background embedder holds `vectors.lock`, which is independent — JIT never
blocks on embedding.

**Result shape.** Every read tool's result objects MAY include
`file_busy_returning_stale_cache: true` (omitted when false). Result schemas
in the per-tool sections below document only the steady-state shape; this flag
is implicit on all of them.

---

### `mast_search`

Hybrid semantic + BM25 search via RRF. Returns chunks, not full files.

**Input:**
```json
{
  "query": "string",
  "limit": 10,
  "language": "typescript | javascript | markdown | null",
  "file_pattern": "glob pattern | null",
  "chunk_type": "function | method | class_shell | interface | type | doc | null",
  "only_exported": false
}
```

`only_exported: true` restricts results to chunks where `is_exported = true`. Use
this when looking for a service or utility to call into — it eliminates internal
implementation details from results.

**Output:** `SearchResponse`
```json
{
  "mode": "hybrid",
  "results": [
  {
    "file_path": "api/services/auth/src/handler.ts",
    "start_line": 42,
    "end_line": 58,
    "content": "export async function handleLogin(...) {",
    "chunk_type": "function",
    "symbol_name": "handleLogin",
    "parent_symbol": null,
    "is_exported": true,
    "similarity_score": 0.91,
    "match_score": -4.21,
    "rank": 1,
    "match_snippet": "...async function [1mhandleLogin[0m(req: [1mLoginRequest[0m..."
  }
  ]
}
```

`match_snippet` is produced by SQLite's `snippet(chunk_fts, 0, '**', '**', '...', 12)`
function. It returns a short fragment of the chunk content with matched terms marked,
so the agent can see immediately why the result was returned without reading the full
`content` field. The fragment length (12 tokens) is configurable.

**`mode` discriminator.** During the cold-start window described in §11.1, the
background embedder may not have finished populating `vectors.lance`. `mast_search`
adapts:

- `mode: "hybrid"` — both vector search and FTS5 BM25 ran; results are RRF-fused.
  `similarity_score` is populated (cosine similarity for the top vector hit),
  `match_score` carries the BM25 score (negative — see §7.3).
- `mode: "lexical"` — vector store is not yet ready or has been intentionally
  disabled (`--no-embeddings` install flag, §13.11). Results are FTS5-only.
  `similarity_score` is `null`; `match_score` carries the ranking signal.

The agent SHOULD NOT compare `similarity_score` values across modes — they are
not on a shared scale. Consumers that care about uniform ranking should use the
`rank` field, which is always present and starts at 1.

`parent_symbol` is populated only on `method` chunks (carries the enclosing
class name); `null` for all other chunk types.

**Zero-result assist (`suggestions`).** When a search returns no results — no
FTS/vector hit, or every hit fell below `similarity_threshold`, or the
`chunk_type` / `only_exported` filters emptied the set — the tool does not
return a bare dead end. It runs a relaxation pass and attaches a `suggestions`
array of `{ symbol, file_path, reason }` "did you mean" candidates:

```json
{
  "mode": "lexical",
  "results": [],
  "suggestions": [
    { "symbol": "handleLogin", "file_path": "api/services/auth/src/handler.ts", "reason": "similar symbol name" },
    { "symbol": "handleLogout", "file_path": "api/services/auth/src/handler.ts", "reason": "matched split query terms" }
  ]
}
```

Candidates are gathered from three complementary passes, de-duplicated by
`(symbol, file_path)` and capped at `limit`:

- **Trigram symbol-name similarity** against the `symbols` table (Dice
  coefficient over character trigrams; SQLite ships no `pg_trgm`, so the ranking
  is computed in-process). `reason: "similar symbol name"`.
- **FTS retry over split query terms** — the query is split on camelCase,
  acronym, and snake/kebab boundaries (`getUserById` → `get`, `user`), then
  re-run against `chunk_fts`. `reason: "matched split query terms"`.
- **`identifier_fts` near-miss** — the same split terms are OR-matched against
  the identifier index. `reason: "identifier near-miss"`.

**Trigger and contract.** `suggestions` is present (possibly empty) **only when
`results` is empty**, and is omitted from the response entirely when results
were found. Suggestions are advisory: they are **never** promoted into
`results`, so `results` stays `[]` on the assist path. The agent should treat
them as vocabulary hints to re-query with, not as answers.

**Shell/method dedup (`related`).** Class decomposition (§10.1) means one query
can match both a `method` chunk and its parent `class_shell`, whose synthesized
outline repeats the same signature — returning both charges the agent twice for
one fact. A post-RRF presentation pass therefore keeps only the higher-ranked
half of every shell↔method pair and attaches a `related` hint to the survivor:

- surviving `method` (shell suppressed): `"related": { "parent_symbol": "AuthService" }`
  — the class outline also matched; query the class name for the full picture.
  When several methods of the class survive, the hint lands on the
  highest-ranked one only.
- surviving `class_shell` (methods suppressed): `"related": { "methods_matched":
  ["AuthService.validateSession", "AuthService.refresh"] }` — these specific
  members also matched; read them next instead of re-searching.

Rules: shell and method are paired by `parent_symbol` + the same `file_path`
(same-named classes in different files never collapse); methods never suppress
each other; ranking math is untouched — suppression frees slots that are
backfilled from the RRF candidate tail, so the response still returns up to
`limit` distinct results, and `rank` values are re-assigned after dedup so they
remain contiguous from 1. `related` is absent when no collision occurred.

**When used:** primary code discovery — replaces `Grep`, `Glob`, and exploratory `Read`.

---

### `mast_project_skeleton`

All file paths in the project with their exported top-level symbol names. Returns
names only — no signatures, no bodies. Designed to give the agent a compressed
architectural overview in a single call.

**Input:**
```json
{
  "directory": "api/services/auth | null",
  "max_depth": 2,
  "file_pattern": "glob pattern | null"
}
```

`directory` scopes the skeleton to a subtree of the project — essential for large
monorepos where a full skeleton would be noisy. `max_depth` limits directory traversal
depth relative to `directory` (or `project_root` if omitted). Both are optional;
omitting both returns the full project skeleton.

**Output:** array of `FileSkeleton`
```json
[
  {
    "file_path": "api/services/auth/src/index.ts",
    "exports": ["handleLogin", "handleLogout", "AuthPlugin"]
  },
  {
    "file_path": "api/services/auth/src/repository.ts",
    "exports": ["AuthRepository"]
  }
]
```

Sourced entirely from `chunks.lance` where `is_exported = true` — no tree-sitter
reparsing at query time.

**When used:** early in a task for orientation — "what services exist and what do they
expose?" before deciding which files to query further. Replaces opening multiple
`index.ts` barrel files. Scope with `directory` when working within a known service
subtree to avoid noise from unrelated packages.

---

### `mast_exports`

All exported symbols from a single file with type signatures. No function bodies.

**Input:**
```json
{
  "file_path": "api/services/auth/src/index.ts"
}
```

**Output:** array of `Export`
```json
[
  {
    "name": "handleLogin",
    "kind": "function",
    "signature": "export async function handleLogin(req: LoginRequest, reply: FastifyReply): Promise<void>",
    "line": 42,
    "doc": "Validates credentials and issues a session token. Throws UnauthorizedError on failure."
  },
  {
    "name": "AuthPlugin",
    "kind": "class",
    "signature": "export class AuthPlugin implements FastifyPlugin",
    "line": 12,
    "doc": null
  }
]
```

**When used:** "What does this file expose?" before deciding whether to open it.
Replaces a full-file `Read` when the agent only needs the public API surface.

**Implementation:** tree-sitter AST walk — extract `export_statement` nodes and
`export_clause` nodes. For each exported declaration, extract the declaration node
up to (not including) the body `{ ... }` block. Extract leading TSDoc/JSDoc comment.

---

### `mast_signature`

Declaration, TSDoc, and resolved parameter type context for a named symbol.

**Input:**
```json
{
  "symbol": "handleLogin",
  "file_path": "api/services/auth/src/handler.ts"
}
```

`file_path` is optional. When omitted, all matching symbols across the codebase are
returned. If multiple matches are found and the caller only expects one, pass `file_path`
to disambiguate. There is no "first match" shortcut — an ambiguous query always returns
the full match set so the agent can choose.

**Output:** `SignatureResult[]` — always an array, even for a single match.
```json
[
  {
    "symbol": "handleLogin",
    "file_path": "api/services/auth/src/handler.ts",
    "line": 42,
    "signature": "export async function handleLogin(req: LoginRequest, reply: FastifyReply): Promise<void>",
    "doc": "Validates credentials and issues a session token. Throws UnauthorizedError on failure.",
    "params": [
      { "name": "req", "type": "LoginRequest" },
      { "name": "reply", "type": "FastifyReply" }
    ],
    "return_type": "Promise<void>",
    "type_context": [
      {
        "name": "LoginRequest",
        "signature": "interface LoginRequest { email: string; password: string; }",
        "file_path": "api/services/auth/src/types.ts",
        "line": 3,
        "truncated": false
      }
    ]
  }
]
```

When `file_path` is omitted and multiple files define a symbol with the same name,
`type_context` is still resolved per entry using that entry's containing file as the
resolution root. Entries are ordered by `is_exported` descending (exported symbols
first), then by `file_path` ascending.

**Transitive export resolution:** when looking up a symbol by name, the `symbols`
table is queried first. If the symbol is not found directly but a `RE_EXPORTS` edge
or `re_export_files` row exists pointing from the queried file to another file, the
lookup recurses through that chain until the source declaration is found. This handles
barrel file patterns where `packages/shared/src/index.ts` re-exports everything from
internal modules three levels deep. The recursive CTE for this lookup mirrors the
callers pattern already in §6.3.

**`type_context` resolution rules:**
1. Extract all named types from `params` and `return_type`.
2. For each type name, resolve the declaration using this priority order:
   a. **Same file first:** query `symbols` where `file_id = <containing file's id>` and
      `name = <type name>`. This handles types defined alongside the function.
   b. **Imports:** query `imports` for the containing file; find the row where `symbols`
      contains the type name. Resolve `resolved_path` using the path resolver (see
      §13.7) for tsconfig aliases and workspace packages.
   c. **RE_EXPORTS chain:** if not found via imports, walk the `re_export_files` chain
      recursively (same CTE as §6.3 barrel resolution) to find a file that defines the
      type. This handles barrel files that re-export types without explicit `import`.
   d. **Not found:** treat as external; omit from `type_context` (do not error).
3. If found in the monorepo: extract the declaration from `graph.db` `symbols` table —
   signature only, no body. Do not re-parse the file with tree-sitter.
4. Include as a `type_context` entry.
5. **One level deep only.** Do not recurse into the fields of resolved types.
6. **Monorepo types only.** Types from `node_modules` (external) are not resolved.
7. **Simple type references only.** Generic parameters (`Promise<T>`) are resolved
   for their type argument (`T`) if it is a named monorepo type. Union members
   (`string | LoginRequest`) are resolved individually.
8. **Line limit:** if a resolved type declaration exceeds 50 lines, truncate to the
   first 50 lines and set `truncated: true` on the entry. This prevents a large
   generated interface from bloating the response.

This saves the agent a predictable second tool call when it needs to understand a
function's contract in full.

**When used:** "What does this function accept and return, and what shape are those
types?" Replaces opening the file plus following imports to type definitions.

---

### `mast_callers`

Call sites of a named symbol, partitioned into **verified** and **potential** sets.
The split is fundamental to the tool's contract — see §10.3 for why.

**Input:**
```json
{
  "symbol": "handleLogin",
  "file_path": "api/services/auth/src/handler.ts",
  "transitive": false,
  "include_potential": true
}
```

- `transitive: true` returns callers of callers via recursive CTE on `POTENTIAL_CALL`
  edges (the verified set only — the recursion does not traverse `potential_matches`).
  Default is direct callers only.
- `include_potential: false` skips the `identifier_fts` query entirely. Useful when
  the agent wants only edges the resolver could statically link, accepting that the
  result is incomplete. Default is `true`.

**Output:** `CallersResponse`
```json
{
  "verified_callers": [
    {
      "file_path": "api/server/src/routes/auth.ts",
      "line": 28,
      "caller_symbol": "registerAuthRoutes",
      "context": "  return handleLogin(request, reply)",
      "resolution": "import"
    },
    {
      "file_path": "api/services/auth/src/middleware.ts",
      "line": 64,
      "caller_symbol": "AuthMiddleware.authenticate",
      "context": "    await this.handler.handleLogin(req, reply)",
      "resolution": "field_type"
    }
  ],
  "potential_matches": [
    {
      "file_path": "api/services/admin/src/audit-log.ts",
      "line": 142,
      "context": "  // TODO: emit event when handleLogin is called",
      "reason": "identifier_match_no_resolved_edge"
    }
  ],
  "summary": {
    "verified_count": 2,
    "potential_count": 1,
    "transitive": false
  }
}
```

**The two sets have different meanings.** Tools and prompts must treat them
differently:

- **`verified_callers`** — the local heuristic resolver (§10.3) statically linked the
  call site's receiver to the queried symbol. The `resolution` field names the rule
  that matched: `import` (top-level named import), `field_type` (`this.x` where `x` is
  a class field with a known type annotation), `parameter_type` (parameter property or
  annotated parameter), `new_expression` (`new Foo()`-style construction), or `same_file`
  (call site and definition in the same file). High confidence; safe to act on.

- **`potential_matches`** — `identifier_fts` matched the symbol name exactly inside a
  chunk, but the resolver could not statically link it. These are *candidates that
  require human or agent review* before any refactor proceeds. Common causes: factory
  patterns, DI container lookups, inferred types, dynamic dispatch, comments and
  string literals containing the identifier. The `reason` field is informational; v1
  always returns `identifier_match_no_resolved_edge`.

**Why partition rather than merge?** Mixing the two sets would force the agent to
treat every result as low-confidence, defeating the value of the verified set. Mixing
also means a single false-positive in the FTS hits can derail a refactor. The split
preserves "I know this is a caller" as a distinct, actionable category.

**Agent prompt guidance.** The implement-task prompt (§12) MUST instruct the agent:
"`verified_callers` are the impact set you can rely on. `potential_matches` are
mandatory review sites — open each one and confirm whether it is a real caller before
shipping a refactor."

**When used:** understanding impact before modifying a function. Sourced from
`graph.db` `edges` table (verified) + `identifier_fts` (potential). When
`transitive: true`, only the verified set recurses.

---

### `mast_dependencies`

Import graph for a file — what it imports and from where.

**Input:**
```json
{
  "file_path": "api/services/auth/src/handler.ts"
}
```

**Output:** `DependencyResult`
```json
{
  "file_path": "api/services/auth/src/handler.ts",
  "imports": [
    {
      "module": "@kluser-kinetic-01/shared",
      "symbols": ["UserId", "SessionToken"],
      "is_external": true
    },
    {
      "module": "../repository",
      "symbols": ["AuthRepository"],
      "is_external": false,
      "resolved_path": "api/services/auth/src/repository.ts"
    }
  ]
}
```

**When used:** understanding what a file pulls in before modifying it. Sourced from
`graph.db` `imports` table.

---

### `mast_implementors`

Concrete classes that implement a given interface.

**Input:**
```json
{
  "interface_name": "AuthRepository"
}
```

**Output:** array of `ImplementorResult`
```json
[
  {
    "class_name": "PostgresAuthRepository",
    "file_path": "api/services/auth/src/postgres-repository.ts",
    "line": 8,
    "methods": ["findByEmail", "createSession", "invalidateSession"]
  }
]
```

**When used:** finding the concrete implementation to follow as a pattern or extend.
Sourced from `graph.db` `edges` where `edge_type = 'IMPLEMENTS'`.

---

### `mast_reindex`

Synchronous incremental reindex. Does not return until the index reflects the current
state of the filesystem.

**Input:**
```json
{
  "full": false
}
```

`full: true` forces a complete reindex regardless of mtimes.

**Output:** `ReindexResult`
```json
{
  "files_indexed": 3,
  "files_skipped": 139,
  "chunks_added": 24,
  "chunks_removed": 18,
  "parse_errors": 0,
  "duration_ms": 380
}
```

`parse_errors > 0` means one or more files were skipped due to tree-sitter parse failures. The agent should call `mast_status` for details, or check the mast server log for the specific file paths.

**When used:** immediately after the agent writes or edits files, before querying for
symbols it just created. Called explicitly by the agent — not automatic.

---

### `mast_status`

Index health snapshot.

**Input:** none

**Output:** `StatusResult`
```json
{
  "state_dir": "/workspace/.kluster/.mast",
  "last_indexed": "2026-05-13T14:22:00Z",
  "indexed_files": 142,
  "chunk_count": 1840,
  "stale_files": 0,
  "pending_embeddings": 0,
  "parse_errors": 0,
  "index_fresh": true,
  "freshness_cause": null,
  "model": "jinaai/jina-embeddings-v2-base-code"
}
```

`parse_errors` is the count of files skipped during the last index run due to tree-sitter parse failures. Non-zero here indicates files the agent should investigate.

**Freshness diagnostics.** `stale_files` and `index_fresh` alone conflate two
very different states, so the snapshot separates them:

- `pending_embeddings` — chunks in `chunks.lance` whose **current** content has
  no stored vector, using §6.2's freshness rule (a chunk counts as embedded
  only when a stored vector matches BOTH its `chunk_id` AND its current
  `content_hash`). This is the same selection `runEmbed` uses to pick work, so
  the count and the embedder can never disagree. `doc` chunks (§10.1) are
  counted like any other chunk.
- `freshness_cause` — `"phase1_stale" | "embedding_backlog" | "both" | null`:
  - `"phase1_stale"` — `stale_files > 0`: chunk line coordinates lag disk;
    corrected by JIT re-parse on read (§9.0), or run `mast_reindex`.
  - `"embedding_backlog"` — `pending_embeddings > 0`: parsing is current but
    embeddings lag (the §11.1 cold-start window), so semantic ranking is
    degraded and `mast_search` may run in `lexical` mode until the background
    embedder catches up.
  - `"both"` — both conditions hold.
  - `null` — fully fresh.

`index_fresh` keeps its Phase 1-only meaning (no stale files, index exists);
an embedding backlog does **not** flip it — `freshness_cause` is additive
context.

**When used:** diagnostic — agent checks this when search returns unexpected
results. `freshness_cause` answers "why does search feel off?" directly:
`phase1_stale` → reindex; `embedding_backlog` → expect lexical-quality
ranking until Phase 2 completes.

---

### `mast_efficiency`

Rolling per-session and global token-savings telemetry. Designed to be called by the
agent periodically so it can self-correct when its tool usage is inefficient (e.g.,
falling back to full-file `Read` instead of `mast_search`).

**Input:**
```json
{
  "scope": "session | global",
  "since_minutes": 60
}
```

- `scope: "session"` aggregates only this `mast serve` session's calls. `scope: "global"`
  aggregates the persistent metrics table on the shared volume (see §14).
- `since_minutes` bounds the window for `scope: "global"`. Ignored when `scope` is
  `"session"`. Defaults to 60.

**Output:** `EfficiencyResult`
```json
{
  "scope": "session",
  "window_started_at": "2026-05-13T14:00:00Z",
  "tokens_returned": 18420,
  "tokens_full_file_upper_bound": 142880,
  "efficiency_ratio": 0.871,
  "calls_total": 47,
  "calls_by_tool": {
    "mast_search": 18,
    "mast_signature": 12,
    "mast_exports": 9,
    "mast_callers": 5,
    "mast_project_skeleton": 3
  },
  "tokenizer": "@anthropic-ai/tokenizer",
  "counterfactual": "Saved vs. full file Read (upper bound — overstates savings against a smart agent that would have used Grep)"
}
```

`efficiency_ratio` is `1 - (tokens_returned / tokens_full_file_upper_bound)`. Higher
is better; 0.871 means 87.1% fewer tokens than the "naive `Read` every result file"
counterfactual.

**Honest framing.** The counterfactual is explicitly labelled as an upper bound. An
agent using `Grep -A 10 -B 10` instead of `Read` would have used fewer tokens than
the counterfactual but more than MAST — the real savings sit between zero and the
reported ratio. The label exists so this number can survive a "is MAST worth it?"
review without being challenged as cherry-picked. See §14 for the methodology and
the SQLite metrics table schema.

**When used:** the agent calls this once per task (typically near the end) to see
whether its tool usage was efficient. The implement-task prompt (§12) instructs:
"If `efficiency_ratio < 0.30`, you are reading more than you should — prefer
`mast_search` over `Read` for the next task." This gives the agent an in-loop
feedback signal without humans needing to inspect logs.

---

## 10. AST Extraction

mast uses **tree-sitter** with `tree-sitter-typescript` for all AST operations.
tree-sitter is chosen over the TypeScript Compiler API for speed (C library, no
tsc overhead) and extensibility to other languages via grammar plugins.

### 10.1 Chunking Strategy

Chunks are **declaration-first**: each chunk maps to exactly one top-level AST
declaration. Line-based splitting is a fallback, not the primary strategy.

| Node type | `chunk_type` | `symbol_name` | `parent_symbol` | `is_exported` |
|---|---|---|---|---|
| `function_declaration` | `function` | function name | `null` | has `export` modifier |
| `arrow_function` → `const` | `function` | variable name | `null` | has `export` modifier |
| `class_declaration` | `class_shell` (synthesized) | class name | `null` | has `export` modifier |
| `method_definition` (inside class) | `method` | `ClassName.methodName` | class name | inherits from class **and** non-`private` |
| `interface_declaration` | `interface` | interface name | `null` | has `export` modifier |
| `type_alias_declaration` | `type` | type name | `null` | has `export` modifier |
| `export_statement` wrapping any above | inherits inner | inherits inner | inherits inner | `true` |
| Everything else at top level | `block` | `null` | `null` | `false` |

**Class decomposition: shell + methods.** A `class_declaration` node does NOT
become one chunk. The chunker emits:

1. **One `class_shell` chunk** whose `content` is the synthesized class outline:
   the class declaration line, all member signatures (methods, properties, getters,
   setters, constructors) with their leading TSDoc, but **no method bodies**. This
   is the "outline" view used for orientation and for `mast_signature` calls that
   target the class itself rather than a specific member.

2. **N `method` chunks**, one per `method_definition` (and `constructor`, getter,
   setter) inside the class body. Each method chunk has:
   - `symbol_name` qualified as `ClassName.methodName` (e.g. `AuthService.validateSession`,
     `AuthService.constructor`).
   - `parent_symbol` set to the enclosing class name (unqualified).
   - `is_exported` = class's `is_exported` **AND** method is not `private`. (Methods
     marked `protected` or with no accessibility modifier are treated as exported when
     the class is exported. This mirrors how callers from outside the class can reach
     them; `private` members are intentionally hidden from `only_exported: true`
     queries.)
   - Its own embedding, computed from the full method source (signature + body).
   - A `PARENT_OF` edge from the class's `symbols` row to the method's `symbols` row
     in `graph.db` (see §6.3).

3. **A `body_hash` for the class_shell** computed over the sorted concatenation of
   member signatures + member TSDoc (see §7.1 stability hash rule). This ensures
   the shell is re-embedded when methods are renamed, added, or removed — but **not**
   when method bodies change.

**Why this matters.** A 400-line service class becomes one ~30-line outline chunk
plus ~12 small method chunks (~30 lines each). `mast_search "validate session"`
returns the matching `method` chunk (~30 lines) instead of the whole class (400
lines). For class-heavy codebases the token savings move from "marginal" to
"material." Chunk count for a class-heavy 5K-file repo grows from ~6K to ~20–30K;
LanceDB handles this fine at sub-100MB index size, but the cold-start full-embed
math in §11.1 / §13.8 assumes the larger figure.

**Interfaces and type aliases are NOT decomposed.** Their members are signatures
already (no bodies to split), so the interface or type alias remains a single chunk.

**Anonymous default exports** (`export default function () {}`, `export default {}`):
`symbol_name` is set to the filename without extension (e.g., `handler` for
`handler.ts`). This is a heuristic and `mast_search` will surface these via FTS
on the filename. A future v2 may resolve the alias from importers, but v1 keeps it
simple.

**Re-export aliases** (`export { foo as bar } from './x'`): the chunker records
`bar` as an exported symbol in the local file's `symbols` row, with the
declaration site resolved through the `RE_EXPORTS` edge / `re_export_files` chain
(see §6.3). `mast_signature { symbol: "bar" }` walks the chain back to `foo`'s
real declaration.

**Implementation note — local aliases.** For a *local* alias
(`export { foo as bar }`, no `from`), the chunker does not use the
`RE_EXPORTS`-edge path above. It instead emits an extra chunk for `bar` that
mirrors `foo`'s declaration (own `chunk_id`, marked exported), and
`extractSignatures` emits a matching `bar` signature entry. This makes `bar`
discoverable (`mast_exports`/`mast_search`) and resolvable (`mast_signature`)
without a chain walk — same observable result, simpler mechanism. The aliased
local name (`foo`) is NOT itself marked exported, since the export name is `bar`.

**Two-pass walk for `is_exported`:**

TypeScript allows declarations to be exported separately from their definition:

```typescript
function internalHandle() { ... }
export { internalHandle as handleLogin };
export * from './other-module';
```

A single-pass walk that only checks for the `export` modifier on declarations would
mark `internalHandle` as not exported, which is wrong. The chunker uses a two-pass
walk:

- **Pass 1:** map all top-level symbol names to their declaration nodes and initial
  `is_exported` state (based on `export` modifier presence).
- **Pass 2:** walk all `export_clause` nodes (`export { ... }`) and
  `export_all_clause` nodes (`export * from ...`). For each named re-export, find
  the symbol in the Pass 1 map and set `is_exported = true`. For `export *`, mark the
  source module path for resolution — the graph populator will follow the edge.

**Split rule:** if a declaration spans more than `chunk_split_threshold` lines
(default: 100), split into overlapping sub-chunks with 10-line overlap. The first
sub-chunk always includes the full declaration header so signature extraction is
always possible from sub-chunk 0.

For the `jina-embeddings-v2-base-code` model with its 8k context window, most
functions will not trigger this split. The threshold exists for edge cases (large
generated files, data-heavy switch statements).

**Markdown documents (`chunk_type: "doc"`).** `.md` files are chunked by ATX
heading, not by AST — one chunk per heading of level ≤ `markdown_heading_depth`
(default 2: one chunk per `##` section). Doc chunks get embeddings and
`chunk_fts` rows like any other chunk, but **no graph presence**: no `symbols`
rows, no `imports`, no `edges`, and no `identifier_fts` rows (that index feeds
`mast_callers` potential_matches, where a doc that merely *mentions* a symbol
name is noise, not a call site).

Rules:

- `symbol_name` is the heading path — the file name, every ancestor heading,
  and the section's own heading joined with `" > "`, e.g.
  `MAST_SPEC.md > Technical Specification > 7. Index Lifecycle`. Skipped
  heading levels are omitted from the path.
- Headings deeper than `markdown_heading_depth` fold into their enclosing
  section's content.
- Content before the first boundary heading becomes a preamble chunk whose
  `symbol_name` is the file name alone. A file with no headings is one
  preamble chunk.
- `#` lines inside fenced code blocks (``` or ~~~) are not headings. Setext
  headings (`===`/`---` underlines) are not recognised — this repo's docs use
  ATX exclusively.
- `is_exported` is always `false` — `only_exported: true` searches exclude
  docs by construction. `parent_symbol` is always `null`; `language` is
  `markdown`.
- The split rule above applies to oversized sections (same window, overlap,
  and sub-chunk ID scheme as declarations).
- No `context_lines` expansion: sections are self-delimiting, and expansion
  would duplicate neighbouring sections' text into every chunk.
- Doc chunks carry no stability hashes, so the incremental "unchanged file"
  fast path conservatively rewrites a markdown file whose mtime changed
  (same treatment as files containing `block` chunks).

### 10.2 Signature Extraction

For `mast_signature` and the signature field in `mast_exports`:

1. Locate the declaration node by symbol name via tree-sitter query.
2. Extract node text up to (not including) the `statement_block` child (`{ ... }` body).
3. For interfaces and type aliases: the full declaration is the signature — no body
   exists to strip.
4. Walk backwards from the declaration's start byte to find the immediately preceding
   `comment` node. Accept `/** ... */` (TSDoc) or `// ...` (line comment). Include
   as `doc`.

### 10.3 Knowledge Graph Population

After Phase 1 chunking, mast populates `graph.db` for each indexed file:

- **`imports`**: parse each `import_statement`. Extract module specifier and named
  imports. Resolve relative paths against `project_root` for local modules. The
  resolved imports double as the input to the **local type environment** (see
  §10.3.1) used by the `POTENTIAL_CALL` resolver.
- **`symbols` rows**: insert a row for each top-level declaration AND each
  `method_definition` inside a class. Method symbols carry qualified names
  (`ClassName.methodName`) and a `PARENT_OF` edge from the class symbol — see §10.1
  class decomposition.
- **`POTENTIAL_CALL` edges**: within function and method bodies, find `call_expression`
  nodes. Run the local heuristic resolver (§10.3.1) against the receiver to identify
  the callee symbol. Only insert an edge when the resolver returns a single known
  indexed symbol; skip external library calls and unresolved receivers (those are
  surfaced as `potential_matches` in `mast_callers` via `identifier_fts`, not as
  edges).
- **`IMPLEMENTS` / `EXTENDS` edges**: from `class_declaration` nodes with
  `implements_clause` or `extends_clause`, resolve the named type and insert the edge.
- **`identifier_fts` rows**: extract every identifier token in the chunk (function
  names, method names, type names, variable references) via tree-sitter `identifier`
  node enumeration. Deduplicate per chunk. Insert one row per chunk with
  whitespace-joined identifiers — this is what `mast_callers`'s `potential_matches`
  query hits.

All inserts for a file are wrapped in a single transaction. On incremental reindex,
existing rows for the file are deleted before reinsertion (delete-and-replace, not
upsert), which keeps the graph consistent with renames and deletions.

### 10.3.1 Local Type Environment (POTENTIAL_CALL Resolver)

The `POTENTIAL_CALL` edge type is named for what it actually is: a name-resolved
reference whose receiver was statically linkable to a known symbol. There is no full
TypeScript type-checker in mast; the resolver is a deliberately scoped set of
heuristics that catches the high-frequency cases without bringing `tsserver` into
the indexer.

**What the resolver catches (will produce a `POTENTIAL_CALL` edge):**

1. **Top-level named imports.** `import { handleLogin } from './handler'; handleLogin(req, reply)`
   → resolves `handleLogin` via the `imports` table to a known symbol.
2. **Class field types** (annotated). `private userRepo: UserRepository` followed
   somewhere in the class body by `this.userRepo.findByEmail(email)` → resolves
   `findByEmail` to `UserRepository.findByEmail`. The field's type annotation must
   be a named type the resolver can find via `imports` or same-file `symbols`.
3. **Constructor parameter properties.** `constructor(private readonly users: UserRepository)`
   creates an implicit field; `this.users.create(input)` resolves the same way as (2).
4. **Annotated parameters in any function/method.** `function foo(repo: UserRepository) { repo.findById(id) }`
   → resolves `findById` to `UserRepository.findById`.
5. **`new` expressions.** `const repo = new UserRepository(); repo.findById(id)` →
   the resolver tracks `repo`'s inferred type as `UserRepository` for the rest of the
   block (or until shadowed) and resolves the chained call.
6. **Same-file function calls.** A function calling another function in the same file
   resolves directly via the local `symbols` table.

**What the resolver does NOT catch (will NOT produce a `POTENTIAL_CALL` edge — but
the identifier match still lands in `identifier_fts` and surfaces as
`potential_matches`):**

- **Factory return types without annotation.** `const repo = makeRepository(); repo.findById(id)`
  — `repo`'s type is inferred and the resolver does not run inference.
- **DI container lookups.** `container.get(UserRepository).findById(id)` — the
  generic erases at the resolver level.
- **Chained calls without intermediate binding.** `getUserService().findById(id)`.
- **Dynamic dispatch.** `repos[name].findById(id)`.
- **Re-exported types not yet resolved through the `re_export_files` chain at edge
  time.** Resolution can be deferred: edges are inserted on a second pass after all
  symbols are populated (see "Two-pass edge insertion" below).
- **Generic type parameters.** `class Repo<T> { find(id: ID): T }` — the resolver
  treats `T` as opaque.

**Coverage characterisation.** In a Fastify + DI service codebase, the resolver
catches roughly the field/parameter/import cases — typically 60–80% of real call
sites depending on how heavily the codebase uses factories and containers. The
intentional design choice is: when in doubt, do NOT produce a `POTENTIAL_CALL` edge,
and rely on `identifier_fts` + the `mast_callers` `potential_matches` set to catch
the rest. False negatives in the verified set are acceptable; false positives would
poison the contract.

**Two-pass edge insertion.** Because cross-file references depend on all symbols
being in the table first, edge insertion runs as a second pass after Phase 1's
symbol-population pass completes for the entire indexed file set. This means a full
reindex has the ordering: walk all files → insert all chunks + symbols → re-walk
all files → insert all edges. On incremental reindex, only the affected files are
re-walked in pass two, but all of `graph.db`'s `symbols` table is queryable so cross-
file references resolve correctly.

**Method calls on `super` and `this` without receiver.** `this.foo()` resolves to
the enclosing class's `foo` method via the qualified `symbols` row. `super.foo()`
resolves to the parent class via the `EXTENDS` edge.

---

## 11. Hook Architecture

### 11.1 Primary Hook — `mast serve` Startup

Defined in full in §7.4. Summary: a four-step ladder that brings the discovery
layer (graph + FTS) online in 2–4 seconds via a Docker-baked seed index (§13.8),
then warms the semantic layer (embeddings) in a forked child process while MCP
connections are already being served. `mast_search` reports `mode: "lexical"`
during the warm-up window and `mode: "hybrid"` once embeddings complete.

This is the **only hook required for the SDD pipeline**.

### 11.2 Mid-Task Hook — `mast_reindex` (agent-controlled)

The agent calls this explicitly after writes. The implement prompt instructs:

> After writing or editing files, call `mast_reindex` before any search query that
> depends on symbols you just created. This is the only way to guarantee the index
> reflects your changes within this task.

### 11.3 Optional Developer Hooks — Git

Installed by `mast install-hooks`:

**`.git/hooks/post-commit`**
```bash
#!/bin/sh
mast index "$(git rev-parse --show-toplevel)" --incremental
```

**`.git/hooks/post-checkout`**
```bash
#!/bin/sh
mast index "$(git rev-parse --show-toplevel)" --incremental
```

Not required for the automated SDD pipeline — the startup hook covers the same
scenario (files changed since last index).

---

## 12. SDD Pipeline Integration

### 12.1 One-Time Setup

Add to `kluster init` or run manually once per project:

```bash
mast init /path/to/app --state-dir .kluster/.mast
```

### 12.2 `implement-task.md` Prompt Changes

Replace the existing `codemogger` MANDATORY FIRST ACTION block with:

```markdown
## MANDATORY FIRST ACTION — NO EXCEPTIONS

Before writing any code, before opening any file:

1. Get a project overview:
   mast_project_skeleton — see all files and their exported symbols in one call

2. Run at least 2 targeted searches:
   mast_search: { "query": "<relevant symbols or concepts>", "only_exported": true }
   mast_search: { "query": "existing patterns conventions types" }

3. Use mast_exports to inspect a file's API before opening it:
   mast_exports: { "file_path": "src/services/auth/index.ts" }

4. Use mast_signature to get a function's contract (includes parameter type shapes):
   mast_signature: { "symbol": "handleLogin" }

After writing or editing files, call mast_reindex before searching for symbols
you just created:
   mast_reindex: {}
```

### 12.3 What the BT Pipeline Does Not Need to Change

- No new `execute-command` nodes in any YAML.
- No changes to `run-task.yaml` or `implement.yaml`.
- The only addition is the `mast` entry in the claude-runner `.mcp.json`.

---

## 13. Implementation Notes

### 13.1 Language

TypeScript (Node.js LTS). Rationale:

- Fits the existing monorepo stack — no second language in the container.
- The MCP TypeScript SDK (`@modelcontextprotocol/sdk`) is Anthropic's primary SDK
  and has the best type safety and first-class support.
- Eliminates `torch` from the Docker image — ONNX runtime + Jina model weights is
  ~300MB vs ~3GB for Python + torch.
- `better-sqlite3`'s synchronous API removes async complexity from graph queries;
  the recursive CTEs are blocking operations anyway.

### 13.2 Dependency Map

| Concern | Package | Notes |
|---|---|---|
| MCP server | `@modelcontextprotocol/sdk` | Official TS SDK, stdio transport |
| Vector storage | `@lancedb/lancedb` | Official JS SDK |
| Embeddings | `@huggingface/transformers` | Transformers.js v3 — runs models via ONNX in Node.js, no torch required |
| BM25 | SQLite FTS5 (built-in) | Replaces external BM25 dependency entirely; `trigram` tokenizer for code identifiers |
| Knowledge graph | `better-sqlite3` + `@types/better-sqlite3` | Synchronous API, WAL mode, recursive CTEs |
| AST parsing | `tree-sitter` + `tree-sitter-typescript` | Official Node.js bindings + TypeScript grammar |
| Path resolution | `tsconfig-paths` | Resolves tsconfig `paths` aliases at index time |
| Validation | `zod` | MCP tool inputs cross a trust boundary; validate `symbol`, `file_path`, `max_depth`, etc. before hitting the DB |
| Locking | `proper-lockfile` | PID-based advisory lock; set `stale: 10000` (10s) to handle abrupt container exits |
| CLI | `commander` | Standard TS CLI |
| File walking | `fast-glob` | Glob pattern support for `exclude_patterns` |

### 13.3 Embedding Model Verification

Before implementation, confirm that `jinaai/jina-embeddings-v2-base-code` runs
correctly through Transformers.js at the full 8k context window. Jina publishes ONNX
weights on the Hub which is what Transformers.js consumes, but the 8k context
behaviour needs to be validated.

Fallback options if the primary model has issues:
1. `Xenova/jina-embeddings-v2-base-code` — community-converted ONNX version
2. `nomic-ai/nomic-embed-code` — confirmed Transformers.js compatible, strong code
   retrieval performance

### 13.4 Project Structure

```
packages/mast/
├── src/
│   ├── cli/
│   │   ├── index.ts                 # commander entry point — mast <command>
│   │   ├── init.ts
│   │   ├── index-cmd.ts             # `mast index` (avoids conflict with src/index.ts)
│   │   ├── serve.ts
│   │   ├── status.ts
│   │   ├── metrics.ts               # `mast metrics --session|--global|--rollup` (§14)
│   │   └── install-hooks.ts
│   ├── mcp/
│   │   ├── server.ts                # MCP server setup, tool registration
│   │   ├── staleness.ts             # stat-and-sync wrapper for all read tools (§9.0)
│   │   └── tools/
│   │       ├── search.ts            # hybrid/lexical mode-aware (§9 mast_search)
│   │       ├── project-skeleton.ts
│   │       ├── exports.ts
│   │       ├── signature.ts
│   │       ├── callers.ts           # verified + potential partition (§9 mast_callers)
│   │       ├── dependencies.ts
│   │       ├── implementors.ts
│   │       ├── reindex.ts
│   │       ├── status.ts
│   │       └── efficiency.ts        # mast_efficiency telemetry tool (§9, §14)
│   ├── indexer/
│   │   ├── index.ts                 # orchestrates Phase 1 + Phase 2
│   │   ├── walker.ts                # file discovery, exclude pattern matching
│   │   ├── chunker.ts               # tree-sitter AST → Chunk[] incl. class decomposition (§10.1)
│   │   ├── embedder.ts              # Chunk[] → vectors (in-process implementation)
│   │   └── background-embedder.ts   # child_process.fork() host for Phase 2 (§7.4, §11.1)
│   ├── graph/
│   │   ├── db.ts                    # better-sqlite3 connection + schema init
│   │   ├── populate.ts              # AST → graph.db inserts (two-pass edge insertion, §10.3)
│   │   ├── queries.ts               # callers, implementors, dependencies, type-context
│   │   └── local-type-env.ts        # POTENTIAL_CALL resolver heuristics (§10.3.1)
│   ├── ast/
│   │   ├── parser.ts                # tree-sitter setup, parse file → AST
│   │   ├── extractor.ts             # LanguageExtractor contract + FileExtraction types
│   │   ├── extract.ts               # extension dispatch → per-language extractor
│   │   ├── extractors/
│   │   │   ├── typescript.ts       # TS/JS: class-shell synth, method walk, hashes
│   │   │   └── markdown.ts         # heading-based doc chunking (§10.1)
│   │   └── types.ts                 # Chunk, Export, SignatureResult shared types
│   ├── store/
│   │   ├── lance.ts                 # LanceDB connection, chunks + vectors table ops
│   │   ├── config.ts                # config resolution, index.json read/write
│   │   └── lock.ts                  # structure.lock + vectors.lock manager (§7.6)
│   ├── search/
│   │   ├── hybrid.ts                # RRF fusion (mode: "hybrid"); falls through to FTS-only when mode: "lexical"
│   │   ├── vector.ts                # LanceDB vector search
│   │   └── fts.ts                   # FTS5 queries (chunk_fts BM25 + identifier_fts exact match)
│   └── telemetry/
│       ├── metrics.ts               # metrics table writes, _stats meta builder (§14)
│       └── tokenizer.ts             # @anthropic-ai/tokenizer wrapper for counterfactuals
├── package.json
└── tsconfig.json
```

**Language extensibility pattern:** `extract.ts` dispatches by file extension to a
per-language extractor module in `ast/extractors/`. Each extractor implements the
`LanguageExtractor` contract (defined in `ast/extractor.ts`) and owns its **full**
extraction story — parsing strategy included:

```typescript
interface LanguageExtractor {
  language: Language;                          // "typescript" | "markdown" | ...
  extensions: readonly string[];               // [".ts", ".tsx"]
  extract(src: string, filePath: string, fileMtime: number,
          options: ExtractorOptions): FileExtraction;
}

interface FileExtraction {
  language: Language;                          // concrete language of THIS file
  chunks: readonly Chunk[];
  symbols: readonly SymbolRecord[];            // empty for graph-less languages
  imports: readonly ImportRecord[];
  edges: readonly EdgeRecord[];
  identifierRows: readonly IdentifierRow[];    // identifier_fts rows per chunk
}
```

The contract is deliberately parser-agnostic: the TypeScript extractor parses with
tree-sitter internally (and keeps `declarationHash`/`bodyHash` as its own methods),
while the markdown extractor line-scans — the pipeline never sees a `Tree` and
never branches on language. `identifierRows` are produced by the extractor rather
than the graph layer because what counts as an "identifier" is a language-level
judgment: markdown contributes none, since `identifier_fts` feeds `mast_callers`
potential_matches and prose mentions are not call sites.

Two extractors ship today: `typescript.ts` (`.ts`, `.tsx`, `.js`, `.jsx`) and
`markdown.ts` (`.md`, §10.1 doc chunking). Adding Go or Python means adding a new
extractor module and a `tree-sitter-<lang>` package — no changes to core indexer
logic. Do not use tree-sitter `.scm` query files; the extractor function approach
is sufficient and keeps the build simple.

### 13.7 Path Resolution

Monorepo imports use two alias systems that both need resolving to physical file paths
for the knowledge graph edges and `type_context` lookups to work:

**1. tsconfig `paths` aliases** (e.g. `@api/types` → `./src/types/index.ts`)

Read the nearest `tsconfig.json` at `mast init` time using `tsconfig-paths`. Build a
resolver function `resolveAlias(alias: string, fromFile: string): string | null` that
is passed into Phase 1 and used wherever `resolved_path` is written to the `imports`
table.

**2. pnpm workspace package names** (e.g. `@kluster-kinetic-01/shared`)

Walk the workspace root `pnpm-workspace.yaml` (or `workspaces` field in root
`package.json`) at startup. For each matched package directory, read its
`package.json` `name` field. Build a map `{ packageName → packageDir }`. When an
import module matches a package name, resolve to `<packageDir>/src/index.ts` (or the
`main`/`exports` field in that package's `package.json`).

**pnpm symlink handling:** pnpm links workspace packages into `node_modules` as
symlinks. A naive resolver may return a path under `node_modules/@pkg/shared` (the
symlink) rather than `packages/shared/src/index.ts` (the real file). The `files`
table indexes real paths, so a symlink path would produce a graph edge pointing to a
path that does not exist in the index. Always call `fs.realpathSync()` on the resolved
path before writing it to `resolved_path`. This collapses symlinks to their canonical
source paths, ensuring graph edges connect correctly.

Both resolvers are composed: alias resolution runs first, workspace resolution second,
`realpathSync` applied last. External modules (no match in either resolver) leave
`resolved_path = NULL` in the `imports` table.

This resolver is initialised once at `mast serve` startup and at the start of each
`mast index` run.

### 13.8 Dockerfile Pre-Warming

Two assets are pre-warmed during `docker build` to eliminate cold-start dead
time on the first container run. Without these, the first task can stall for
10+ minutes while model weights download and the index builds from scratch —
the single biggest UX risk identified in the design review (Failure 4).

#### 13.8.1 Model Weights Pre-Warm

Transformers.js downloads model weights to a local cache on first use. Without
pre-warming, the first task container stalls for 30–60 seconds while the 140MB Jina
model downloads. Pre-warm during `docker build`.

**Important:** Transformers.js does not read `HF_HOME` or `TRANSFORMERS_CACHE`.
Cache location is controlled via `env.cacheDir` — a runtime JavaScript property, not
an environment variable (verified against Transformers.js docs). The pre-warm script
must set this property explicitly:

```dockerfile
RUN node --input-type=module << 'EOF'
import { pipeline, env } from '@huggingface/transformers';
env.cacheDir = '/opt/transformers-cache';
await pipeline('feature-extraction', 'jinaai/jina-embeddings-v2-base-code');
process.exit(0);
EOF
```

The same `env.cacheDir = '/opt/transformers-cache'` assignment must appear in
`embedder.ts` and `background-embedder.ts` at module initialisation time, before
the first `pipeline()` call. Otherwise Transformers.js defaults to
`./node_modules/@huggingface/transformers/.cache/` and misses the baked layer
entirely.

#### 13.8.2 Seed Index Pre-Warm

For a 5K-file class-heavy repo, Phase 1 + Phase 2 from scratch is 10–30 minutes.
During that window the agent has no semantic search and limited graph data. The
seed index moves this work into the Docker build, so the runtime container
starts with a fully-warmed index for the build-time commit.

```dockerfile
# After the application source is copied into the image and dependencies installed:
RUN mast init /workspace --state-dir /opt/mast-seed --no-index \
 && mast index /workspace --state-dir /opt/mast-seed
```

Two important properties of the seed:

1. **Phase 1 + Phase 2 both run at build time.** The seed contains a fully-populated
   `chunks.lance`, `vectors.lance`, `graph.db`, `chunk_fts`, and `identifier_fts`. The
   runtime container starts in `mode: "hybrid"` immediately (Step 3 of §7.4) — no
   warm-up window.
2. **Frozen at build commit.** The seed reflects whatever code was in the image at
   `docker build` time. Files modified since the build commit are picked up by
   §7.4 Step 4's filesystem scan (a few seconds for typical incremental staleness),
   and uncommitted-tree edits trigger JIT re-parse on first query (§9.0).

**Runtime copy.** The container entrypoint runs:

```bash
#!/bin/sh
if [ -z "$(ls -A /workspace/.kluster/.mast 2>/dev/null)" ]; then
  cp -r /opt/mast-seed/. /workspace/.kluster/.mast/
fi
exec mast serve --state-dir /workspace/.kluster/.mast
```

The copy is conditional on the workspace state being empty. Subsequent container
starts on the same mounted volume reuse the existing state (which may have
already-applied incremental updates from prior tasks).

**Seed commit field on `mast_status`.** When the seed is copied, `index.json`
records `seed_commit: "<git-rev>"` so `mast_status` can report:

```
seed_commit:    abc1234 (built 2026-05-10T12:00:00Z)
last_indexed:   2026-05-13T14:22:00Z
files_since_seed: 47
```

This makes "why does the index look stale?" debuggable without opening
`file_manifest.json` by hand.

**Schema-bump invalidation.** On startup (§7.4 Step 2), if
`index.json.schema_version != CURRENT_SCHEMA_VERSION`, both the runtime state
AND the seed are considered invalid. The state is wiped and a full reindex runs
in the background (Step 4). The seed in `/opt/mast-seed` is not re-built —
that's the next image build's job — but it is ignored on this run.

### 13.10 What to Keep from mcp-vector-search (as reference only)

mcp-vector-search is a Python codebase — nothing is reused directly. It serves as a
reference for:

- LanceDB two-phase table schema (chunks + vectors)
- RRF fusion logic
- Incremental indexing strategy (mtime-based staleness)
- Embedding cache design (content-hash keyed)

### 13.11 Distribution

```
pip install          # not applicable
npm install -g mast-search    # installs CLI + MCP server
```

For the SDD pipeline, mast is installed into the claude-runner Docker image. The Jina
ONNX model weights (~140MB) are pre-downloaded into the image layer to avoid first-use
download latency inside a task container.

For external developers:

```bash
npm install -g mast-search
mast init .                      # initialise index
claude mcp add mast -- mast serve   # wire into Claude Code
```

A `--no-embeddings` install flag (omits `@huggingface/transformers` and ONNX runtime)
enables a lightweight mode where `mast_search` falls back to BM25-only. All AST tools
(`mast_exports`, `mast_signature`, `mast_project_skeleton`, `mast_callers`) work
without embeddings since they are pure tree-sitter + SQLite operations.

---

## 14. Telemetry & Measurement

The MAST thesis is **chunks not files → fewer tokens per task**. If that claim is
not measurable, the index, the embedder, the model weights, and the Docker layers
that support them are a complexity budget the project cannot defend. This section
specifies the instrumentation that makes the savings legible to humans (`mast metrics`),
visible to the agent (`mast_efficiency`), and persistent across sessions (the SQLite
`metrics` table).

### 14.1 Goals

- **Defensible savings number.** When asked "is MAST worth it?", produce a chart-backed
  answer with a documented methodology, not a vibe.
- **In-loop agent feedback.** The agent can call `mast_efficiency` to see whether its
  own tool usage was efficient, and self-correct on subsequent tasks.
- **Per-task attribution.** The SDD pipeline (§12) captures one `mast metrics --session`
  snapshot per task so savings can be analysed by task type.
- **Negligible overhead.** Instrumentation must add < 1ms per tool call; write-heavy,
  read-light.

### 14.2 The `_stats` Meta Field

Every read tool (`mast_search`, `mast_signature`, `mast_exports`,
`mast_project_skeleton`, `mast_callers`, `mast_dependencies`, `mast_implementors`)
attaches a `_stats` object to its response:

```json
{
  "results": [ /* ... tool-specific shape ... */ ],
  "_stats": {
    "tool": "mast_search",
    "tokens_returned": 412,
    "tokens_full_file_upper_bound": 3187,
    "files_referenced": ["api/services/auth/src/handler.ts", "api/services/auth/src/repository.ts"],
    "efficiency_ratio": 0.871,
    "duration_ms": 38,
    "mode": "hybrid"
  }
}
```

- `tokens_returned` — token count of the serialised response body using
  `@anthropic-ai/tokenizer` (see §14.5).
- `tokens_full_file_upper_bound` — sum of `@anthropic-ai/tokenizer` counts over the
  full contents of every unique file referenced in the results. This is the "what
  a naive `Read` of every result file would have cost" counterfactual.
- `efficiency_ratio` — `1 - (tokens_returned / tokens_full_file_upper_bound)`. Always
  in `[0, 1]`. Higher is better.
- `duration_ms` — wall-clock time for the tool call, including JIT staleness
  re-parse if triggered.
- `mode` — present only on `mast_search`; mirrors the top-level `mode` field.

**Honest framing.** `tokens_full_file_upper_bound` is explicitly labelled as an upper
bound. A smart agent using `Grep -A 10 -B 10` would have used fewer tokens than the
upper bound but more than MAST — the real saving sits between zero and `efficiency_ratio`.
Reporting the upper bound is defensible because the methodology is documented and
the label is honest. Reporting "X% savings" with no upper-bound qualifier would not
survive scrutiny.

### 14.3 The `metrics` Table

Telemetry persists in `graph.db` (same SQLite database as the knowledge graph; one
fewer connection to manage):

```sql
CREATE TABLE IF NOT EXISTS metrics (
  id                              INTEGER PRIMARY KEY,
  tool_name                       TEXT NOT NULL,
  call_timestamp                  REAL NOT NULL,           -- unix epoch seconds (REAL for sub-second precision)
  tokens_returned                 INTEGER NOT NULL,
  tokens_full_file_upper_bound    INTEGER NOT NULL,
  duration_ms                     INTEGER NOT NULL,
  mode                            TEXT,                    -- "hybrid" | "lexical" | NULL
  session_id                      TEXT NOT NULL,           -- uuid set at mast serve startup
  status                          TEXT NOT NULL            -- "ok" | "stale_returned" | "error"
);

CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics(call_timestamp);
CREATE INDEX IF NOT EXISTS idx_metrics_tool      ON metrics(tool_name);
CREATE INDEX IF NOT EXISTS idx_metrics_session   ON metrics(session_id);

CREATE TABLE IF NOT EXISTS metrics_daily (
  -- Pre-aggregated rollup; populated by `mast metrics --rollup`.
  day                             TEXT PRIMARY KEY,        -- ISO date, e.g. "2026-05-13"
  tool_name                       TEXT NOT NULL,
  calls                           INTEGER NOT NULL,
  tokens_returned_total           INTEGER NOT NULL,
  tokens_full_file_total          INTEGER NOT NULL,
  avg_duration_ms                 REAL NOT NULL,
  PRIMARY KEY (day, tool_name)
);
```

**Writes are non-blocking.** `metrics.ts` enqueues writes on a per-tick batch
(flushed every 1s or every 100 rows, whichever comes first) so the metrics path
never blocks a tool response. Worst-case data loss on abrupt container exit is one
flush window's worth of rows; acceptable for a savings metric.

### 14.4 Rotation Policy

A 5K-file repo with ~50 tool calls per task × ~30 tasks per day produces ~1,500
metrics rows per day. The table needs rotation to keep `SUM()` queries fast.

- `mast metrics --rollup` (run weekly via a cron-style hook, or manually): aggregates
  rows older than 30 days into the `metrics_daily` table, then deletes the raw rows.
- `mast metrics --vacuum`: runs `VACUUM` on `graph.db` after a rollup to reclaim
  space.
- The rollup is non-destructive at the daily level: 90-day or 1-year historical
  analysis still works against `metrics_daily`.

### 14.5 Tokenizer Choice

`@anthropic-ai/tokenizer` is the ground truth for the agent that consumes MAST output.
Use it directly when counting `tokens_returned` and `tokens_full_file_upper_bound`.

```typescript
import { countTokens } from "@anthropic-ai/tokenizer";
const n = countTokens(responseBodyAsString);
```

If `@anthropic-ai/tokenizer` is unavailable in a given environment (e.g., distribution
to non-Claude consumers via `npm install -g`), fall back to `tiktoken` with the
`cl100k_base` encoding, which approximates Claude tokenization within ±5–10% on
code. The active tokenizer is reported in `mast_efficiency`'s output (`tokenizer`
field) and in `mast metrics`'s footer, so consumers can interpret the numbers
correctly.

### 14.6 CLI: `mast metrics`

```
Usage: mast metrics [options]

Options:
  --session            Aggregate only this `mast serve` session (in-memory + table for current session_id)
  --global             Aggregate the persistent table (default)
  --since <duration>   e.g. "1h", "24h", "7d", "30d" (default: 24h for --global)
  --by-tool            Break down by tool_name
  --rollup             Aggregate rows older than 30 days into metrics_daily, then delete raw rows
  --vacuum             Run VACUUM after rollup
  --json               Machine-readable output
```

Sample output (`mast metrics --since 7d --by-tool`):

```
MAST efficiency report — 7 days ending 2026-05-13T14:22:00Z
Tokenizer: @anthropic-ai/tokenizer

Tool                    Calls   Returned    Counterfactual   Efficiency
─────────────────────────────────────────────────────────────────────────
mast_search              1,847   742,103     5,891,204         87.4%
mast_signature             912    91,820     2,104,447         95.6%
mast_exports               408    33,041       891,228         96.3%
mast_project_skeleton      127     8,209       412,005         98.0%
mast_callers               321    42,118       984,217         95.7%
mast_dependencies          156    12,047       512,180         97.6%
mast_implementors           88     6,213       198,402         96.9%
─────────────────────────────────────────────────────────────────────────
TOTAL                    3,859   935,551    11,003,683         91.5%

Counterfactual = "Saved vs. full file Read" (upper bound — see §14.2)
```

### 14.7 SDD Pipeline Integration

The SDD task pipeline (§12) adds one step to its task wrap-up:

```yaml
# packages/workbench/sdd/flows/strategies/task-pipeline/run-task.yaml (excerpt)
- execute-command:
    name: capture_mast_metrics
    cmd: mast metrics --session --json > {task_history_dir}/mast-metrics.json
    run_after: [implement_task, review_task]
```

This produces one `mast-metrics.json` per task in the per-task history directory.
Retrospective analysis ("does MAST save more on bug fixes than on feature additions?")
becomes a `jq` over those files, not a re-run of the entire pipeline.

### 14.8 Agent Feedback Loop

The `mast_efficiency` MCP tool (§9) exposes `_stats` aggregates back to the agent
within the conversation. The implement-task prompt (§12) instructs:

> Near the end of your task, call `mast_efficiency { "scope": "session" }`. If
> `efficiency_ratio < 0.30`, you have been reading more than you should — prefer
> `mast_search` over `Read` for the next task. If `efficiency_ratio > 0.85`, you
> are using MAST well; keep going.

This is the load-bearing reason for `mast_efficiency`'s existence as an MCP tool
rather than a CLI-only command: **the instrumentation has to have at least one
consumer inside the agent loop**, or it rots from disuse.

### 14.9 What Is Deliberately Not Measured

- **Latency p99.** Tool call duration is captured per-row, but no SLA is asserted
  on it. Latency optimisation comes after the savings thesis is validated.
- **Cache hit rate on embeddings.** Useful for indexer tuning but not for the
  savings question; deferred to v2.
- **Per-user / per-agent attribution.** v1 has one agent per `mast serve` session;
  multi-tenancy is out of scope.
