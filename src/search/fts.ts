import { sql, type SqlBool } from 'kysely';
import type { Db } from '../graph/db.js';

// ---------------------------------------------------------------------------
// BM25 full-text search (chunk_fts, trigram tokeniser)
// ---------------------------------------------------------------------------

export interface FtsSearchOptions {
  readonly limit: number;
  readonly filePattern?: string | null;
  readonly language?: string | null;
}

export interface FtsSearchRow {
  readonly chunk_id: string;
  readonly symbol_name: string | null;
  readonly bm25_score: number;
  readonly match_snippet: string;
}

/**
 * BM25 search over `chunk_fts` using SQLite FTS5.
 *
 * The trigram tokeniser surfaces camelCase identifiers and partial matches.
 * `bm25(chunk_fts)` returns negative scores — lower (more negative) is a
 * better match. Results are sorted ascending (best first) before RRF ranking.
 *
 * `filePattern` and `language` are applied as SQL predicates before the
 * ORDER BY and LIMIT clauses so the FTS5 optimizer can apply them correctly.
 * `chunk_type` and `only_exported` are post-filters applied by the caller
 * after fetching full chunk records from LanceDB.
 */
export async function searchFts(
  db: Db,
  query: string,
  options: FtsSearchOptions,
): Promise<FtsSearchRow[]> {
  // Sanitise the user query into a safe FTS5 expression. Passing the raw string
  // to MATCH lets FTS5 interpret `(`, `:`, `"`, `OR`, etc. as query syntax — a
  // query like `handleLogin(req` would throw "fts5: syntax error" and (because
  // this runs outside hybridSearch's try/catch) fail the whole search.
  const matchExpr = toFtsMatch(query);
  if (matchExpr === null) return [];

  // SQLite FTS5 UNINDEXED columns support IN with a literal list reliably,
  // but LIKE and subquery IN may not be applied by the FTS5 query planner.
  // Both filePattern and language filters are therefore materialised via the
  // regular `files` table first, then passed as IN lists to the FTS query.
  let allowedPaths: string[] | null = null;

  if (options.filePattern !== null && options.filePattern !== undefined) {
    const rows = await db
      .selectFrom('files')
      .select('path')
      .where('path', 'like', globToLike(options.filePattern))
      .execute();
    if (rows.length === 0) return [];
    allowedPaths = rows.map((r) => r.path);
  }

  if (options.language !== null && options.language !== undefined) {
    const rows = await db
      .selectFrom('files')
      .select('path')
      .where('language', '=', options.language)
      .execute();
    if (rows.length === 0) return [];
    const langSet = new Set(rows.map((r) => r.path));
    allowedPaths = allowedPaths === null
      ? [...langSet]
      : allowedPaths.filter((p) => langSet.has(p));
    if (allowedPaths.length === 0) return [];
  }

  // Build all WHERE conditions before ORDER BY / LIMIT.
  let q = db
    .selectFrom('chunk_fts')
    .select([
      'chunk_id',
      'symbol_name',
      sql<number>`bm25(chunk_fts)`.as('bm25_score'),
      sql<string>`snippet(chunk_fts, 0, '**', '**', '...', 12)`.as('match_snippet'),
    ])
    .where(sql<SqlBool>`chunk_fts MATCH ${matchExpr}`);

  if (allowedPaths !== null) {
    q = q.where('file_path', 'in', allowedPaths);
  }

  return q
    .orderBy(sql`bm25(chunk_fts)`, 'asc')
    .limit(options.limit * 2)
    .execute();
}

// ---------------------------------------------------------------------------
// Identifier-exact FTS (identifier_fts, unicode61 tokeniser)
// ---------------------------------------------------------------------------

export interface IdentifierFtsRow {
  readonly chunk_id: string;
}

/**
 * Exact-identifier search over `identifier_fts`.
 *
 * Used by `mast_callers` to produce the `potential_matches` set — chunks that
 * contain the symbol name as an identifier token but whose call site the
 * heuristic resolver could not statically link.
 */
export async function searchIdentifiers(
  db: Db,
  symbolName: string,
  limit = 50,
): Promise<IdentifierFtsRow[]> {
  const term = symbolName.trim();
  if (term === '') return [];
  // Quote as a phrase so any separator chars (e.g. `Class.method`) are matched
  // literally rather than parsed as FTS5 query operators.
  const matchExpr = `"${term.replace(/"/g, '""')}"`;
  return db
    .selectFrom('identifier_fts')
    .select('chunk_id')
    .where(sql<SqlBool>`identifier_fts MATCH ${matchExpr}`)
    .limit(limit)
    .execute();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a glob pattern to a SQL LIKE pattern (`*` → `%`, `?` → `_`). */
function globToLike(pattern: string): string {
  return pattern.replace(/\*/g, '%').replace(/\?/g, '_');
}

/**
 * Turn a free-form query into a safe FTS5 MATCH expression for the trigram
 * `chunk_fts`: identifier-ish tokens (length ≥ 3, the trigram minimum), each
 * quoted as a phrase so no character is treated as query syntax, joined by
 * spaces (FTS5 ANDs bare phrases). Returns null when no usable token remains,
 * so the caller can short-circuit to an empty result instead of running an
 * invalid query.
 */
function toFtsMatch(query: string): string | null {
  const tokens = (query.match(/[A-Za-z0-9_]+/g) ?? []).filter((t) => t.length >= 3);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(' ');
}
