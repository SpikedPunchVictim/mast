# MAST — Monorepo AST Search Tool
## Technical Specification

---

## 1. Overview

**mast** is a lexical + declaration-exact code search engine exposed over two surfaces:
an MCP server (used by the agent inside the claude-runner container) and a CLI (used by
humans and hooks outside the container). It replaces ad-hoc `Grep`, `Glob`, and
whole-file `Read` calls with targeted, index-backed queries that return structured
subsets of code rather than full file contents.

A single on-disk index — written to a configurable state directory — is shared by both
surfaces. The index persists on the mounted workspace volume across container runs,
so each new container inherits the index built by previous tasks.

**Note on prior discussions of a semantic/vector search leg:** an earlier revision of
this system fused BM25 with a vector-embedding ranker (LanceDB + a local ONNX model).
That subsystem was removed 2026-08-06 per the M2 decision (IMPLEMENTATION_PLAN.md,
"Stage 7: Vector-store deletion"); the pre-deletion system is preserved at the git tag
`mast-pre-vector-delete`. Everything below describes the system as it exists today.

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
  `mast_reindex`. *Narrow carve-out:* `mast serve --watch` (§11.4) is an opt-in
  file watcher for **interactive, non-container** use only. It is scoped to the
  serve process lifetime (not a daemon), the SDD pipeline never uses it, and it
  is a discovery-freshness optimization — it lets new files and symbols become
  searchable sooner than waiting for an explicit `mast_reindex`. JIT staleness
  handling (§9.0) already guarantees line-coordinate and content correctness for
  already-indexed files without it.
- Support for non-TypeScript/JavaScript projects in v1 (AST layer is extensible but
  v1 targets the SDD stack).

---

## 4. Configuration

The state directory itself is resolved first, independent of everything else (it must
be known before its own persisted config can be loaded from inside it):

1. CLI flag `--state-dir <path>` (or env `MAST_STATE_DIR`)
2. `state_dir` key in `mast.config.json` in the project root
3. Default: `<project_root>/.mast`

Every other config key (`file_extensions`, `exclude_patterns`, `rrf_k`,
`declaration_exact_ranker`, `chunk_split_threshold`, `context_lines`,
`markdown_heading_depth`) is then resolved in this priority order, highest first:

1. Explicit CLI overrides — `mast init --extensions <ext,...>` / `--exclude <pattern,...>`
   (F9, Stage 3.5)
2. `mast.config.json` in the project root
3. The persisted `<state_dir>/config.json` from a previous `mast init` / `mast serve`
   in this state directory (F9 — previously write-only; now read back on every
   resolution)
4. Built-in defaults

**Path keys are never taken from the persisted state config.** `<state_dir>/config.json`
stores a full resolved config, including the ABSOLUTE `state_dir`/`project_root`/
`resolved_state_dir`/`resolved_project_root` from whichever process last wrote it. The
SDD pipeline mounts the same workspace volume at different container paths across runs,
so an absolute path loaded back from a previous container could silently point the
resolver at a path that doesn't exist (or belongs to an unrelated project) in the
current one. Only the customisation keys are read from the persisted file; the four
path keys always come from the current resolution.

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
  "rrf_k": 60,
  "declaration_exact_ranker": true,
  "chunk_split_threshold": 100,
  "context_lines": 3,
  "markdown_heading_depth": 2
}
```

`rrf_k` is the constant in the Reciprocal Rank Fusion formula (see §7.3). The default
of 60 is standard. Higher values reduce the influence of rank differences.

`declaration_exact_ranker` (default `true`) is the F18 kill-switch: it fuses the
declaration-exact ranker (ranker D — see §7.3) into `mast_search` ranking as an
additional RRF input. Set `false` to restore pre-F18 ranking without a code change.
The flag exists because ranker D's harm surface on identifier-free queries is
monitored, not proven safe (M2 decision memo, condition 3); its D-fire telemetry
(§14.3 `declex_json`) is the input signal for that monitoring.

There is deliberately **no `similarity_threshold` key** — it gated a vector-search leg
that no longer exists (removed 2026-08-06, §1); no replacement config key was needed.

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

Every field above except `state_dir`/`project_root` is also read back from
`<state_dir>/config.json` when `mast.config.json` and CLI flags don't override it (§4,
F9) — see §5 for the file's read/write semantics.

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
├── config.json              # Resolved active config (written at init/serve; read back
                             # on every resolution — §4, F9)
├── index.json               # Index metadata: last_indexed, file_count, schema_version
├── file_manifest.json       # {path: mtime} snapshot from last index run
├── structure.lock              # Advisory write lock for coarse writers (index, mast_reindex, manifest)
└── graph.db                 # Knowledge graph, chunks, and FTS5 index (SQLite, WAL mode)
```

`index.json` example:
```json
{
  "schema_version": "1.2.0",
  "last_indexed": "2026-05-13T14:22:00Z",
  "file_count": 142,
  "chunk_count": 1840
}
```

---

## 6. Data Model

### 6.1 Chunk (`chunks` table — `graph.db`)

| Field | Type | Description |
|---|---|---|
| `chunk_id` | `str` | `sha256(file_path + ":" + start_line)` |
| `file_path` | `str` | Relative to `project_root` |
| `start_line` | `int` | 1-indexed |
| `end_line` | `int` | 1-indexed, inclusive |
| `content` | `str` | Raw source text of the chunk |
| `chunk_type` | `str` | `function` \| `method` \| `class_shell` \| `interface` \| `type` \| `export` \| `block` \| `doc` |
| `symbol_name` | `str \| None` | Top-level symbol name if applicable. For `method` chunks, qualified as `ClassName.methodName`. For `doc` chunks, the heading path (§10.1). |
| `parent_symbol` | `str \| None` | For `method` chunks, the enclosing class name (unqualified). `None` for all other chunk types. Enables fast "find all methods of class X" queries against the `chunks` table without joining the graph. |
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
`method` chunks, each its own row in the `chunks` table (see §10.1).

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
  -- skip the KG rebuild for this symbol (§7.1's file-level stability-hash skip).
);

CREATE TABLE IF NOT EXISTS edges (
  from_id    INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  to_id      INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  edge_type  TEXT NOT NULL,
  resolution TEXT,    -- POTENTIAL_CALL only: which §10.3.1 rule matched
                      -- (import | field_type | parameter_type | new_expression | same_file)
                      -- or 'checker' (§10.3.2) — the opt-in `mast index --checker`
                      -- pass upgraded a heuristic-unresolved potential match via
                      -- the real TypeScript checker. Additive value, no schema change.
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
-- snippet() works without any external table. Indexing inserts/updates/deletes directly
-- on chunk_fts; no sync logic required. Content duplication vs the `chunks` table is
-- acceptable at monorepo scale (~1-2 GB of source) and eliminates a whole class of
-- consistency bugs.
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

### 7.1 Indexing (Single Phase — Parse → Chunks → Graph → FTS)

Indexing is a single phase — there is no separate embedding step. `runIndex`:

1. Acquire `structure.lock` — see §7.6. Exit with error if lock cannot be
   acquired within the configured timeout.
2. Walk project files matching `file_extensions`, respecting `exclude_patterns`.
   Collect `{ path, mtime }` for every file found.
3. **Deleted file cleanup:** load `file_manifest.json` (previous scan's path set).
   Any path present in the manifest but absent from the current walk has been deleted.
   Remove its rows from `graph.db` `files` table (cascade deletes symbols, edges, and
   imports), and delete all matching rows from the `chunks` table.
4. For each file to index (all files on full run; only files where
   `mtime > manifest[path]` on incremental run): wrap the parse in try/catch. On
   tree-sitter error, log at `warn` level with the file path and error message,
   increment `parse_errors`, and skip to the next file. Never abort the full run.
   On success: run the two-pass walk and extract chunks with type, symbol, `is_exported`,
   and `declaration_hash` metadata.
5. Write chunks to the `chunks` table. Delete and replace all existing chunks for the
   same `file_path`. Update `chunk_fts`: `DELETE FROM chunk_fts WHERE chunk_id = ?`
   for removed chunks, `INSERT INTO chunk_fts(content, symbol_name, chunk_id) VALUES
   (?, ?, ?)` for new/changed chunks. No external table or trigger is needed — FTS5
   built-in content handles everything. Multi-row inserts here (and for `symbols`,
   `imports`, `identifier_fts`, and `edges`) are batched under SQLite's 32,766
   bound-parameter ceiling, batch-by-batch inside the same per-file transaction
   (`graph/sqliteBatch.ts`), so file size never caps how many chunks get indexed
   (Stage 4.5 S1, IMPLEMENTATION_PLAN.md).
6. Populate `graph.db` from AST imports and relationships, wrapped in a single
   transaction per file (delete-and-replace). Record `RE_EXPORTS` edges from
   `export { x }` clauses and `re_export_files` rows from `export * from '...'`
   clauses.
7. **Stability hash optimisation (incremental only):** the `declaration_hash`
   (signature) and `body_hash` are computed from the AST (signature node vs body
   node), not by splitting chunk text.

   **File-level skip:** a file whose mtime changed but whose chunked content is
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
     is rewritten. Correct: the outline visible to the agent now lists a new name.
   - Editing a method body without changing its signature → shell `body_hash`
     **unchanged** → shell content is NOT rewritten; only the affected `method` chunk is.
     Correct: the class's public interface didn't change, only its internals.
   - Adding or removing a method → shell content changes → shell is rewritten, plus
     the new/removed `method` chunk is added/deleted.

   Without this rule, the shell silently drifts out of sync with its members, and
   `mast_search "session validation"` returns a stale outline naming a method that
   no longer exists.
8. Write `file_manifest.json` with the current `{ path: mtime }` snapshot.
9. Write/update `index.json` with `last_indexed` and `file_count`.

Incremental variant: step 4 skips files where `mtime === manifest[path]`. Steps 3
(deleted file cleanup) and 8–9 always run.

BM25 search is handled by the `chunk_fts` FTS5 virtual table in `graph.db`, populated
incrementally during indexing (step 5). There is no separate serialization step.

### 7.3 Ranked Search with RRF

Search combines two rankers — FTS5 BM25 (lexical) and the declaration-exact
ranker (ranker D, structural) — using **Reciprocal Rank Fusion**:

$$Score(d) = \sum_{r \in R} \frac{1}{k + r(d)}$$

Where $r(d)$ is the rank of document $d$ in ranker $R$, and $k$ is `rrf_k` (default 60).

RRF is used instead of weighted score addition because the two rankers' scores are on
incomparable scales (a BM25 score and a structural match are not directly comparable).
Rank position, not the underlying score magnitude, is what RRF fuses.

Implementation: run FTS5 BM25 search (and, when enabled, ranker D) independently over a
candidate pool of **4× `limit` per ranker** (40 for the default `limit: 10`),
then apply RRF to produce a unified ranked list. Return the top `limit` results.

**Second RRF input — the declaration-exact ranker (ranker D, F18).** When
`declaration_exact_ranker` is enabled (§4.1, default on), a second ranked list
joins the fusion. Ranker D (`src/search/declex.ts`, the Q1/DECLEX-measured
construction) is symbol-gated and purely lexical-structural:

- The raw query is split on `/[A-Za-z0-9_$]+/` (no camelCase decomposition, no
  lowercasing); only **symbol-shaped** tokens survive the eligibility gate
  (contains an uppercase letter, `_`, `$`, or a digit adjacent to a letter) —
  bare lowercase prose words never reach the ranker.
- Each eligible token matches chunks whose own `symbol_name` **equals the
  token** (full-name match) or **ends with `.` + token** (final-dot-segment
  match — reaches `Class.method` chunks by their method name), both
  case-insensitive, via a direct SQL predicate against `chunks.symbol_name`
  (not FTS — the rule is a structural string comparison).
- Ordering is deterministic: full-name matches before segment-only matches,
  then ascending same-matched-name multiplicity (a uniquely-named match beats
  one of 140 `toJSON`s), then ascending `chunk_id`. The pool is capped at
  4× `limit` like BM25, and the list enters RRF **by rank** with the same
  `rrf_k`.
- Ranker D applies no `file_pattern`/`language` pre-filter (same semantics as
  BM25); `chunk_type`/`only_exported` post-filters apply downstream unchanged.
  When `declaration_exact_ranker` is off, `mast_search` is BM25-only.

Provenance: pre-registered and measured as Q1/DECLEX (IMPLEMENTATION_PLAN.md);
shipped per the M2 decision memo as F18. The measured **escape variant**
(lowercase-token recovery under a match-count cap) is deliberately NOT shipped —
it is measured harmful off-stratum and requires a fresh pre-registration.
Per-call firing telemetry is persisted to `metrics.declex_json` (§14.3).

**FTS5 sign convention:** SQLite's `bm25(chunk_fts)` returns negative scores — more
negative means a better match. When sorting the FTS5 result set, sort ascending
(most negative first) before applying RRF ranks. Do not negate the scores; rank
position is all that RRF uses.

### 7.4 Startup Reindex (Primary Pipeline Hook)

When `mast serve` starts, the goal is **time-to-first-query in single-digit
seconds**. All 11 tools are registered and ready to serve as soon as Step 3
completes — there is no reduced-capability window and no discriminator on tool
responses to track. Cold-start dead time is the single biggest UX risk to MAST
adoption — see Failure 4 in the design review — so this ladder is structured to
eliminate it.

```
startup
  ├─ STEP 1 (sync, < 1s): bootstrap state directory
  │    ├─ if <state_dir> is missing or empty:
  │    │    └─ if /opt/mast-seed exists (Docker-baked seed, see §13.8):
  │    │         copy /opt/mast-seed → <state_dir>
  │    │    └─ else:
  │    │         run `mast init --no-index` to create config + empty state
  │    ├─ ensure lock markers exist; persist the resolved config
  │    └─ best-effort remove orphaned pre-vector-store state (`lance/`,
  │       `embed_cache/`, `vectors.lock`) left behind by a pre-2026-08-06
  │       install — logged, never fatal, runs on every startup
  │
  ├─ STEP 2 (sync, < 2s): schema version + open database
  │    ├─ if index.json.schema_version != CURRENT_SCHEMA_VERSION:
  │    │    wipe all derived state (graph.db, file_manifest.json, and any
  │    │    remaining orphaned state)
  │    │    set needs_full_reindex = true
  │    │    write new index.json with updated schema_version
  │    ├─ open graph.db (better-sqlite3, WAL mode)
  │    └─ verify chunk_fts and identifier_fts tables exist (created on first init)
  │
  ├─ STEP 3 (sync, < 1s): open MCP transport — SERVER READY
  │    ├─ register all 11 tools (mast_search, mast_project_skeleton,
  │    │  mast_exports, mast_signature, mast_callers, mast_dependencies,
  │    │  mast_implementors, mast_reindex, mast_status, mast_efficiency,
  │    │  mast_rename_impact)
  │    └─ accept incoming MCP connections
  │
  └─ STEP 4 (async): background incremental reindex
       ├─ scan filesystem: collect {path, mtime} for all matched files
       ├─ deleted_files = manifest_paths - scanned_paths
       │    └─ for each: delete chunks/symbols (acquire structure.lock briefly)
       ├─ stale_files = [f for f in scanned if f.mtime > index.last_indexed
       │                 OR needs_full_reindex]
       ├─ acquire structure.lock
       │    ├─ run the indexer (§7.1) for stale_files
       │    ├─ update file_manifest.json + index.json.last_indexed
       │    └─ release structure.lock
       └─ FROM THIS POINT: the index is up-to-date for stale files
          (mast_search, mast_callers verified+potential, etc.)
```

If `--watch` was passed to `mast serve`, the file watcher (§11.4) starts
immediately after Step 3's transport opens, independent of Step 4.

**`--no-startup-reindex` refusal (M6 Part A).** The empty-during-Step-4 window
above is legitimate and by design — but `--no-startup-reindex` disables Step 4
entirely, and a state dir that has never completed an index run under that
flag would then answer every query `{"results":[]}` forever, with nothing
left to ever fill it in (`eval/GITNEXUS_COMPARISON.md` §13.8 item 4). To catch
only that unrecoverable case, `mast serve` calls `assertServableIndex`
(`mcp/server.ts`) after Step 1 and before Step 2 opens `graph.db`: if
`--no-startup-reindex` was passed AND the state dir is never-indexed
(`graph.db` absent, or `index.json` reports `chunk_count: 0` with
`last_indexed` null/absent), the process exits with an error naming the state
dir and suggesting `mast init`/`mast index` or dropping the flag. A state dir
indexed over a genuinely empty file set (`last_indexed` set, `chunk_count: 0`)
is NOT refused — see §9.0's "Empty-index signal" for how that legitimate
empty-index case is surfaced to callers instead. With the startup reindex
enabled (the default), this check is a no-op and Step 3 opens the transport
exactly as described above.

`CURRENT_SCHEMA_VERSION` is a constant in the mast binary (currently `"1.2.0"`). A
version bump is required any time the SQLite schema or `index.json` fields change
in a way that makes old on-disk state unreadable by the new code. Incrementing
without a state wipe causes a corrupt or partial index; wiping without
incrementing loses the protection. Both are bugs — treat the version as a
migration guard, not a display string.

(Backward-compatible additions that do not break reading an old table — e.g. the
`edges.resolution`/`call_line`/`context` columns added via `ALTER TABLE … ADD
COLUMN` — do NOT require a bump, since `openDatabase` migrates them in place.) On
schema bump the seed index in `/opt/mast-seed` is also invalidated and a full
reindex runs in the background.

**Fast first-task latency.** With a baked seed (§13.8), Steps 1–3 typically complete
in **2–4 seconds** on a cold container. Step 4 then catches up any files changed
since the seed was built in the background — the agent can begin useful work as
soon as Step 3 completes; JIT staleness handling (§9.0) guarantees any individual
file it queries is correct even before Step 4 reaches it.

This is the **only hook required for the SDD pipeline**. The BT orchestrator needs no
reindex calls. Files committed by the previous task are picked up by Step 4's
filesystem scan. JIT staleness handling (§9) covers files modified mid-task before
Step 4 has caught up to them.

### 7.5 Mid-Task Reindex (`mast_reindex` MCP tool)

The agent calls `mast_reindex` immediately after writing files, before querying for
symbols it just created. This is synchronous — the tool does not return until the index
is updated. Incremental by default — only files with changed mtimes are touched. For a
typical single-file write this completes in <500ms.

### 7.6 Write Locking

Coarse writes are coordinated by **one advisory file lock**, managed by `proper-lockfile`:

- **`<state_dir>/structure.lock`** — held during chunk parsing, graph population, and
  FTS index writes (`chunks` table, `graph.db`, `chunk_fts`, `identifier_fts`) for
  **coarse writers only**: `mast index`, the startup full/incremental reindex, and
  `mast_reindex`. It also coordinates the manifest/`index.json` phase, which SQLite
  itself can never protect (plain `writeFileSync`, not a database write).

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

**JIT re-parse from a read tool does NOT acquire `structure.lock`.** `structure.lock`
is one global lock per state dir with no per-file component, so — measured directly
(`eval/e7-concurrency.json`) — it made a JIT re-parse of file A block a JIT re-parse of
file B despite the two touching disjoint rows, driving JIT failure rates as high as
88.5% under pure reader-vs-reader concurrency. Instead, the JIT write goes straight to
`populateFile` (§9.0), which opens its own transaction with `BEGIN IMMEDIATE` and a
**dedicated, short `busy_timeout` of 200ms** (`IMMEDIATE_WRITE_BUSY_TIMEOUT_MS`,
`graph/populate.ts`) — distinct from `graph.db`'s shared 5000ms connection default
(set once at `openDatabase`, `graph/db.ts`) — set immediately before the transaction and restored immediately after, so no
other statement on the connection ever inherits the short value. `BEGIN IMMEDIATE`
takes the write reservation up front instead of discovering contention on commit (the
`SQLITE_BUSY_SNAPSHOT` failure mode a plain deferred `BEGIN` is prone to), and its
`busy_timeout` wait — capped at 200ms rather than inheriting the shared 5000ms default
— is what bounds how long a genuinely contended write can hold up the calling tool. On
exhaustion (`SQLITE_BUSY`/`SQLITE_BUSY_SNAPSHOT`), fall through to the TOCTOU policy
below and return the stale chunk with a `file_busy_returning_stale_cache` flag rather
than blocking the agent indefinitely — the same contract the old lock-retry exhaustion
path used to produce, just reached by a different mechanism.

Coarse writers serialize against each other and against the manifest phase on
`structure.lock`. JIT writes serialize against each other cheaply within one `mast
serve` process (Kysely's SQLite dialect guards every connection acquisition on a `Db`
instance with an in-process mutex) and against coarse writers or other processes via
`BEGIN IMMEDIATE`'s own write-reservation semantics — not via `structure.lock`.
Concurrent readers (all MCP query tools) acquire no lock and take no part in either
mechanism — they only `stat()` files for staleness detection (§9).

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

`--extensions` and `--exclude` are honoured (F9, Stage 3.5): each is a comma-separated
list, trimmed and with empty entries dropped; `--extensions` additionally normalizes
bare names to leading-dot form (`py` and `.py` are both accepted). They take priority
over `mast.config.json` and any previously-persisted `<state_dir>/config.json` — see §4
for the full priority chain.

Creates `<state_dir>/`, writes `config.json`, runs a full index. On every subsequent
`mast init`/`mast index`/`mast serve`/`mast status`/`mast query`/`mast metrics` call
against the same state directory, the customisation keys in `config.json` are read back
and applied unless a higher-priority source (CLI flags, `mast.config.json`) overrides
them (§4).

---

### `mast index [path] [options]`

Build or update the index.

```
Options:
  --state-dir <dir>    State directory (resolved from config if omitted)
  --incremental        Only reindex files changed since last index run
  --show-progress      Print indexing progress to stderr
  --checker            Opt-in TypeScript-checker enrichment pass (§10.3.2) —
                        upgrades potential_matches into verified 'checker'
                        edges or drops non-call-site/wrong-declaration noise.
                        Holds one ts.Program at a time; can take tens of
                        seconds on a large monorepo — not part of the default
                        index path.
```

---

### `mast serve [options]`

Start the MCP server over stdio.

```
Options:
  --state-dir <dir>       State directory
  --no-startup-reindex    Skip the startup staleness check (not recommended)
  --watch                 Watch source files and incrementally reindex on change
                          (interactive use — see §11.4)
```

The server runs until the parent process (Claude CLI) closes stdin.

`--no-startup-reindex` combined with a never-indexed state dir is refused at
startup (M6 Part A, §7.4) — that combination disables the one mechanism that
would ever fill the index, so `mast serve` exits with an error instead of
silently answering every query `{"results":[]}` forever. A never-indexed
state dir with the startup reindex left enabled (the default) is unaffected
and starts normally, as does `--no-startup-reindex` against an already-indexed
state dir (including one indexed over a genuinely empty file set).

`--watch` is opt-in and intended for interactive local development; the SDD
container does not use it (§3, §11.4). The watcher is closed on stdin close,
SIGTERM, and SIGINT; a watcher startup failure logs a warning and the server
continues without watch.

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
parse_errors:   0
write_errors:   0
index_fresh:    true
freshness_cause: none
```

`freshness_cause` carries the same semantics as the `mast_status` MCP tool (§9) —
it prints `none` in human output when the JSON value would be `null`; the JSON
value is `"phase1_stale"` when `stale_files > 0`. On a never-indexed project the
state directory is not created as a side effect of running `status`.

---

### `mast query <tool> [json] [path]`

Invoke any MCP tool (§9) directly from the CLI — the read tools (`mast_search`,
`mast_project_skeleton`, `mast_exports`, `mast_signature`, `mast_callers`,
`mast_dependencies`, `mast_implementors`, `mast_rename_impact`, `mast_status`,
`mast_efficiency`) and `mast_reindex`, by their exact MCP names.

```
Options:
  --state-dir <dir>    State directory
  --json                Emit the exact single-line MCP response text (machine
                        use); default pretty-prints the parsed response with
                        2-space indent for humans
```

`json` (positional, default `'{}'`) is the tool's argument object as a JSON
string; `path` is the project root (same resolution as every other command's
`[path]`).

Identical-output-by-construction: `mast query` dispatches through the exact
same registered tool handler an MCP client's call would invoke — the same
schema validation, the same JIT/staleness handling, the same `_stats`
block — so CLI output can never drift from the MCP transport's, by
construction rather than by keeping two implementations in sync.

Examples:
```
mast query mast_status '{}' /path/to/project
mast query mast_search '{"query":"add","limit":5}' /path/to/project --json
mast query mast_exports '{"file_path":"src/math.ts"}'
```

Error behavior (all exit 1, message to stderr):
- **Unknown tool** — lists every registered tool name.
- **Malformed JSON argument** — names the parse failure.
- **Args that fail the tool's own zod schema** — the zod issues.
- **State dir with no `graph.db`** (never-indexed project) —
  ``no index found at <state_dir>; run `mast init` / `mast index` first``.
  This is `mast query`'s own fail-fast guard, parallel to `mast serve`'s
  `--no-startup-reindex` refusal (M6 Part A, §7.4). Because `mast query`
  dispatches through the same registered tool handlers, the M6 Part B
  `index_empty` signal (§9.0) appears on its responses automatically — an
  indexed-but-empty corpus queries fine and says so.

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

Every read tool that returns line coordinates (`mast_search`, `mast_signature`,
`mast_exports`, `mast_callers`, `mast_dependencies`, `mast_implementors`,
`mast_rename_impact`) performs a **mandatory server-side staleness check**
before returning. This is
not optional and is not controlled by the caller — the index is responsible for
its own consistency, not the agent. `mast_project_skeleton` is exempt: its
response is a directory map of exported symbol names with no line coordinates
to go stale (P3).

**The agent must never see a chunk whose line coordinates do not match the
current file on disk without being told.** Returning stale line numbers
unflagged leads directly to agent-assisted corruption: the agent issues an
`Edit` against the stale range and overwrites unrelated logic. This class of
failure does not surface as an error — it surfaces as silent, hard-to-attribute
breakage downstream. Two different mechanisms enforce this, chosen per tool by
how many files a single call's results can span:

- **Just-In-Time (JIT) re-parse** (`mast_signature`, `mast_exports`,
  `mast_callers`, `mast_dependencies`, `mast_rename_impact`) — these tools'
  results are scoped to one file, or a small, explicitly-named set, so a
  stale result can be transparently refreshed in place. See below.
- **Stat-and-flag** (`mast_search`, `mast_implementors`) — these tools can
  return results spanning dozens of files in one call, so JIT re-parsing
  every result file would mean up to ~50 tree-sitter re-parses and write
  transactions per call, and re-parsing a result file mid-response could
  shift its rank, gain or lose a match, or change its chunk boundaries —
  invalidating the ranking/query that already selected the result being
  "refreshed". Instead,
  after results are computed, each **unique** result `file_path` is
  `statSync`'d (no lock, no re-parse, no DB write) and its disk mtime
  compared against the indexed `files.mtime`. Newer-on-disk, or a failed
  stat (file deleted/renamed since indexing — its coordinates are
  definitely untrustworthy), sets `file_busy_returning_stale_cache: true`
  on that result; a file absent from the `files` table (nothing indexed to
  be stale against) is left unflagged. The flag name is reused from the
  JIT-refresh tools' TOCTOU signal below even though no lock is ever
  involved here — a known naming tension, deferred to the confidence-signal
  unification tracked as C1 in `IMPLEMENTATION_PLAN.md`.

**Just-In-Time (JIT) re-parse.** For every result a JIT-refresh tool is about to return:

1. `fs.stat()` the `file_path`. Compare disk `mtime` against the chunk's stored
   `file_mtime`.
2. If `disk_mtime <= stored_mtime` → return the result unchanged. Fast path.
3. If `disk_mtime > stored_mtime` → the chunk is stale. Re-index **this file
   only** (one tree-sitter parse, one `BEGIN IMMEDIATE` transactional
   delete-and-replace against the `chunks` table, `graph.db`, `chunk_fts`,
   `identifier_fts` — see §7.6; no `structure.lock` acquisition on this path).
   Re-resolve the tool's result against the refreshed chunks. A single-file
   re-parse typically completes in 10–50ms; the transactional write itself is
   bounded by a dedicated 200ms `busy_timeout` (§7.6), not the connection's
   shared 5000ms default a genuinely contended write would otherwise wait
   out.

JIT re-parse covers files already known to the index. It does not discover a
brand-new file or a newly-created symbol — those become searchable via the next
`mast_reindex` call or the background/`--watch` reindex (§7.4/§11.4) reaching
them. The agent prompt should still recommend `mast_reindex` after writing new
files or symbols — not because JIT leaves existing files stale (it doesn't), but
because discovery of new ones requires an actual indexing pass.

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
no longer serialize on any lock (§7.6) — each parses its own file fully in
parallel, and only briefly contends on the transactional write. That write
is bounded by the dedicated 200ms `busy_timeout`
(`IMMEDIATE_WRITE_BUSY_TIMEOUT_MS`, §7.6): under real contention, `BEGIN
IMMEDIATE`'s `busy_timeout` wait is a **synchronous** hold on the whole
`mast serve` process's event loop (better-sqlite3's busy-wait is native and
blocks the process, not just the calling request) — 200ms is the accepted
trade at this magnitude, comparable to the 3×100ms lock-retry budget the
pre-F11 JIT path used to pay, and far below the connection's shared 5000ms
default, which would otherwise freeze the entire process for up to 5 seconds
per contended write.

**Result shape.** Every read tool's result objects MAY include
`file_busy_returning_stale_cache: true` (omitted when false). Result schemas
in the per-tool sections below document only the steady-state shape; this flag
is implicit on all of them. Tools whose response is a single-file envelope
(`mast_exports`, `mast_dependencies`) or whose staleness taints the whole
answer (`mast_callers`, `mast_rename_impact`) carry the flag at the envelope
level instead of per-entry. `mast_signature` carries it per-result — except
when a `file_path`-narrowed query returns **zero** results while that file's
JIT re-parse could not acquire the lock: with no result objects to carry the
signal, the flag appears on the response envelope (F14), so "no results" from
a stale, un-refreshable file never reads as "symbol doesn't exist".
`mast_search` and `mast_implementors` also carry the flag per-result, but via
stat-and-flag rather than JIT re-parse (F7, see above) — each result's
`file_busy_returning_stale_cache` reflects that result's own `file_path`
statting newer-on-disk or failing to stat, independent of every other
result in the same response.

**Empty-index signal (M6 Part B).** Every read tool with a primary result
array — `mast_search`, `mast_project_skeleton`, `mast_exports`,
`mast_signature`, `mast_callers`, `mast_dependencies`, `mast_implementors`,
`mast_rename_impact` — MAY attach `index_empty: true` to its response
envelope. Present only when BOTH (a) that tool's primary result set came back
empty (for `mast_callers`, both `verified_callers` AND `potential_matches`;
for `mast_rename_impact`, all four of `declaration_sites`, `verified_callers`,
`potential_matches`, and `barrel_exports`) AND (b) the `chunks` table has zero
rows at that moment (`mcp/tools/_helpers.ts`'s `isIndexEmpty`, checked only on
the already-empty-result path — a populated response never pays for this
check). Distinguishes "`[]` because nothing is indexed yet, or you pointed at
the wrong state dir" from "`[]` because no match" — the exact ambiguity M6
(`eval/GITNEXUS_COMPARISON.md` §13.8 item 4) names, and the legitimate empty
window §7.4's startup ladder deliberately leaves servable (see the
`--no-startup-reindex` refusal note in §7.4, which catches only the
never-recoverable case, not this one). Omitted entirely when false, same
present-only-when-true convention as `file_busy_returning_stale_cache` above
— never present-and-false. Independent of `mast_search`'s `suggestions` field:
a truly empty index yields no suggestions either, but the two are not
coupled — either may be present without the other. `mast_status` is
unaffected (it already reports `chunk_count`/`index_fresh` directly — it IS
the diagnostic surface); `mast_efficiency` and `mast_reindex` have no primary
result array and never carry this flag.

---

### `mast_search`

Lexical BM25 + declaration-exact search via RRF (§7.3). Returns chunks, not full files.

**Input:**
```json
{
  "query": "string",
  "limit": 10,
  "language": "typescript | javascript | markdown | null",
  "file_pattern": "glob pattern | null",
  "chunk_type": "function | method | class_shell | interface | type | export | block | doc | null",
  "only_exported": false
}
```

`only_exported: true` restricts results to chunks where `is_exported = true`. Use
this when looking for a service or utility to call into — it eliminates internal
implementation details from results.

**Output:** `SearchResponse`
```json
{
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

`match_score` carries the BM25 score (negative — §7.3's FTS5 sign convention) when the
FTS ranker produced a hit for this chunk, and `null` when the chunk reached the result
set only through ranker D (declaration-exact, §7.3). `rank` is the chunk's position in
the RRF-fused list and is always present, starting at 1.

`parent_symbol` is populated only on `method` chunks (carries the enclosing
class name); `null` for all other chunk types.

**Zero-result assist (`suggestions`).** When a search returns no results — no
FTS or ranker-D hit at all, or the `chunk_type` / `only_exported` filters emptied
the set — the tool does not return a bare dead end. It runs a relaxation pass
and attaches a `suggestions` array of `{ symbol, file_path, reason }` "did you
mean" candidates.

```json
{
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

Sourced entirely from the `chunks` table where `is_exported = true` — no tree-sitter
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
    "transitive": false,
    "checker_classified_non_call_site": 0,
    "checker_classified_different_declaration": 0
  }
}
```

**The two sets have different meanings.** Tools and prompts must treat them
differently:

- **`verified_callers`** — a call site the graph statically linked to the queried
  symbol. The `resolution` field names how: five values come from the local heuristic
  resolver (§10.3) — `import` (top-level named import), `field_type` (`this.x` where
  `x` is a class field with a known type annotation), `parameter_type` (parameter
  property or annotated parameter), `new_expression` (`new Foo()`-style construction),
  `same_file` (call site and definition in the same file) — and one, `checker`, comes
  from the opt-in `mast index --checker` pass (§10.3.2): a call site the heuristic left
  as `potential` that `ts.TypeChecker.getSymbolAtLocation` resolved to the queried
  declaration. All six are high confidence; safe to act on.

- **`potential_matches`** — `identifier_fts` matched the symbol name exactly inside a
  chunk, but neither the heuristic resolver nor (if it has run) the checker pass could
  statically link it. These are *candidates that require human or agent review* before
  any refactor proceeds. Common causes: factory patterns, DI container lookups,
  inferred types, dynamic dispatch, comments and string literals containing the
  identifier. The `reason` field is informational; v1 always returns
  `identifier_match_no_resolved_edge`.

**`summary.checker_classified_non_call_site` / `checker_classified_different_declaration`**
count candidates the checker pass classified away — not a real call site (comment,
string, type position) or a same-name collision resolving to a different declaration
— that would otherwise still be sitting in `potential_matches` as unresolved review
noise. Both are `0` when `mast index --checker` has never run against this index; a
nonzero value is direct evidence the pass ran and is doing its job (§10.3.2).

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

### `mast_rename_impact`

Composed refactor checklist for renaming a symbol. One call packages what an
agent would otherwise stitch together from `mast_callers` + manual barrel-file
inspection: every section reuses an existing query capability — no new
resolution logic.

**Input:**
```json
{
  "symbol": "createPolicyGroup",
  "file_path": "api/services/policy/src/service.ts | null"
}
```

`file_path` disambiguates duplicate names, with the same semantics as
`mast_signature`. Methods are addressed by qualified name
(`ClassName.methodName`), exactly as `mast_callers` accepts them.

**Output:** `RenameImpactResponse`
```json
{
  "symbol": "createPolicyGroup",
  "declaration_sites": [
    { "file_path": "api/services/policy/src/service.ts", "line": 42, "kind": "function", "is_exported": true }
  ],
  "verified_callers": [
    { "file_path": "api/routes/policy.ts", "line": 18, "caller_symbol": "registerPolicyRoutes", "context": "const group = await createPolicyGroup(input);", "resolution": "import" }
  ],
  "potential_matches": [
    { "file_path": "api/services/policy/src/service.ts", "line": 42, "context": "createPolicyGroup", "reason": "identifier_match_no_resolved_edge" }
  ],
  "barrel_exports": [
    { "file_path": "api/services/policy/index.ts", "line": 1, "exported_as": "createPolicyGroup", "via": "named" },
    { "file_path": "api/index.ts", "line": null, "exported_as": "createPolicyGroup", "via": "star" }
  ],
  "summary": {
    "declaration_count": 1,
    "verified_count": 1,
    "potential_count": 1,
    "barrel_count": 2,
    "checklist": "1 verified call site(s) to update, 1 review-required identifier match(es), 2 barrel export(s) to update.",
    "checker_classified_non_call_site": 0,
    "checker_classified_different_declaration": 0
  }
}
```

Section sources and semantics:

- `declaration_sites` — the `symbols` table (multiple entries when the name is
  ambiguous and no `file_path` was given). Impact below is computed against the
  first match, same convention as `mast_callers`; the full list keeps an
  ambiguous rename visible.
- `verified_callers` — direct `POTENTIAL_CALL` edges, identical to
  `mast_callers`' verified set. **Direct callers only** — a rename edits call
  sites, and every call site is a direct caller; there is no `transitive`
  option (deliberate v1 scope).
- `potential_matches` — `identifier_fts` hits not covered by a verified edge,
  identical to `mast_callers`' potential set (shared implementation, including
  checker-verdict filtering when `mast index --checker` has run, §10.3.2). These
  are **mandatory review sites**: the graph could not prove them, so the agent
  must check each before declaring the rename complete. The declaration chunk
  itself typically appears here — correctly, since it must be edited.
  `summary.checker_classified_non_call_site`/`checker_classified_different_declaration`
  carry the same meaning as in `mast_callers`.
- `barrel_exports` — files that re-export the symbol: `via: "named"` rows come
  from `RE_EXPORTS` edges (the export statement names the symbol —
  `exported_as` carries the alias — and must be edited); `via: "star"` rows
  come from a recursive walk of `re_export_files` (`export *` statements need
  no edit, but every downstream consumer reaches the symbol through them, so
  they are surfaced for awareness; `line` is null — star rows are file-level).

**When used:** before renaming any exported symbol — replaces the
callers-then-grep-then-barrel-hunt sequence with one call, and again after the
rename (the checklist should come back empty for the old name).

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
  "write_errors": 0,
  "duration_ms": 380
}
```

`parse_errors > 0` means one or more files were skipped due to tree-sitter parse failures. `write_errors > 0` means a file parsed successfully but its chunk/graph/FTS write failed — a distinct failure mode from a parse error (a chunk-store write failure must never be conflated with an unparseable file). The agent should call `mast_status` for details, or check the mast server log for the specific file paths.

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
  "parse_errors": 0,
  "write_errors": 0,
  "index_fresh": true,
  "freshness_cause": null,
  "seed_commit": "abc1234"
}
```

`parse_errors` is the count of files skipped during the last index run due to tree-sitter
parse failures; `write_errors` is the count skipped due to a chunk/graph/FTS write
failure after a successful parse (see `mast_reindex`, above — the two are never
conflated). Non-zero in either indicates files the agent should investigate.
`seed_commit` is present only when the state directory was bootstrapped from a
Docker-baked seed (§13.8) and reports the git revision the seed was built from.

**Freshness diagnostics.** `freshness_cause` is `"phase1_stale"` when `stale_files > 0`
(chunk line coordinates lag disk — corrected by JIT re-parse on read, §9.0, or by
running `mast_reindex`) and `null` when the index is fully fresh. `index_fresh` is
`true` only when `stale_files === 0` and the index has been run at least once.

**When used:** diagnostic — agent checks this when search returns unexpected
results, or before a long agentic workflow to confirm the index is current.

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
  "tokenizer": "@anthropic-ai/tokenizer (claude-2 era, approximate for current models)",
  "counterfactual": "Saved vs. full file Read (upper bound — overstates savings against a smart agent that would have used Grep)"
}
```

The `tokenizer` field carries the honest label from §14.5 verbatim — token
counts are approximate for current models, and consumers should treat the
savings *ratio*, not the absolute counts, as the robust number.

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
   - Its own `content`, the full method source (signature + body).
   - A `PARENT_OF` edge from the class's `symbols` row to the method's `symbols` row
     in `graph.db` (see §6.3).

3. **A `body_hash` for the class_shell** computed over the sorted concatenation of
   member signatures + member TSDoc (see §7.1 stability hash rule). This ensures
   the shell content is rewritten when methods are renamed, added, or removed — but
   **not** when method bodies change.

**Why this matters.** A 400-line service class becomes one ~30-line outline chunk
plus ~12 small method chunks (~30 lines each). `mast_search "validate session"`
returns the matching `method` chunk (~30 lines) instead of the whole class (400
lines). For class-heavy codebases the token savings move from "marginal" to
"material." Chunk count for a class-heavy 5K-file repo grows from ~6K to ~20–30K;
SQLite (chunks table + FTS5) handles this fine at sub-100MB index size.

**Interfaces and type aliases are NOT decomposed.** Their members are signatures
already (no bodies to split), so the interface or type alias remains a single chunk.

**Anonymous default exports** (`export default function () {}`, `export default {}`):
`symbol_name` is set to the filename without extension (e.g., `handler` for
`handler.ts`). This is a heuristic and `mast_search` will surface these via FTS
on the filename. A future v2 may resolve the alias from importers, but v1 keeps it
simple.

**Re-export aliases** (`export { foo as bar } from './x'`): the extractor
records `bar` as an exported **marker symbol** (kind `export`, no hashes) in
the barrel's `symbols` rows plus a `RE_EXPORTS` edge from the marker to `foo`'s
declaration; `export * from './x'` becomes a `re_export_files` row instead
(file-level — stars name no symbols). Marker rows exist to anchor the edge for
`mast_rename_impact`'s barrel checklist and are **excluded from symbol lookups**
(`querySymbolByName` filters kind `export`), so `mast_signature`/`mast_callers`
keep resolving to the real declaration rather than the barrel. Import
specifiers are resolved with the same §13.7 resolver used for `import`
statements.

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

Most functions will not trigger this split — the default of 100 lines comfortably
covers ordinary function and method bodies. The threshold exists for edge cases
(large generated files, data-heavy switch statements) where a single chunk would
otherwise be too large to be a useful, self-contained search result.

**Markdown documents (`chunk_type: "doc"`).** `.md` files are chunked by ATX
heading, not by AST — one chunk per heading of level ≤ `markdown_heading_depth`
(default 2: one chunk per `##` section). Doc chunks get
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

**Name resolution is file-scoped, not name-only.** When two files export a
same-named symbol, `insertEdges`' name→id resolution (§10.3) uses the
resolution rule's own file evidence to pick the target: `same_file` is scoped
to the calling file itself; `import` is scoped to the import's own
`resolved_path` (following the `re_export_files`/`RE_EXPORTS` chain into a
barrel when the resolved file doesn't declare the symbol directly, per §6.3);
`field_type`/`parameter_type`/`new_expression` are scoped the same way via
the receiver's type name, when that type name is itself traceable to an
import or a same-file declaration. Only when a rule has no such evidence
(e.g. a default/namespace import, which is not tracked as a named import) does
resolution fall back to a global name match — a known, narrow coverage gap,
not the general case. Prior to 2026-07-15 every rule fell back to the global
match unconditionally, so a same-named symbol in an earlier-indexed file could
silently win a `verified_callers` edge that belonged to a different file
(IMPLEMENTATION_PLAN_VEXP.md §P, "Shipped-resolver finding").

The same file-scoping applies to `RE_EXPORTS` edges (`export { x } from './y'`,
§6.3): the extractor resolves the re-export's own `from`-clause module
specifier to a real file (`EdgeRecord.toResolvedPath`) at parse time, and
`insertEdges` uses that path — not a bare name match across the whole graph —
to pick the target when two files export a same-named symbol. An unresolved
module (external, or a relative specifier that doesn't probe to a real file)
produces no edge rather than a name-only guess. This closed the sibling of the
same false-green class for `mast_rename_impact`'s `barrel_exports`
(IMPLEMENTATION_PLAN_VEXP.md §P, "Sibling false-green").

### 10.3.2 TypeScript-Checker Enrichment Pass (`mast index --checker`)

An **opt-in** CLI pass (`src/graph/checker-resolver.ts`) that uses the real
TypeScript compiler to upgrade `potential_matches` the §10.3.1 heuristic
resolver could not statically link. Reshaped from an originally-planned
always-on background worker by a spike measurement: holding every workspace
project's `ts.Program` alive at once peaked at 2.45 GB RSS, over a 2 GB gate
(IMPLEMENTATION_PLAN_VEXP.md Stage 1.1, `eval/spikes/checker-edges/REPORT.md`).
The default `mast index` path is behaviourally untouched — this only runs with
the `--checker` flag.

**What it guarantees:**

- Holds exactly **one** `ts.Program` at a time, disposed before the next
  tsconfig project loads (the spike's cautionary tale: holding all programs
  alive made a "warm" re-check *slower* than cold, via GC pressure).
- Every candidate is one of the shipped `potential_matches` pool
  (`collectPotentialMatchCandidates`, shared with `mast_callers` — never a
  second definition of "what counts as a potential match").
- `getAliasedSymbol` alias-chain following (bounded at 8 hops) on every
  resolution — without it, resolution collapses from ~38% to ~2% (spike
  finding; an import binding otherwise resolves to itself, not its target).
- **False-green gate:** a checker edge is written ONLY when the resolved
  declaration's `(file, line)` matches the queried symbol's own recorded
  `(file, line)` (±3 lines, for decorator/JSDoc/overload offsets). A same-name
  collision (two unrelated declarations sharing a method name, an
  interface-typed receiver with multiple implementors, a shadowed import)
  resolves to a DIFFERENT declaration and is classified `resolves_to_different`
  — never written as a `checker` edge. A wrong "verified" edge is worse than no
  edge (adversarial fixtures: `src/graph/__tests__/checker-resolver.test.ts`).

**What it does to each candidate:**

| Classification | Effect |
|---|---|
| Resolves to the queried declaration | A `POTENTIAL_CALL` edge is written with `resolution: 'checker'` — joins `verified_callers` exactly like a heuristic edge, and dedupes with one on the same `(from_id, to_id, edge_type)` triple. |
| Resolves to a DIFFERENT declaration | Recorded in `checker_verdicts`; drops out of `potential_matches` and is counted in `summary.checker_classified_different_declaration`. |
| Not a call site (comment, string, type position) | Recorded in `checker_verdicts`; drops out of `potential_matches` and is counted in `summary.checker_classified_non_call_site`. This residue was 30–44% of the sampled potential pool in the Stage 1.1 spike — classifying it away is itself a major token win, independent of edge upgrades. |
| Unresolvable (dynamic dispatch, DI lookup, etc.) | No edge, no verdict — stays a genuine `potential_match`, exactly as before `--checker` ran. |

**What stays potential — the checker pass does not close every gap:**

- Files outside every discovered tsconfig project (roughly 22% of the
  monorepo sample) are left completely untouched; the CLI summary reports the
  count (`outside_ts_scope`), never a silent cap.
  `discoverTsConfigProjects` finds every `tsconfig.json` under the project
  root whose `parseJsonConfigFileContent` resolves at least one file — a base
  config meant to be `extends`-ed (no own `"include"`) is skipped as
  `no_include_base_config`, and an unparseable config is skipped with the
  parser's own error text. Generic and project-shape-agnostic (unlike the
  Stage 1.1 spike's hardcoded 25-project list for this monorepo specifically).
- A call site with no enclosing declared symbol (e.g. top-level script code,
  a `block` chunk) still gets classified — so it never re-surfaces as review
  noise — but no `checker` edge is written, since there is no valid `from_id`
  to attach one to.
- Cross-package calls where the target resolves into another workspace
  package's compiled `.d.ts` output (not the `.ts` source `mast` indexed) fail
  the `(file, line)` match safely — classified `resolves_to_different`, not a
  false positive, just a missed upgrade.

**Verdict staleness — the severity-zero invariant.** A verdict must not
outlive the file content it was computed against: a stale verdict silently
suppressing a genuinely new call site is worse than never having run the pass.
`checker_verdicts.call_site_file_id REFERENCES files(id) ON DELETE CASCADE`
ties a verdict's lifetime to the file row it was computed against —
`populateFile`'s delete-and-replace on ANY content change (both full
`mast index` and the JIT re-parse triggered by staleness detection, §9.0)
cascades away every verdict for that file automatically, exactly like
`symbols`/`edges`/`imports` already do. `checker_verdicts.call_site_mtime` is
checked again at read time (`queryCheckerVerdicts`) as a second, independent
guard. Proven directly against the real Phase 1 pipeline (edit a fixture file,
reindex, assert the verdict no longer applies) in
`src/graph/__tests__/checker-resolver.test.ts`.

**Persistence.** `checker_verdicts` is a brand-new, additive table (§7.4 — no
`CURRENT_SCHEMA_VERSION` bump). Writes are flushed one tsconfig project at a
time under `structure.lock` (§7.6), kept as a short batch strictly separate
from the compiler-heavy classification loop (which holds no lock). A JIT
re-parse from a concurrent read tool is never starved behind either phase —
it no longer acquires `structure.lock` at all (§7.6, §9.0), so this
separation now matters only for coarse-writer-vs-coarse-writer contention
(e.g. a concurrent `mast_reindex`).

**Consumption.** `mast_callers` and `mast_rename_impact` (via the shared
`collectPotentialMatches`) filter `non_call_site`/`resolves_to_different`
candidates out of `potential_matches` and report honest counts in
`summary.checker_classified_non_call_site` /
`summary.checker_classified_different_declaration` (§9) — both `0` until
`--checker` has run.

---

## 11. Hook Architecture

### 11.1 Primary Hook — `mast serve` Startup

Defined in full in §7.4. Summary: a four-step ladder that brings the whole index
(graph + FTS) online in 2–4 seconds via a Docker-baked seed index (§13.8), with all
11 tools registered and ready to serve as soon as Step 3 completes — there is no
reduced-capability warm-up window. Step 4 then catches up any files changed since
the seed was built, in the background.

This is the **only hook required for the SDD pipeline**.

### 11.2 Mid-Task Hook — `mast_reindex` (agent-controlled)

The agent calls this explicitly after writes. JIT staleness handling (§9.0) already
keeps already-indexed files correct on read; `mast_reindex` is what makes a
**brand-new** file or symbol discoverable by `mast_search`/`mast_callers`/etc. before
the next scheduled or `--watch` reindex reaches it. The implement prompt instructs:

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

### 11.4 Optional Interactive Hook — `mast serve --watch`

Local interactive development has no equivalent of the container's startup
ladder: git hooks are opt-in and fire only on commit/checkout, so a long-lived
interactive session can leave newly-created files and symbols undiscoverable
between explicit `mast_reindex` calls, even though JIT re-parse (§9.0) keeps
every already-indexed file correct on read. `--watch` closes that gap as an
**opt-in** flag — it is a discovery-freshness optimization, never a correctness
mechanism, and it does not reopen the §3 no-daemon non-goal (it lives and dies
with the serve process).

Behaviour:

- A chokidar watcher covers `file_extensions` under the project root,
  respecting `exclude_patterns` **and the state directory itself** — watching
  the state dir would self-trigger on every index write.
- Events are debounced (~500ms) and coalesced: rapid saves of one file collapse
  to a single entry; distinct files within the window share one batch.
- Each batch runs the existing **incremental indexer** (§7.1) (acquiring
  `structure.lock` exactly as `mast_reindex` does — deleted files are cleaned
  up by the manifest diff).
- **Single-flight:** events arriving during an in-flight run queue a follow-up
  run; runs never overlap.
- **Lock contention:** a failed run (e.g. `structure.lock` held by
  `mast_reindex`) is logged and the batch requeued for the next debounce tick;
  after 3 consecutive failures the batch is dropped **with a warning** (JIT
  keeps existing-file reads correct, so a drop only delays discovery of new
  files/symbols).
- **Degradation:** watcher construction failure (EMFILE, permissions) or
  runtime watcher errors log a warning and the server keeps serving without
  watch. `--watch` can never take down MCP serving.
- Shutdown: the watcher closes on stdin close, SIGTERM, and SIGINT.

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
- `better-sqlite3`'s synchronous API removes async complexity from graph queries;
  the recursive CTEs are blocking operations anyway.

### 13.2 Dependency Map

| Concern | Package | Notes |
|---|---|---|
| MCP server | `@modelcontextprotocol/sdk` | Official TS SDK, stdio transport |
| BM25 | SQLite FTS5 (built-in) | Replaces external BM25 dependency entirely; `trigram` tokenizer for code identifiers |
| Knowledge graph | `better-sqlite3` + `@types/better-sqlite3` | Synchronous API, WAL mode, recursive CTEs |
| Query builder | `kysely` | Typed SQL query builder over the `better-sqlite3` connection |
| AST parsing | `tree-sitter` + `tree-sitter-typescript` | Official Node.js bindings + TypeScript grammar |
| Path resolution | `tsconfig-paths` | Resolves tsconfig `paths` aliases at index time |
| Validation | `zod` | MCP tool inputs cross a trust boundary; validate `symbol`, `file_path`, `max_depth`, etc. before hitting the DB |
| Locking | `proper-lockfile` | PID-based advisory lock; set `stale: 10000` (10s) to handle abrupt container exits |
| CLI | `commander` | Standard TS CLI |
| File walking | `fast-glob` | Glob pattern support for `exclude_patterns` |
| File watching | `chokidar` | Powers `mast serve --watch` (§11.4) |
| Token counting | `@anthropic-ai/tokenizer` | Counts `tokens_returned`/`tokens_full_file_upper_bound` for `_stats` (§14.5) |
| Identifiers | `uuid` | Per-`mast serve`-session `session_id` for metrics attribution |

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
│   │   ├── metrics-cmd.ts           # `mast metrics --since|--rollup|--vacuum` (§14)
│   │   └── install-hooks.ts
│   ├── mcp/
│   │   ├── server.ts                # MCP server setup, tool registration (§7.4 Steps 3-4)
│   │   ├── startup.ts               # bootstrap + schema-version guard + orphan-state cleanup (§7.4 Steps 1-2)
│   │   ├── staleness.ts             # stat-and-sync wrapper for all read tools (§9.0)
│   │   ├── context.ts               # AppContext (db, chunkStore, config, sessionId) shared by every tool
│   │   └── tools/
│   │       ├── search.ts            # §9 mast_search — fused BM25 + ranker D
│   │       ├── project-skeleton.ts
│   │       ├── exports.ts
│   │       ├── signature.ts
│   │       ├── callers.ts           # verified + potential partition (§9 mast_callers)
│   │       ├── dependencies.ts
│   │       ├── implementors.ts
│   │       ├── rename-impact.ts     # §9 mast_rename_impact
│   │       ├── reindex.ts
│   │       ├── status.ts
│   │       └── efficiency.ts        # mast_efficiency telemetry tool (§9, §14)
│   ├── indexer/
│   │   ├── index.ts                 # orchestrates the single indexing pass (§7.1)
│   │   ├── walker.ts                # file discovery, exclude pattern matching, manifest diff
│   │   ├── watcher.ts               # chokidar-backed `mast serve --watch` (§11.4)
│   │   └── import-resolver.ts       # tsconfig paths + pnpm workspace resolution (§13.7)
│   ├── graph/
│   │   ├── db.ts                    # better-sqlite3 + Kysely connection, schema init
│   │   ├── populate.ts              # AST → graph.db inserts (two-pass edge insertion, §10.3)
│   │   ├── queries.ts               # callers, implementors, dependencies, type-context
│   │   ├── local-type-env.ts        # POTENTIAL_CALL resolver heuristics (§10.3.1)
│   │   └── checker-resolver.ts      # opt-in `mast index --checker` pass (§10.3.2)
│   ├── ast/
│   │   ├── parser.ts                # tree-sitter setup, parse file → AST
│   │   ├── extractor.ts             # LanguageExtractor contract + FileExtraction types
│   │   ├── extract.ts               # extension dispatch → per-language extractor
│   │   ├── extractors/
│   │   │   ├── typescript.ts       # TS/JS: class-shell synth, method walk, hashes, splitting (§10.1)
│   │   │   └── markdown.ts         # heading-based doc chunking (§10.1)
│   │   └── types.ts                 # Chunk, Export, SignatureResult, config, MCP I/O shared types
│   ├── store/
│   │   ├── sqliteChunkStore.ts      # ChunkStore: chunk CRUD against graph.db's `chunks` table
│   │   ├── config.ts                # config resolution, index.json read/write
│   │   ├── lock.ts                  # structure.lock manager (§7.6)
│   │   └── lockMetrics.ts           # JSONL lock-hold telemetry sink
│   ├── search/
│   │   ├── fused.ts                 # RRF fusion of BM25 + ranker D (§7.3); D-fire telemetry
│   │   ├── declex.ts                # ranker D — declaration-exact match (§7.3)
│   │   ├── fts.ts                   # FTS5 queries (chunk_fts BM25 + identifier_fts exact match)
│   │   └── potential-matches.ts     # shared candidate collection for mast_callers/mast_rename_impact
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

**0. NodeNext `.js` specifier substitution** (e.g. `./repo.js` → `./repo.ts`)

TypeScript ESM/NodeNext code writes the *compiled* extension in relative specifiers
(`import { Repo } from './repo.js'`) even though the on-disk source is `./repo.ts`.
When a relative specifier carries a JS-family extension, the resolver looks up the
TypeScript source first and only falls back to the literal file, matching tsc's
"file extension substitution" lookup order:

| Specifier ext | Lookup order                        |
| ------------- | ----------------------------------- |
| `.js`         | `.ts`, then `.tsx`, then `.js`      |
| `.jsx`        | `.tsx`, then `.jsx`                 |
| `.mjs`        | `.mts`, then `.mjs`                 |
| `.cjs`        | `.cts`, then `.cjs`                 |

The source-first precedence means that when both `x.ts` and a real `x.js` exist,
`./x.js` resolves to `x.ts` (the `.js` names the *output*). A genuine `.js` file with
no TypeScript source still resolves to itself. Declaration files (`.d.ts`) are out of
scope — MAST indexes implementation files. Without this rule, ESM `.js` specifiers left
`resolved_path` NULL and star re-export barrels written with `.js` produced no
`re_export_files` rows. See the TypeScript Modules Reference, "File extension
substitution".

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

The index is pre-warmed during `docker build` to eliminate cold-start dead time on
the first container run. Without this, the first task can stall for minutes while
the index builds from scratch — a UX risk identified in the design review
(Failure 4).

#### 13.8.1 Seed Index Pre-Warm

For a 5K-file class-heavy repo, indexing from scratch takes on the order of a
minute or more. During that window the agent has a cold, empty index. The seed
index moves this work into the Docker build, so the runtime container starts with
a fully-warmed index for the build-time commit.

```dockerfile
# After the application source is copied into the image and dependencies installed:
RUN mast init /workspace --state-dir /opt/mast-seed --no-index \
 && mast index /workspace --state-dir /opt/mast-seed
```

Two important properties of the seed:

1. **The index runs fully at build time.** The seed contains a fully-populated
   `graph.db` (chunks, symbols, edges, `chunk_fts`, `identifier_fts`). The runtime
   container is ready to serve at full capability immediately (Step 3 of §7.4) — no
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

- RRF fusion logic
- Incremental indexing strategy (mtime-based staleness)

### 13.11 Distribution

```
pip install          # not applicable
npm install -g mast-search    # installs CLI + MCP server
```

For the SDD pipeline, mast is installed into the claude-runner Docker image. The
Docker-baked seed index (§13.8) is pre-built into the image layer to avoid a
from-scratch index build inside a task container.

For external developers:

```bash
npm install -g mast-search
mast init .                      # initialise index
claude mcp add mast -- mast serve   # wire into Claude Code
```

There is only one install shape — lexical + declaration-exact search is the whole
product, so no `--no-embeddings`-style variant is needed.

---

## 14. Telemetry & Measurement

The MAST thesis is **chunks not files → fewer tokens per task**. If that claim is
not measurable, the index and the Docker layers that support it are a complexity
budget the project cannot defend. This section
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
  read-light. The one documented exception is `tokens_full_file_upper_bound` for
  whole-project-scale callers (`mast_project_skeleton`, §14.2): exact tokenization
  alone already exceeds 1ms per file, so this counterfactual is bounded instead by a
  per-call tokenization budget (F8, §14.2) — worst case ~0.7-0.8s on a first call
  against an uncached project, converging toward the < 1ms goal as the cache warms and
  degenerating to true negligible overhead (cache hits only) once fully warm.

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
    "duration_ms": 38
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

**Honest framing.** `tokens_full_file_upper_bound` is explicitly labelled as an upper
bound. A smart agent using `Grep -A 10 -B 10` would have used fewer tokens than the
upper bound but more than MAST — the real saving sits between zero and `efficiency_ratio`.
Reporting the upper bound is defensible because the methodology is documented and
the label is honest. Reporting "X% savings" with no upper-bound qualifier would not
survive scrutiny.

**Implementation status.** `tokens_full_file_upper_bound` is computed — for each
unique file in `files_referenced`, `estimateFullFileBound` (`telemetry/tokenizer.ts`)
reads the file's full contents from the project root and sums `countTokens` over
them, with an mtime-keyed cache so repeated calls against an unchanged file don't
re-tokenize. It previously shipped as an unimplemented stub that always returned 0,
which made `efficiency_ratio` a constant 0 across every recorded row (see the
Promotion Log, 2026-07-15) — that regression is what this fixes.

**Per-call work cap (F8, 2026-08-07).** Reading and tokenizing every referenced file
does not scale to a caller like `mast_project_skeleton`, which references every file
in the project — `estimateFullFileBound` measured ~28s/call on a 1,334-file project,
99% of it here. Beyond a per-call budget (`FULL_FILE_TOKENIZE_BUDGET_PER_CALL = 32`
exact reads per call, cache hits excluded), further cache-miss files are **not** read
or tokenized; they are size-estimated instead, at
`Math.ceil(sizeBytes / BYTES_PER_TOKEN_ESTIMATE)` bytes-per-token
(`BYTES_PER_TOKEN_ESTIMATE = 4`, the standard heuristic for source text) and are not
cached — an estimate must never masquerade as an exact cached count. Successive calls
over the same file set progressively convert estimates to exact, cached counts as the
budget reaches further into the set, converging to fully-exact after enough calls with
zero cache thrash (`FULL_FILE_BOUND_CACHE_LIMIT` raised from 200 to 8192 alongside the
budget — see `telemetry/tokenizer.ts` doc comments). The upper-bound counterfactual was
already explicitly approximate (see "Honest framing" above and §14.5); the size
estimate for budget-exceeding files is an additional, documented layer of the same
approximation, not a departure from it.

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
  mode                            TEXT,                    -- historical: pre-2026-08-06 rows only ("hybrid"|"lexical"); new rows NULL
  session_id                      TEXT NOT NULL,           -- uuid set at mast serve startup
  status                          TEXT NOT NULL,           -- "ok" | "stale_returned" | "error"
  args_json                       TEXT,                    -- salient tool arguments, capped at 1,000 chars
  results_json                    TEXT,                    -- {file_path, symbol_name} identity pairs, capped at 20 entries
  declex_json                     TEXT                     -- ranker D fire telemetry (mast_search only), NULL when D silent
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

**Argument/result identity columns (`args_json`, `results_json`).** Added additively
(`ALTER TABLE metrics ADD COLUMN`, same precedent as `edges.resolution`/`call_line`/
`context` — no `CURRENT_SCHEMA_VERSION` bump) to make the "linked chain" measurable:
did a later `mast_signature`/`mast_exports`/`mast_callers` call target a symbol or
file that an earlier `mast_search` returned in the same session? This was the missing
instrumentation the `mast_capsule` v2 hold identified (Promotion Log, 2026-07-15) —
without it, a capsule chain-rate measurement can only be an argument-blind upper
bound. `args_json` carries the salient tool arguments (query + filters for search;
symbol and/or file_path for signature/exports/callers), capped at 1,000 characters;
`results_json` carries the tool's returned `{file_path, symbol_name}` identity pairs
in rank order, capped at 20 entries. Both caps are stated honestly in the payload
when hit (`_truncated`) rather than silently cut. Wired for `mast_search`,
`mast_signature`, `mast_exports`, and `mast_callers` — the chain-analysis tools the
capsule decision depends on; both columns are `NULL` for every other tool and for
rows recorded before this migration.

**`declex_json` (F18 D-fire telemetry — M2 decision memo condition 3).** Added
via the same additive `ALTER TABLE` precedent (no schema bump). Populated only
on `mast_search` calls where ranker D (§7.3) actually fired; `NULL` when D was
silent, when `declaration_exact_ranker` is off, for every other tool, and for
pre-migration rows. Shape: `{fired: true, top_match_channel: "full"|"segment",
candidate_count, window_effects: [{chunk_id, symbol_name, rank_with_d,
rank_without_d}], _truncated?}`. `window_effects` is a dual-fusion diff computed
in-memory per call — the fused (pre-dedup) rank of each affected chunk with D's
list included vs excluded from RRF; ranks are the actual positions in each list
(`null` only when the chunk is absent from that list entirely, e.g. a D-only
anchor has `rank_without_d: null`), capped at 10 entries with a top-level
`_truncated` count. This column is the input signal for the F18 kill-switch and
the M2 re-entry criteria: fire rate on real queries, and whether D demotes
in-window targets, are both answerable from it without re-instrumenting.

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

`@anthropic-ai/tokenizer` (`^0.0.4`) counts `tokens_returned` and
`tokens_full_file_upper_bound` — but it is **approximate, not ground truth**.
The package implements the Claude 2-era tokenizer, and Anthropic never
published the Claude 3+ vocabularies, so absolute counts drift for every model
that actually consumes MAST output today.

```typescript
import { countTokens } from "@anthropic-ai/tokenizer";
const n = countTokens(responseBodyAsString);
```

**Why this is still the right mechanism.** §14.2's headline number is the
savings *ratio*, and both its numerator and denominator are counted with the
same tokenizer — the per-count error mostly cancels, so the ratio is robust
even though the absolute counts are not. The same honesty rule that governs
the upper-bound counterfactual (§14.2) applies here: report the limitation,
don't paper over it.

**The label.** The active tokenizer is reported verbatim in `mast_efficiency`'s
`tokenizer` field and in `mast metrics`'s footer as:

```
@anthropic-ai/tokenizer (claude-2 era, approximate for current models)
```

The string has one definition (`TOKENIZER_LABEL` in `src/telemetry/tokenizer.ts`)
that every consumer reads, so the wording cannot drift between surfaces.

**Future seams (not implemented).** An exact mode via the Anthropic API's
`count_tokens` endpoint (opt-in, requires an API key) and a `tiktoken
cl100k_base` fallback for non-Claude consumers are both documented options;
neither ships today, and if either is added the reported label must change to
match the active counter.

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
Tokenizer: @anthropic-ai/tokenizer (claude-2 era, approximate for current models)

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
- **Per-user / per-agent attribution.** v1 has one agent per `mast serve` session;
  multi-tenancy is out of scope.
