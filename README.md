# MAST — Monorepo AST Search Tool

MAST is a semantic code-search engine that runs as either an MCP server (for AI assistants) or a standalone CLI. It parses TypeScript and JavaScript source files with a real AST parser, stores the resulting symbol graph and code chunks in SQLite and LanceDB, and answers queries using hybrid BM25 + vector search fused via Reciprocal Rank Fusion.

The core design principle: **return exactly the code an assistant needs, nothing more**. Rather than reading entire files, MAST returns the specific function, interface, or type declaration that matches a query — saving tokens, reducing context noise, and letting AI tools navigate large codebases without drowning in irrelevant content.

---

## Contents

- [Why MAST?](#why-mast)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [CLI Reference](#cli-reference)
- [MCP Tool Reference](#mcp-tool-reference)
- [Configuration](#configuration)
- [How It Works](#how-it-works)
- [Token Efficiency](#token-efficiency)

---

## Why MAST?

When an AI assistant needs to understand code, the naive approach is to read full files. This wastes tokens (most of a 200-line file is irrelevant to the question), inflates context windows, and forces the model to filter signal from noise on every call.

MAST takes a different approach:

- **AST-level chunking** — every function, class, interface, and type alias is its own chunk. The assistant gets the exact declaration it needs, not the file it happens to live in.
- **Hybrid search** — BM25 handles identifier names and keyword queries; vector search handles semantic similarity. Both are fused via Reciprocal Rank Fusion so neither signal drowns out the other.
- **Structural queries** — "who calls this function?", "what implements this interface?", "what does this file import?" are answered from a pre-built symbol graph, not by grepping source. Answers are instantaneous and structurally correct.
- **JIT staleness detection** — on every read, MAST checks whether the file on disk has changed since it was last indexed. If it has, the file is transparently re-parsed in the background before the result is returned. The index never goes stale without the assistant knowing.
- **Token accounting** — every tool response includes `_stats` with the token count returned and the counterfactual "what would a naive full-file read have cost?", giving a concrete measure of efficiency over time.

---

## Requirements

- **Node.js** ≥ 24.0.0
- **pnpm** (this package is part of a pnpm workspace)
- The `tree-sitter` native addon requires a C++ build toolchain (`node-gyp`)
- **Embedding model** — `jinaai/jina-embeddings-v2-base-code` (~300 MB ONNX weights) is downloaded automatically by `@huggingface/transformers` on the first `mast index` or `mast serve` run. The weights are cached to `~/.cache/huggingface/hub` (HuggingFace default) unless overridden. In Docker, the path `/opt/transformers-cache` is used instead — pre-bake the weights into the image to avoid a download on every container start. Vector search is not available until the download completes; the server serves BM25-only (`"lexical"` mode) in the meantime.

---

## Installation

Within the monorepo:

```bash
pnpm --filter @kluster/mast build
```

After building, the `mast` CLI is available as `./dist/cli/index.js` or via the workspace `bin` link.

To use as an MCP server in Claude Desktop or another MCP client, add it to your MCP config:

```json
{
  "mcpServers": {
    "mast": {
      "command": "node",
      "args": ["/path/to/kluster/packages/mast/dist/cli/index.js", "serve"],
      "env": {
        "MAST_STATE_DIR": "/path/to/project/.mast"
      }
    }
  }
}
```

---

## Quick Start

```bash
# Initialise and index a project (run once)
mast init /path/to/project

# Start the MCP server (background; connects to Claude Desktop via stdio)
mast serve

# Search from the CLI
mast index --incremental          # update changed files only
mast status                       # check freshness
mast metrics --since 7d           # token-efficiency report
```

After `mast init`, the state directory (`.mast/` by default) contains the SQLite graph database, LanceDB vector tables, embedding cache, and lock markers. Everything is local — no external services required.

---

## CLI Reference

### `mast init [path]`

Initialise MAST for a project and run the initial full index.

```
Options:
  --state-dir <dir>        Where to write index state (default: <path>/.mast)
  --extensions <ext,...>   File extensions to index (default: .ts,.tsx,.js,.jsx)
  --exclude <pattern,...>  Glob patterns to exclude
  --no-index               Create config only; skip initial indexing
```

**Why:** Creates the state directory structure, writes `config.json`, and runs a full parse + symbol extraction pass. Running this once upfront means subsequent incremental runs only touch changed files.

---

### `mast index [path]`

Build or update the index.

```
Options:
  --state-dir <dir>    State directory
  --incremental        Only reindex files changed since last run
  --phase1-only        Parse and chunk only; skip embedding
```

**Why incremental:** The incremental path diffs the current file manifest against stored mtimes. Only stale, added, or deleted files are processed — for a large codebase this cuts index time from seconds to milliseconds on most runs.

---

### `mast serve`

Start the MCP server over stdio.

```
Options:
  --state-dir <dir>         State directory
  --no-startup-reindex      Skip the startup staleness check (not recommended)
```

The server implements a four-step startup ladder so MCP clients get a usable server in under a second even for large projects. See [Startup Ladder](#startup-ladder) for details.

---

### `mast status [path]`

Print index health.

```
Options:
  --state-dir <dir>    State directory
  --json               Output as JSON
```

Reports `last_indexed`, `indexed_files`, `chunk_count`, `stale_files`, and the active embedding model. Use this to diagnose why search results look outdated.

---

### `mast metrics [path]`

Show token-efficiency metrics.

```
Options:
  --since <window>        Time window: 7d, 24h, 30m (default: 7d)
  --rollup                Collapse raw rows older than --keep-days into daily roll-ups
  --vacuum                Delete daily roll-up rows older than --keep-days
  --keep-days <n>         Retention days (default: 7 for rollup, 90 for vacuum)
  --state-dir <dir>       State directory
```

Prints a column-aligned table: tool name, call count, tokens returned, average duration, and efficiency ratio. Use `--rollup` + `--vacuum` periodically to keep the metrics database from growing unbounded.

---

## MCP Tool Reference

MAST registers 10 tools with the MCP server. Every read tool includes a `_stats` block:

```typescript
{
  tool: string,
  tokens_returned: number,
  tokens_full_file_upper_bound: number,
  files_referenced: string[],
  efficiency_ratio: number,           // 1 - (returned / full_file)
  duration_ms: number,
  mode?: "hybrid" | "lexical"         // present on mast_search only
}
```

---

### `mast_search`

Hybrid semantic + BM25 search over the indexed codebase.

```typescript
{
  query:         string,              // natural language or identifier
  limit?:        number,              // max results (default 10, max 50)
  language?:     "typescript" | "javascript" | null,
  file_pattern?: string | null,       // glob: "src/api/**"
  chunk_type?:   "function" | "method" | "class_shell" | "interface" | "type" | "export" | "block" | null,
  only_exported?: boolean
}
```

**Returns:** `{ mode, results[], _stats }`. Each result includes `file_path`, `start_line`, `end_line`, `content`, `symbol_name`, `similarity_score`, `match_score`, `rank`, and `match_snippet`.

**Why:** `grep` and `glob` find exact strings. `mast_search` finds *meaning*. A query like `"handle authentication middleware"` returns the relevant function even if the identifier is `verifyJwt`. In hybrid mode, the BM25 and vector rankings are fused with RRF so that a symbol appearing in both lists ranks higher than one appearing in only one — a document with both a strong keyword match and strong semantic similarity beats either alone.

The `mode` field tells the caller whether vector search is active. During server startup, while the embedding worker is still running, `mode` is `"lexical"` so callers know to interpret scores accordingly.

---

### `mast_project_skeleton`

All exported symbols grouped by file, optionally scoped to a directory.

```typescript
{
  directory?:    string | null,       // path prefix: "src/api"
  max_depth?:    number,              // max subdirectory depth (default unlimited)
  file_pattern?: string | null        // glob filter on file paths
}
```

**Returns:** `{ files: [{ file_path, exports: string[] }], _stats }`.

**Why:** Before navigating a codebase, an assistant needs orientation — "what exists here?". Reading every file to find its exports is wasteful. `mast_project_skeleton` returns a directory-scoped map of file → exported names in a single call, letting an assistant build a mental model of a subsystem without opening any files.

---

### `mast_exports`

All exported symbols from a single file with type signatures and TSDoc.

```typescript
{
  file_path: string                   // relative to project root
}
```

**Returns:** `{ file_path, exports: [{ name, kind, signature, line, doc }], _stats }`.

**Why:** The natural follow-up to `mast_project_skeleton`. Once an assistant knows which file is relevant, `mast_exports` gives full signatures without the function bodies — enough to understand the public surface of a module without paying for the implementation.

Methods are intentionally omitted (they surface via `mast_signature` on their parent class), so the result stays focused on the module's public contract.

---

### `mast_signature`

Declaration, TSDoc, and resolved parameter type context for a named symbol.

```typescript
{
  symbol:     string,                 // e.g. "handleLogin", "AuthService"
  file_path?: string | null           // narrow to a specific file
}
```

**Returns:** An array of `SignatureResult`, each with `symbol`, `file_path`, `line`, `signature`, `doc`, and `type_context`.

`type_context` is automatically populated: user-defined PascalCase type names appearing in the signature are resolved to their own signatures via a three-priority lookup — same file first, then named imports, then a global exported-type fallback. Long signatures are truncated at 500 characters. This means a single `mast_signature` call gives the assistant the full type picture for a function without needing separate lookups.

**Why:** When an assistant sees `function processOrder(order: Order, ctx: RequestContext): Promise<Result>`, knowing the signature of `Order`, `RequestContext`, and `Result` is essential for understanding what the function does. Rather than making three more tool calls, `mast_signature` resolves them inline.

---

### `mast_callers`

Who calls a given symbol, split into verified callers (from the symbol graph) and potential matches (from full-text identifier search).

```typescript
{
  symbol:              string,
  file_path?:          string | null,
  transitive?:         boolean,       // walk the full call chain (default false)
  include_potential?:  boolean        // include identifier_fts matches (default true)
}
```

**Returns:** `{ verified_callers[], potential_matches[], summary: { verified_count, potential_count, transitive }, _stats }`.

**Why:** Impact analysis before a refactor requires knowing who depends on a symbol. Verified callers are graph-resolved (definitive, no false positives from name collisions). Potential matches are identifier-FTS hits where the call wasn't statically resolvable — they may be false positives but are worth reviewing. Separating the two lets the assistant reason about confidence: if `verified_count` is 3 and `potential_count` is 0, the refactor scope is well-understood. If `potential_count` is 15, there's more uncertainty.

---

### `mast_dependencies`

All imports recorded for a file.

```typescript
{
  file_path: string
}
```

**Returns:** `{ file_path, imports: [{ module, symbols[], is_external, resolved_path? }], _stats }`.

**Why:** Understanding a file's dependency surface is the first step in reasoning about what it does. External imports (no `resolved_path`) are flagged so the assistant knows the resolution boundary. Internal imports include the resolved path so callers can follow the chain.

---

### `mast_implementors`

All concrete classes that implement a given interface, with their method lists.

```typescript
{
  interface_name: string
}
```

**Returns:** `{ results: [{ class_name, file_path, line, methods[] }], _stats }`.

**Why:** In a dependency-injection codebase, `interface_name → implementors` is the answer to "what actually runs here?". Rather than grepping for `implements InterfaceName`, MAST stores explicit `IMPLEMENTS` edges in the graph at index time, making the lookup instantaneous and structurally correct.

---

### `mast_reindex`

Trigger a synchronous reindex from within an MCP session.

```typescript
{
  full?: boolean                      // force full reindex (default: incremental)
}
```

**Returns:** `{ files_indexed, files_skipped, chunks_added, chunks_removed, parse_errors, duration_ms }`.

**Why:** Long-running editing sessions accumulate staleness. `mast_reindex` lets the assistant refresh the index on demand — for example, after a large refactor — without leaving the MCP session. The `full` flag is available when incremental state is suspected to be corrupt.

---

### `mast_status`

Health snapshot of the index.

```typescript
// no inputs
```

**Returns:** `{ state_dir, last_indexed, indexed_files, chunk_count, stale_files, parse_errors, index_fresh, model, embedding_mode }`.

`index_fresh` is `true` only when `stale_files = 0` and the index has been run at least once. `embedding_mode` reports `"hybrid"` or `"lexical"` — the current search mode of the running server.

**Why:** Before a long agentic workflow that depends on accurate code navigation, an assistant can call `mast_status` to confirm the index is fresh, or surface the number of stale files to the user if not.

---

### `mast_efficiency`

Token savings report for the current session or all time.

```typescript
{
  scope:          "session" | "global",
  since_minutes?: number              // global scope: restrict to last N minutes
}
```

**Returns:** `{ scope, window_started_at, tokens_returned, tokens_full_file_upper_bound, efficiency_ratio, calls_total, calls_by_tool, tokenizer, counterfactual }`.

The `counterfactual` field is a human-readable sentence: *"Would have cost ~14,200 tokens with naive full-file reads; saved ~11,400 tokens (80.3%)."*

**Why:** Token efficiency is the whole reason MAST exists, but without measurement it is just a claim. Every tool call records tokens returned to `metrics` asynchronously (fire-and-forget, < 1 ms). `mast_efficiency` aggregates those records so the value of precise code navigation is concrete and auditable.

---

## Configuration

MAST reads configuration from `mast.config.json` in the project root, environment variables, or CLI flags. Priority order (highest to lowest): CLI flag → `MAST_STATE_DIR` env var → `mast.config.json` → built-in defaults.

| Key | Default | Description |
|---|---|---|
| `state_dir` | `.mast` | Directory for all index state (relative to project root) |
| `file_extensions` | `.ts,.tsx,.js,.jsx` | Source file extensions to index |
| `exclude_patterns` | `node_modules/**`, `dist/**`, `coverage/**`, `**/*.test.ts`, `**/*.spec.ts` | Glob patterns to skip |
| `embedding_model` | `jinaai/jina-embeddings-v2-base-code` | HuggingFace model ID for vector embeddings |
| `similarity_threshold` | `0.70` | Minimum cosine similarity for a vector hit to count |
| `rrf_k` | `60` | Reciprocal Rank Fusion constant (higher = flatter ranking) |
| `chunk_split_threshold` | `100` | Lines above which a declaration is split into overlapping sub-chunks |
| `context_lines` | `3` | Source lines before/after AST boundaries included in stored content |

**`mast.config.json` example:**

```json
{
  "state_dir": ".mast",
  "exclude_patterns": ["node_modules/**", "dist/**", "**/*.test.ts"],
  "similarity_threshold": 0.65,
  "context_lines": 5
}
```

**`MAST_STATE_DIR`** — override the state directory without touching `mast.config.json`. Useful in CI or Docker environments where the project root is read-only.

---

## How It Works

### Indexing (Phase 1)

`runIndex` walks the project with `fast-glob`, computes an mtime-based manifest, and diffs it against the stored manifest to find stale, added, and deleted files. For each file that needs processing:

1. **Parse** — `tree-sitter` parses the file into a concrete syntax tree. The TypeScript grammar is used for `.ts` and `.tsx`; the JavaScript grammar for `.js` and `.jsx`.
2. **Chunk** — the extractor decomposes the CST into typed chunks: `function`, `class_shell` (the class declaration plus member signatures, without bodies), `method` (individual methods), `interface`, `type`, `export`, and `block`. Classes are always decomposed so that a search for a single method doesn't return the entire class body.
3. **Sub-chunk** — declarations longer than `chunk_split_threshold` lines are split into overlapping segments so that no single chunk is too large for an embedding model's context window.
4. **Symbol graph** — symbols, imports, and edges (IMPLEMENTS, PARENT_OF, POTENTIAL_CALL) are written to SQLite. The two-pass write strategy (all files first, then edges) ensures edges can reference symbols that may be defined in a file parsed later in the same run.
5. **FTS** — chunk content is written to an FTS5 virtual table with a trigram tokeniser, enabling sub-token and camelCase searches. An `identifier_fts` table with a unicode61 tokeniser handles exact-identifier lookups for `mast_callers` potential matches.

### Embedding (Phase 2)

After Phase 1, a background worker process loads the `jinaai/jina-embeddings-v2-base-code` ONNX model via `@huggingface/transformers`. It embeds all un-vectorised chunks in batches and writes results to a LanceDB table. The embedding dimension is detected dynamically at runtime rather than hardcoded — the worker probes the model after loading by embedding an empty string, so swapping embedding models requires no code changes.

Embedding is decoupled from indexing: Phase 1 completes in seconds; Phase 2 runs asynchronously in the background. During Phase 2, `mast_search` operates in `"lexical"` mode (BM25 only). When Phase 2 completes, the server flips to `"hybrid"` mode transparently.

### Hybrid Search

A query goes through two parallel paths:

**BM25 (FTS5):** The query is matched against `chunk_fts` using SQLite's built-in BM25 ranking. File-pattern and language filters are pushed into this query as SQL predicates against the `files` table (not as FTS MATCH predicates, because SQLite FTS5 LIKE on UNINDEXED columns is unreliable with MATCH).

**Vector search:** The query is embedded by the in-process embedder, and the resulting vector is compared against all chunk embeddings in LanceDB using cosine distance. Hits below `similarity_threshold` are discarded.

**RRF fusion:** The two ranked lists are combined using Reciprocal Rank Fusion:

```
score(chunk) = Σ 1 / (k + rank(chunk))
```

with default `k = 60`. A chunk appearing at rank 1 in FTS and rank 1 in vector search scores twice as high as a chunk appearing in only one list. Chunks appearing in only one list still score well — neither signal dominates.

### JIT Staleness Checks

Every read tool (search, exports, signature, callers, dependencies, implementors) calls `jitRefreshFile` before returning results. This function:

1. Reads the stored mtime for the file from the `files` table.
2. Calls `stat()` on the file on disk.
3. If the disk mtime is newer, acquires the `structure.lock` and re-parses the file immediately.

This means an assistant editing a file and immediately querying it will always see the current version, without waiting for a scheduled reindex.

### Startup Ladder

`mast serve` starts accepting MCP connections in under 1 second via a four-step ladder:

```
Step 1  Bootstrap state directory and copy Docker seed layer if present   < 500ms
Step 2  Schema version check; open SQLite and LanceDB                     < 1s
Step 3  Register all 10 MCP tools; open stdio transport                   < 500ms
Step 4  Background incremental reindex + embedding worker fork            async
```

The server is usable (in `"lexical"` mode) before Step 4 finishes. This matters for Docker deployments where the container may be responding to requests while the embedding worker is still catching up. When a pre-built seed index is available at `/opt/mast-seed`, it is copied to the state directory in Step 1 — the background reindex then only needs to process files changed since the seed was built.

### Concurrency Model

Two advisory locks coordinate concurrent writers:

- **`structure.lock`** — held by `runIndex` and JIT re-parses. Prevents two writers from modifying the SQLite graph simultaneously.
- **`vectors.lock`** — held by `runEmbed`. Prevents two embedding passes from running concurrently.

The locks use `proper-lockfile` (POSIX advisory locks via `.lock` marker files). A 10-second stale lock timeout prevents a crashed process from blocking the system indefinitely. Read tools never acquire a write lock — they may see a briefly inconsistent state during a concurrent reindex, and return `file_busy_returning_stale_cache: true` in that case.

### Storage Layout

```
.mast/
  graph.db              SQLite — symbols, edges, imports, FTS5 tables, metrics
  file_manifest.json    mtime snapshot from last Phase 1 run
  index.json            schema version, file count, chunk count, last_indexed
  config.json           resolved config written at init/serve time
  structure             lock marker (proper-lockfile target)
  vectors               lock marker (proper-lockfile target)
  lance/
    chunks.lance        LanceDB table — all chunks with metadata
    vectors.lance       LanceDB table — chunk embeddings
  embed_cache/          content-hash-keyed JSON embedding cache (avoids re-embedding identical content)
```

---

## Token Efficiency

Every tool call records its token count to `metrics` asynchronously. The record includes:

- `tokens_returned` — actual tokens in the response (Anthropic CL100k tokenizer)
- `tokens_full_file_upper_bound` — what a naive full-file read would have cost (when calculable)
- `duration_ms`, `session_id`, `status`, and `mode`

`metrics_daily` rolls these up by `(day, tool_name)` with a running average for duration and running totals for token counts. The rollup upsert uses an incremental average formula to avoid storing all raw rows indefinitely:

```sql
avg_duration_ms = (old_avg * old_n + new_val) / (old_n + 1)
```

Use `mast metrics --since 7d` for a human-readable table, or `mast_efficiency` from within an MCP session for a machine-readable JSON summary with a `counterfactual` narrative.
