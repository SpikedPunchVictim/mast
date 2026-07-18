import Sqlite from 'better-sqlite3';
import { join } from 'node:path';
import { Kysely, SqliteDialect, sql } from 'kysely';
import type { ColumnType, Generated } from 'kysely';

// ---------------------------------------------------------------------------
// Table schema types
// ---------------------------------------------------------------------------

/**
 * SQLite stores booleans as INTEGER (0 | 1).
 * `BoolCol` makes this explicit at the type level so callers know to coerce.
 */
type BoolCol = ColumnType<number, 0 | 1, 0 | 1>;

interface FilesTable {
  readonly id: Generated<number>;
  readonly path: string;
  readonly language: string;
  readonly mtime: number;
}

interface SymbolsTable {
  readonly id: Generated<number>;
  readonly name: string;
  /** `function | class | interface | type | const | method` */
  readonly kind: string;
  readonly file_id: number;
  readonly line: number;
  readonly is_exported: BoolCol;
  /** sha256 of signature text only (excludes body). Null until first index. */
  readonly declaration_hash: string | null;
  /** sha256 of body text; for class_shell, over sorted member signatures. */
  readonly body_hash: string | null;
}

/**
 * Edge types:
 * - `POTENTIAL_CALL` — name-resolved call site
 * - `IMPLEMENTS` — class implements interface
 * - `EXTENDS` — class/interface extends another
 * - `RE_EXPORTS` — symbol-to-symbol re-export
 * - `PARENT_OF` — class → method (class body decomposition)
 */
interface EdgesTable {
  readonly from_id: number;
  readonly to_id: number;
  readonly edge_type: string;
  /** Resolution rule for POTENTIAL_CALL edges (§10.3.1); null for others. */
  readonly resolution: string | null;
  /** 1-indexed source line of the call site; null for non-call edges. */
  readonly call_line: number | null;
  /** Trimmed source text of the call-site line; null for non-call edges. */
  readonly context: string | null;
}

/** File-level re-export: `export * from '...'` */
interface ReExportFilesTable {
  readonly from_file_id: number;
  readonly to_file_id: number;
}

interface ImportsTable {
  readonly file_id: number;
  readonly module: string;
  /** JSON-serialised string[]. Stored as TEXT; parse on read. */
  readonly symbols: string;
  readonly is_external: BoolCol;
  /** Null for external modules; resolved real path for monorepo imports. */
  readonly resolved_path: string | null;
}

interface MetricsTable {
  readonly id: Generated<number>;
  readonly tool_name: string;
  readonly call_timestamp: number;  // unix epoch seconds (REAL in SQLite)
  readonly tokens_returned: number;
  readonly tokens_full_file_upper_bound: number;
  readonly duration_ms: number;
  readonly mode: string | null;     // 'hybrid' | 'lexical' | null
  readonly session_id: string;
  readonly status: string;          // 'ok' | 'stale_returned' | 'error'
  /**
   * JSON of the salient tool arguments (query + filters for search; symbol
   * and/or file_path for signature/exports/callers/etc.), capped at 1,000
   * chars — the linked-chain measurability the capsule instrumentation
   * decision needs (IMPLEMENTATION_PLAN_VEXP.md §P, 2026-07-15). Null for
   * tools that do not yet record argument identity and for pre-migration rows.
   */
  readonly args_json: string | null;
  /**
   * JSON array of `{file_path, symbol_name}` identity pairs the tool
   * returned, in rank order, capped at 20 entries. Null for tools that do
   * not yet record result identity and for pre-migration rows.
   */
  readonly results_json: string | null;
}

/**
 * Checker-pass classifications (`mast index --checker`, Stage 1.2). Additive —
 * a brand-new table needs no `CURRENT_SCHEMA_VERSION` bump, per the
 * `openDatabase` additive-migration precedent (§7.4).
 *
 * A verdict is keyed to the exact potential-match candidate it was computed
 * for: `queried_symbol_id` (the symbol collectPotentialMatchCandidates was
 * searching for) + `call_site_file_id`/`call_site_line` (the SAME chunk
 * identity `collectPotentialMatches` dedupes on, §9 mast_callers). This is
 * what lets a future call filter the exact same candidate out without
 * recomputing anything.
 *
 * Staleness: `call_site_file_id REFERENCES files(id) ON DELETE CASCADE` ties a
 * verdict's lifetime to the file row it was computed against — `populateFile`
 * deletes-and-replaces a file's `files` row on every content change (Phase 1
 * and JIT re-parse both go through it), which cascades away every verdict for
 * that file automatically, exactly like `symbols`/`edges`/`imports` already
 * do. `call_site_mtime` is a second, explicit guard checked at read time
 * (`queryCheckerVerdicts`) — defense in depth against any future write path
 * that touches `files.mtime` without a full delete/cascade. A stale verdict
 * silently suppressing a real new call site is this feature's severity-zero
 * failure mode (IMPLEMENTATION_PLAN_VEXP.md Stage 1.2 brief); the CASCADE and
 * the mtime check are two independent ways to close it.
 */
interface CheckerVerdictsTable {
  readonly queried_symbol_id: number;
  readonly call_site_file_id: number;
  readonly call_site_line: number;
  /** 'resolves_to_queried' | 'resolves_to_different' | 'non_call_site' — 'unresolved' is never persisted (leaves the candidate as a genuine potential match, no state to track). */
  readonly verdict: string;
  readonly call_site_mtime: number;
}

interface MetricsDailyTable {
  readonly day: string;             // ISO date e.g. '2026-05-13'
  readonly tool_name: string;
  readonly calls: number;
  readonly tokens_returned_total: number;
  readonly tokens_full_file_total: number;
  readonly avg_duration_ms: number;
}

/**
 * FTS5 virtual table for BM25 full-text search over chunk content.
 *
 * `content` is the full-text indexed column (trigram tokeniser).
 * All other columns are UNINDEXED — stored but not full-text indexed.
 * `file_path` enables filtered deletes and upserts without a LIKE prefix hack.
 */
interface ChunkFtsTable {
  readonly content: string;
  readonly symbol_name: string | null;
  readonly chunk_id: string;
  readonly file_path: string;
}

/**
 * FTS5 virtual table for exact-identifier lookup.
 *
 * `identifiers` is the full-text indexed column (unicode61 with identifier
 * boundary separators). `chunk_id` and `file_path` are UNINDEXED.
 */
interface IdentifierFtsTable {
  readonly identifiers: string;
  readonly chunk_id: string;
  readonly file_path: string;
}

// ---------------------------------------------------------------------------
// Database interface — maps table names to their row types
// ---------------------------------------------------------------------------

/** Full Kysely database schema for MAST's SQLite store. */
export interface MastDatabase {
  readonly files: FilesTable;
  readonly symbols: SymbolsTable;
  readonly edges: EdgesTable;
  readonly re_export_files: ReExportFilesTable;
  readonly imports: ImportsTable;
  readonly metrics: MetricsTable;
  readonly metrics_daily: MetricsDailyTable;
  readonly checker_verdicts: CheckerVerdictsTable;
  readonly chunk_fts: ChunkFtsTable;
  readonly identifier_fts: IdentifierFtsTable;
}

export type Db = Kysely<MastDatabase>;

// ---------------------------------------------------------------------------
// Schema initialisation SQL
// ---------------------------------------------------------------------------

/**
 * Raw DDL for tables Kysely's schema builder cannot express:
 * FTS5 virtual tables and composite primary keys without a surrogate PK.
 */
const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS files (
  id       INTEGER PRIMARY KEY,
  path     TEXT NOT NULL UNIQUE,
  language TEXT NOT NULL,
  mtime    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL,
  file_id          INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  line             INTEGER NOT NULL,
  is_exported      INTEGER NOT NULL DEFAULT 0,
  declaration_hash TEXT,
  body_hash        TEXT
);

CREATE TABLE IF NOT EXISTS edges (
  from_id    INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  to_id      INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  edge_type  TEXT NOT NULL,
  resolution TEXT,
  call_line  INTEGER,
  context    TEXT,
  PRIMARY KEY (from_id, to_id, edge_type)
);

CREATE TABLE IF NOT EXISTS re_export_files (
  from_file_id  INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  to_file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  PRIMARY KEY (from_file_id, to_file_id)
);

CREATE TABLE IF NOT EXISTS imports (
  file_id       INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  module        TEXT NOT NULL,
  symbols       TEXT NOT NULL,
  is_external   INTEGER NOT NULL DEFAULT 0,
  resolved_path TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
  content,
  symbol_name UNINDEXED,
  chunk_id    UNINDEXED,
  file_path   UNINDEXED,
  tokenize    = 'trigram'
);

CREATE VIRTUAL TABLE IF NOT EXISTS identifier_fts USING fts5(
  identifiers,
  chunk_id  UNINDEXED,
  file_path UNINDEXED,
  tokenize = "unicode61 separators '.-_/()[]{}<>:;,=+*&|!?'"
);

CREATE INDEX IF NOT EXISTS idx_symbols_lookup   ON symbols(name, file_id, line, kind);
CREATE INDEX IF NOT EXISTS idx_symbols_file     ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_edges_from       ON edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to         ON edges(to_id);
CREATE INDEX IF NOT EXISTS idx_imports_file     ON imports(file_id);
CREATE INDEX IF NOT EXISTS idx_imports_resolved ON imports(resolved_path);

CREATE TABLE IF NOT EXISTS metrics (
  id                           INTEGER PRIMARY KEY,
  tool_name                    TEXT NOT NULL,
  call_timestamp               REAL NOT NULL,
  tokens_returned              INTEGER NOT NULL,
  tokens_full_file_upper_bound INTEGER NOT NULL,
  duration_ms                  INTEGER NOT NULL,
  mode                         TEXT,
  session_id                   TEXT NOT NULL,
  status                       TEXT NOT NULL,
  args_json                    TEXT,
  results_json                 TEXT
);

CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics(call_timestamp);
CREATE INDEX IF NOT EXISTS idx_metrics_tool      ON metrics(tool_name);
CREATE INDEX IF NOT EXISTS idx_metrics_session   ON metrics(session_id);

CREATE TABLE IF NOT EXISTS metrics_daily (
  day                        TEXT NOT NULL,
  tool_name                  TEXT NOT NULL,
  calls                      INTEGER NOT NULL,
  tokens_returned_total      INTEGER NOT NULL,
  tokens_full_file_total     INTEGER NOT NULL,
  avg_duration_ms            REAL NOT NULL,
  PRIMARY KEY (day, tool_name)
);

CREATE TABLE IF NOT EXISTS checker_verdicts (
  queried_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  call_site_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  call_site_line    INTEGER NOT NULL,
  verdict           TEXT NOT NULL,
  call_site_mtime   REAL NOT NULL,
  PRIMARY KEY (queried_symbol_id, call_site_file_id, call_site_line)
);

CREATE INDEX IF NOT EXISTS idx_checker_verdicts_file ON checker_verdicts(call_site_file_id);
`;

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Open (or create) the MAST graph database.
 *
 * - WAL mode is set on the underlying better-sqlite3 connection before
 *   handing it to Kysely; WAL cannot be set via Kysely's query API.
 * - The schema is initialised synchronously on open (DDL is idempotent).
 * - Returns a typed `Kysely<MastDatabase>` instance. Callers must call
 *   `await db.destroy()` on shutdown.
 */
export function openDatabase(stateDir: string): Db {
  const sqlite = new Sqlite(join(stateDir, 'graph.db'));

  // WAL + FK must be set on the raw connection before Kysely wraps it.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  // Apply schema DDL synchronously — safe at startup, idempotent.
  sqlite.exec(SCHEMA_DDL);

  // Backward-compatible column additions for the edges table. `CREATE TABLE IF
  // NOT EXISTS` will not add columns to a pre-existing table, so migrate them
  // in explicitly. ADD COLUMN is cheap (no table rewrite) and idempotent here
  // because it is guarded by the current column set.
  const edgeColumns = new Set(
    sqlite.prepare('PRAGMA table_info(edges)').all().map((c) => (c as { name: string }).name),
  );
  for (const [name, ddl] of [
    ['resolution', 'ALTER TABLE edges ADD COLUMN resolution TEXT'],
    ['call_line', 'ALTER TABLE edges ADD COLUMN call_line INTEGER'],
    ['context', 'ALTER TABLE edges ADD COLUMN context TEXT'],
  ] as const) {
    if (!edgeColumns.has(name)) sqlite.exec(ddl);
  }

  // Same additive-migration precedent for the metrics table's argument/result
  // identity columns (§14.3) — added after some databases already had a
  // `metrics` table, so `CREATE TABLE IF NOT EXISTS` alone would not add them.
  const metricsColumns = new Set(
    sqlite.prepare('PRAGMA table_info(metrics)').all().map((c) => (c as { name: string }).name),
  );
  for (const [name, ddl] of [
    ['args_json', 'ALTER TABLE metrics ADD COLUMN args_json TEXT'],
    ['results_json', 'ALTER TABLE metrics ADD COLUMN results_json TEXT'],
  ] as const) {
    if (!metricsColumns.has(name)) sqlite.exec(ddl);
  }

  return new Kysely<MastDatabase>({
    dialect: new SqliteDialect({ database: sqlite }),
  });
}

// ---------------------------------------------------------------------------
// Domain constants
// ---------------------------------------------------------------------------

export const EdgeType = {
  POTENTIAL_CALL: 'POTENTIAL_CALL',
  IMPLEMENTS:     'IMPLEMENTS',
  EXTENDS:        'EXTENDS',
  RE_EXPORTS:     'RE_EXPORTS',
  PARENT_OF:      'PARENT_OF',
} as const;

export type EdgeType = (typeof EdgeType)[keyof typeof EdgeType];

export const SymbolKind = {
  FUNCTION:  'function',
  CLASS:     'class',
  INTERFACE: 'interface',
  TYPE:      'type',
  CONST:     'const',
  METHOD:    'method',
} as const;

export type SymbolKind = (typeof SymbolKind)[keyof typeof SymbolKind];

// Re-export `sql` so callers (e.g. search/fts.ts) can import it from one place.
export { sql };
