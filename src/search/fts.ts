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
  // this runs outside fusedSearch's try/catch) fail the whole search.
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

/**
 * Near-miss identifier search over `identifier_fts`.
 *
 * Unlike {@link searchIdentifiers} (which requires an exact phrase match on the
 * full symbol), this ORs each term so a chunk matching *any* sub-term is
 * returned. Used by the zero-result assist path to gather candidate chunks
 * whose identifiers partially overlap a query that otherwise found nothing.
 *
 * Terms are quoted as phrases so separator chars never leak into FTS5 query
 * syntax. Returns an empty array when no usable term remains.
 */
export async function searchIdentifierNearMiss(
  db: Db,
  terms: readonly string[],
  limit = 20,
): Promise<IdentifierFtsRow[]> {
  const cleaned = terms.map((t) => t.trim()).filter((t) => t.length > 0);
  if (cleaned.length === 0) return [];
  const matchExpr = cleaned.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
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

/**
 * Split an identifier-shaped query into its constituent sub-terms.
 *
 * Handles camelCase (`getUser` → `get`, `user`), acronym boundaries
 * (`HTTPServer` → `http`, `server`), and snake/kebab separators. Sub-terms are
 * lowercased (FTS5 trigram matching is case-insensitive), de-duplicated, and
 * filtered below the 3-char trigram floor — a sub-term shorter than a trigram
 * cannot match `chunk_fts` anyway. Returns an empty array when nothing usable
 * remains, so callers can short-circuit the assist.
 */
export function splitIdentifierTerms(query: string): string[] {
  const spaced = query
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')     // camelCase: fooBar -> foo Bar
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2'); // acronym: HTTPServer -> HTTP Server
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of spaced.split(/[^A-Za-z0-9]+/)) {
    const term = part.toLowerCase();
    if (term.length < 3) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    out.push(term);
  }
  return out;
}

/** Convert a glob pattern to a SQL LIKE pattern (`*` → `%`, `?` → `_`). */
function globToLike(pattern: string): string {
  return pattern.replace(/\*/g, '%').replace(/\?/g, '_');
}

/**
 * Turn a free-form query into a safe FTS5 MATCH expression for the trigram
 * `chunk_fts`: identifier-ish tokens (length ≥ 3, the trigram minimum), each
 * quoted as a phrase so no character is treated as query syntax, joined by
 * `OR`. Returns null when no usable token remains, so the caller can
 * short-circuit to an empty result instead of running an invalid query.
 *
 * **F15 — why OR and not AND.** FTS5 ANDs bare space-separated phrases, so the
 * previous space-join required a chunk to contain *every* token. A conceptual
 * multi-word query therefore matched nothing at all: measured against the nest
 * corpus, 6 of 20 TSDoc-derived queries returned zero rows despite the corpus
 * plainly containing the target symbol (e.g. "precondition failed exception
 * defines an http for type errors" → 0 rows ANDed, 5 ORed). That silently
 * crippled the lexical half of hybrid search, and made the vector store look
 * indispensable when it was partly compensating for this bug — see
 * IMPLEMENTATION_PLAN.md § "nest replication".
 *
 * Recall is not traded for precision here: `bm25()` already ranks by term
 * coverage and inverse document frequency, so a chunk matching every token
 * still outranks one matching a single common token. OR widens the candidate
 * pool and lets the ranker do the discriminating — which is what
 * `identifier_fts` (searchIdentifiers, below) has always done.
 */
function toFtsMatch(query: string): string | null {
  const tokens = (query.match(/[A-Za-z0-9_]+/g) ?? []).filter((t) => t.length >= 3);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}
