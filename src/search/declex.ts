/**
 * Ranker D — the declaration-exact ranker: a match against `chunks.symbol_name`
 * (full-name or final-dot-segment), case-insensitive, deterministically
 * ordered.
 *
 * Ported from `eval/declex-ranker.mjs`, the Q1/DECLEX-measured construction
 * (IMPLEMENTATION_PLAN.md § "Q1/DECLEX — the declaration-exact ranker" +
 * AMENDMENT 1, commit dd10796; Stage 6 of the productization plan). PRIMARY
 * ARM ONLY — this file intentionally does NOT port the escape variant
 * (`escape`/`escapeCap` options, `escapeEligibleTerms`/
 * `lowercaseTokenMatchCounts` diagnostics) or `classifyTargetReach`
 * (instrument-analysis machinery, not product). The escape variant was
 * measured harmful off-stratum (M2 decision memo) and is barred from
 * shipping without a fresh pre-registration.
 *
 * Ranker D queries the `chunks` table DIRECTLY (not `chunk_fts`/
 * `identifier_fts`): `chunk_fts.symbol_name` is stored UNINDEXED
 * (`src/graph/db.ts`) — not reachable via FTS5 MATCH — and the registered
 * match rule ("equals the chunk's own symbol_name OR its final dot-segment")
 * is a structural string comparison, not a full-text match, so a direct SQL
 * predicate against `chunks.symbol_name` is the correct primitive.
 */

import { sql, type SqlBool } from 'kysely';
import type { Db } from '../graph/db.js';

/**
 * Ranker D's candidate pool multiplier — 4x the caller's own `limit`, the
 * SAME convention as ranker I (`eval/idfuse-ranker.mjs`, AMENDMENT 1 F8) and
 * `searchVectors`: the caller multiplies by 4 and passes the already-
 * multiplied limit directly; `searchRankerD` applies no further internal
 * multiplication.
 */
export const RANKER_D_POOL_MULTIPLIER = 4;

// ---------------------------------------------------------------------------
// Term derivation + eligibility gate (pure, no DB)
// ---------------------------------------------------------------------------

/** Raw token split — identical character class to ranker I's own derivation
 * (`eval/idfuse-ranker.mjs`); no camelCase split, no lowercasing. `Class.method`
 * splits into two independent terms (the dot is not in the character class). */
export function deriveRankerDTerms(query: string): string[] {
  return query.match(/[A-Za-z0-9_$]+/g) ?? [];
}

const DIGIT_ADJACENT_LETTER = /[0-9][A-Za-z]|[A-Za-z][0-9]/;

/**
 * Symbol-shaped eligibility predicate for ranker D's PRIMARY arm — reproduces
 * `isSymbolShapedTerm` (`eval/idfuse-ranker.mjs`) MINUS the dead
 * `term.includes('.')` clause (registration: "the implementation also tests
 * term.includes('.'), but the upstream split character class
 * `/[A-Za-z0-9_$]+/` never includes `.` in any surviving token ... Ranker D's
 * eligibility gate reproduces this predicate but drops the dead clause rather
 * than reimplementing dead code"). A term qualifies if it contains an
 * uppercase letter, an underscore, a dollar sign, or a digit adjacent to a
 * letter.
 */
export function isEligiblePrimaryTerm(term: string): boolean {
  return (
    /[A-Z]/.test(term) ||
    term.includes('_') ||
    term.includes('$') ||
    DIGIT_ADJACENT_LETTER.test(term)
  );
}

/** Ranker D's PRIMARY-arm eligible terms: raw split, filtered to symbol-shaped. */
export function deriveEligiblePrimaryTerms(query: string): string[] {
  return deriveRankerDTerms(query).filter(isEligiblePrimaryTerm);
}

// ---------------------------------------------------------------------------
// SQL match primitive — direct predicate against `chunks.symbol_name`
// ---------------------------------------------------------------------------

/** Escape `\`, `%`, `_` for a SQLite LIKE pattern (registration's segment
 * match is a STRUCTURAL suffix-after-dot comparison; a raw token containing
 * `_` — a legal, even common, eligible character per the split regex — would
 * otherwise be silently reinterpreted as a single-character LIKE wildcard,
 * producing false-positive segment matches. `ESCAPE '\'` in the query below
 * neutralises that.) */
function escapeLikeToken(token: string): string {
  return token.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** One `chunks` row reachable by a single eligible term, plus how it matched. */
interface ChunkMatchCandidate {
  readonly chunk_id: string;
  readonly symbol_name: string;
  readonly chunk_type: string;
  readonly parent_symbol: string | null;
  readonly match_type: 'full' | 'segment';
}

/**
 * Query `chunks` for every row whose `symbol_name` equals `token`
 * case-insensitively (full-name match) OR whose `symbol_name` ends with
 * `.` + `token` case-insensitively (segment match — the only chunk type with
 * a dot in `symbol_name` is `method`, `symbol_name = `${className}.${methodName}``,
 * `typescript.ts:324`; a chunk with no dot can only ever full-name-match, per
 * the registration's "no segment logic needed for class_shell").
 *
 * Full-name equality is a plain parameterized `=` (no wildcard risk). Segment
 * matching uses `LIKE` with the token pre-escaped (see `escapeLikeToken`) so
 * an underscore inside the token cannot masquerade as a wildcard.
 */
async function matchToken(db: Db, token: string): Promise<ChunkMatchCandidate[]> {
  const lower = token.toLowerCase();
  const likePattern = `%.${escapeLikeToken(lower)}`;

  const rows = await db
    .selectFrom('chunks')
    .select(['chunk_id', 'symbol_name', 'chunk_type', 'parent_symbol'])
    .where('symbol_name', 'is not', null)
    // NOTE: the doubled backslash below is JS template-literal escaping for a
    // SINGLE literal backslash in the resulting SQL text (`ESCAPE '\'`) — a
    // lone `\'` here would be parsed by JS as an escaped quote, silently
    // dropping the backslash and producing invalid SQL (`ESCAPE ''`).
    .where(sql<SqlBool>`(LOWER(symbol_name) = ${lower} OR LOWER(symbol_name) LIKE ${likePattern} ESCAPE '\\')`)
    .execute();

  // `WHERE symbol_name IS NOT NULL` guarantees no row here has a null
  // symbol_name, but Kysely's column type (`string | null`, per the schema)
  // does not narrow from a runtime predicate — filter with a type guard
  // rather than a non-null assertion (banned in product code, §3.1).
  return rows
    .filter((r): r is typeof r & { symbol_name: string } => r.symbol_name !== null)
    .map((r) => {
      const matchType: 'full' | 'segment' = r.symbol_name.toLowerCase() === lower ? 'full' : 'segment';
      return {
        chunk_id: r.chunk_id,
        symbol_name: r.symbol_name,
        chunk_type: r.chunk_type,
        parent_symbol: r.parent_symbol,
        match_type: matchType,
      };
    });
}

/** The final dot-segment of a symbol name (itself, if no dot present). */
function finalDotSegment(symbolName: string): string {
  const idx = symbolName.lastIndexOf('.');
  return idx === -1 ? symbolName : symbolName.slice(idx + 1);
}

// ---------------------------------------------------------------------------
// The ranker itself
// ---------------------------------------------------------------------------

export interface DeclexRow {
  readonly chunk_id: string;
  readonly symbol_name: string;
  readonly chunk_type: string;
  readonly match_type: 'full' | 'segment';
}

export interface DeclexDiagnostics {
  /** D produced >= 1 candidate. */
  readonly fired: boolean;
  /** The winning (first-ordered) candidate's match type, or null if D did not fire. */
  readonly top_match_channel: 'full' | 'segment' | null;
  /** Pre-cap candidate pool size. */
  readonly candidate_count: number;
  readonly primary_eligible_terms: readonly string[];
}

export interface DeclexSearchOptions {
  /** The FINAL SQL limit to apply (the caller's already-multiplied candidate
   * pool — same convention as ranker I / `searchVectors`; multiply by
   * {@link RANKER_D_POOL_MULTIPLIER} before calling). */
  readonly limit: number;
}

export interface DeclexSearchResult {
  readonly rows: DeclexRow[];
  readonly diagnostics: DeclexDiagnostics;
}

/**
 * Ranker D: declaration-exact match against `chunks.symbol_name` (full-name
 * or final-dot-segment), case-insensitive, deterministically ordered.
 *
 * Ordering (registration): full-name matches before segment-only matches;
 * then fewer total same-matched-name candidates first; then ascending
 * chunk_id. JUDGMENT CALL (flagged per this codebase's convention, e.g.
 * `eval/idfuse-score.mjs`'s a-fortiori routing note): "same-name" is read as
 * "same MATCHED name" — full-name candidates group by their own
 * `symbol_name`; segment candidates group by the shared final dot-segment
 * (the quantity the design review's F-4 finding is actually about — a
 * `toJSON`-class query facing ~140 candidates that all share the SEGMENT
 * "toJSON", not 140 candidates sharing one `symbol_name`, since each belongs
 * to a different class). This groups the exact multiplicity class the
 * registration's own fixture (Gate B, high-multiplicity segment) is built to
 * exercise.
 *
 * @param query - the RAW query string (term derivation happens here).
 */
export async function searchRankerD(
  db: Db,
  query: string,
  options: DeclexSearchOptions,
): Promise<DeclexSearchResult> {
  const rawTerms = deriveRankerDTerms(query);
  const primaryTerms = [...new Set(rawTerms.filter(isEligiblePrimaryTerm))];

  // matchesByTerm caches every matchToken() call so the final candidate
  // assembly never re-queries the same term twice.
  const matchesByTerm = new Map<string, ChunkMatchCandidate[]>();
  for (const t of primaryTerms) matchesByTerm.set(t, await matchToken(db, t));

  if (primaryTerms.length === 0) {
    return {
      rows: [],
      diagnostics: {
        fired: false,
        top_match_channel: null,
        candidate_count: 0,
        primary_eligible_terms: primaryTerms,
      },
    };
  }

  // Merge per-term matches into one candidate map keyed by chunk_id — a
  // chunk reachable via more than one eligible term is counted once. If any
  // matching term produced a 'full' hit for that chunk, 'full' wins (a chunk
  // can only structurally be a 'full' match for its OWN symbol_name and a
  // 'segment' match for its OWN symbol_name's final segment — these are the
  // same string only when the symbol_name has no dot, so this precedence
  // never silently discards information; it only resolves the case where two
  // DIFFERENT terms both matched the same chunk).
  const byChunkId = new Map<string, ChunkMatchCandidate>();
  for (const t of primaryTerms) {
    const matches = matchesByTerm.get(t) ?? [];
    for (const m of matches) {
      const existing = byChunkId.get(m.chunk_id);
      if (existing === undefined || (existing.match_type === 'segment' && m.match_type === 'full')) {
        byChunkId.set(m.chunk_id, m);
      }
    }
  }
  const candidates = [...byChunkId.values()];

  // Ordering: matchedName grouping (see JSDoc above) — count how many
  // candidates in THIS query's pool share the same (case-insensitive)
  // matched name, then sort full-before-segment, ascending count, ascending
  // chunk_id.
  const matchedNameOf = (c: ChunkMatchCandidate): string =>
    (c.match_type === 'full' ? c.symbol_name : finalDotSegment(c.symbol_name)).toLowerCase();
  const nameCounts = new Map<string, number>();
  for (const c of candidates) {
    const key = matchedNameOf(c);
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  candidates.sort((a, b) => {
    const typeRank = (c: ChunkMatchCandidate): number => (c.match_type === 'full' ? 0 : 1);
    if (typeRank(a) !== typeRank(b)) return typeRank(a) - typeRank(b);
    const countA = nameCounts.get(matchedNameOf(a)) ?? 0;
    const countB = nameCounts.get(matchedNameOf(b)) ?? 0;
    if (countA !== countB) return countA - countB;
    return a.chunk_id < b.chunk_id ? -1 : a.chunk_id > b.chunk_id ? 1 : 0;
  });

  const capped = candidates.slice(0, options.limit);
  const first = candidates[0];

  return {
    rows: capped.map((c) => ({
      chunk_id: c.chunk_id,
      symbol_name: c.symbol_name,
      chunk_type: c.chunk_type,
      match_type: c.match_type,
    })),
    diagnostics: {
      fired: candidates.length > 0,
      top_match_channel: first !== undefined ? first.match_type : null,
      candidate_count: candidates.length,
      primary_eligible_terms: primaryTerms,
    },
  };
}
