import { sql, type SqlBool } from 'kysely';
import type { Db } from '../graph/db.js';
import { resolveScopedPaths } from './scope.js';

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
 * `filePattern` and `language` are applied as an `IN` list on `file_path`,
 * built before the ORDER BY and LIMIT clauses so the restriction is part of
 * the ranked query rather than a post-filter on its window. Both are resolved
 * through `./scope.ts`, which owns the glob and language semantics for every
 * ranker `fusedSearch` fuses — this function must not translate the pattern
 * itself, or the two rankers can disagree about what the caller asked for.
 * `chunk_type` and `only_exported` are post-filters applied by the caller
 * after fetching full chunk records from the chunk store.
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
  // The scope is therefore materialised against the regular `files` table
  // first, then passed as an IN list to the FTS query.
  const allowedPaths = await resolveScopedPaths(db, {
    filePattern: options.filePattern,
    language: options.language,
  });
  // A scope that matched no indexed file is an empty result, not an
  // unrestricted one — `null` means "no scope given" and must not be conflated.
  if (allowedPaths !== null && allowedPaths.length === 0) return [];

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
  const matchExpr = buildIdentifierMatchExpr(symbolName);
  if (matchExpr === null) return [];
  return db
    .selectFrom('identifier_fts')
    .select('chunk_id')
    .where(sql<SqlBool>`identifier_fts MATCH ${matchExpr}`)
    .limit(limit)
    .execute();
}

/**
 * Uncapped match count for `symbolName` over `identifier_fts` — same
 * phrase-quoted MATCH expression as {@link searchIdentifiers} (via the shared
 * {@link buildIdentifierMatchExpr} helper, never duplicated), no `LIMIT`.
 *
 * F10 (Stage 3, IMPLEMENTATION_PLAN.md): `searchIdentifiers`' cap silently
 * dropped real matches with no signal the cap was hit
 * (`eval/GITNEXUS_COMPARISON.md` M4 — `isUndefined` reported 50 candidates
 * when the real count was 71). Callers should run this ONLY when the capped
 * fetch came back full (`identRows.length === limit`) — below the cap, the
 * fetch count already IS the real count, and this query would be pure waste.
 */
export async function countIdentifierMatches(db: Db, symbolName: string): Promise<number> {
  const matchExpr = buildIdentifierMatchExpr(symbolName);
  if (matchExpr === null) return 0;
  const row = await db
    .selectFrom('identifier_fts')
    .select((eb) => eb.fn.count<number>('chunk_id').as('count'))
    .where(sql<SqlBool>`identifier_fts MATCH ${matchExpr}`)
    .executeTakeFirst();
  return row?.count ?? 0;
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

/**
 * Build the phrase-quoted FTS5 MATCH expression shared by
 * {@link searchIdentifiers} and {@link countIdentifierMatches} — the two must
 * agree on exactly which rows count as a match, or the "real count" F10
 * reports could disagree with what the capped fetch actually returned.
 * Quoting as a phrase means any separator char (e.g. `Class.method`) is
 * matched literally rather than parsed as FTS5 query syntax. Returns null for
 * an empty/whitespace-only name, so callers can short-circuit instead of
 * running an invalid MATCH query.
 */
function buildIdentifierMatchExpr(symbolName: string): string | null {
  const term = symbolName.trim();
  if (term === '') return null;
  return `"${term.replace(/"/g, '""')}"`;
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
