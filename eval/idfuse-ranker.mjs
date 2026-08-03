// Q1/IDFUSE — ranker I (IMPLEMENTATION_PLAN.md § "Q1/IDFUSE ... PRE-REGISTRATION
// + AMENDMENT 1", commit bed7d48). BUILT AND UNIT-TESTED HERE (Gate B); NOT run
// over the frozen scored query set by this session (hard rule — see
// idfuse-rank-check.mjs's header for the measurement-phase boundary).
//
// Ranker I adds ONE new, explicitly-ordered query over the shipped
// `identifier_fts` FTS5 table (unicode61, `src/graph/db.ts:287-292` —
// unchanged, no schema/tokenizer edit): the same term-derivation +
// match-expression-building pattern already shipped for the near-miss assist
// (`searchIdentifierNearMiss`, `src/search/fts.ts:140-154`), plus an explicit
// `ORDER BY bm25(identifier_fts) ASC` neither shipped identifier_fts function
// has (`searchIdentifiers`/`searchIdentifierNearMiss` both rely on FTS5's
// default rowid order — safe at their own call sites, wrong for an RRF input).
//
// Term derivation (AMENDMENT 1, F1 — registered explicitly after the design
// review found the "natural" path, `splitIdentifierTerms`, is structurally
// inert on the S-ident anchor): a token split of the RAW query by
// `/[A-Za-z0-9_$]+/` — the same character class `extractIdentifiers`
// (`src/ast/extractors/typescript.ts:1430-1438`) indexes against — with NO
// camelCase splitting and NO lowercasing. `identifier_fts`'s unicode61
// tokenizer case-folds AT MATCH TIME, so an unlowercased query token still
// matches a lowercased indexed token; the indexed token is never sub-split, so
// feeding it a camelCase-split term (the `splitIdentifierTerms` path) could
// never match. See IMPLEMENTATION_PLAN.md:3038-3073 for the full "why not the
// two other natural candidates" argument (F1) this derivation is pinned by.

import { sql } from 'kysely';

/**
 * Ranker I's candidate pool multiplier — 4x the caller's own `limit`,
 * matching `searchVectors`'s pool convention (AMENDMENT 1, F8): the
 * registration corrects the original draft's claim of a uniform "4x per
 * ranker" pool — `chunk_fts` is actually 8x by shipped code
 * (`hybrid.ts:59` candidateLimit=limit*4, then `fts.ts:92` limit*2), while
 * `searchVectors` and ranker I both take the caller's already-multiplied
 * `candidateLimit` directly with no further internal multiplication.
 * Exported so the wrapper (idfuse-rank-check.mjs) and its tests share one
 * source of truth for the multiplier instead of hardcoding `4` twice.
 */
export const RANKER_I_POOL_MULTIPLIER = 4;

// ---------------------------------------------------------------------------
// Term derivation (F1 — registered, mechanical, no camelCase split / no lowercase)
// ---------------------------------------------------------------------------

/**
 * Split the RAW query into ranker-I input terms: a token-split by
 * `/[A-Za-z0-9_$]+/`, no camelCase splitting, no lowercasing, no length floor
 * (unlike `chunk_fts`'s trigram 3-char minimum, `identifier_fts` has no such
 * floor to respect — registration, IMPLEMENTATION_PLAN.md:3048-3049).
 *
 * `Class.method` splits into two independently OR-matchable terms (the dot is
 * not in the character class, so it acts as a separator exactly as it does
 * inside `identifier_fts`'s own tokenizer's separator set); camelCase
 * identifiers are left whole, matching the unsplit indexed token under
 * unicode61's match-time case-folding.
 */
export function deriveRankerITerms(query) {
  return query.match(/[A-Za-z0-9_$]+/g) ?? [];
}

/**
 * Symbol-shaped predicate for the descriptive-only L+Isym sensitivity arm
 * (AMENDMENT 1, F7): a term qualifies if it contains an uppercase letter, an
 * underscore, a dollar sign, a dot, or a digit adjacent to a letter — applied
 * AFTER the `/[A-Za-z0-9_$]+/` split, per the registered mechanical
 * definition (IMPLEMENTATION_PLAN.md:3122-3126).
 *
 * JUDGMENT CALL (flagged in the delivery report, not silently absorbed): the
 * registration's own criterion list includes "contains a dot," but the split
 * above uses `.` as a separator character — it is never part of the class
 * `/[A-Za-z0-9_$]+/` matches, so no post-split term can ever contain a
 * literal `.`. That criterion is therefore dead code by construction. It is
 * implemented verbatim anyway (never triggers, never excludes) because L+Isym
 * is descriptive-only (never verdict-bearing) and the registration's own text
 * is binding; silently dropping a registered-but-vacuous clause would still
 * be an unregistered deviation. See the delivery report for the full note.
 */
const DIGIT_ADJACENT_LETTER = /[0-9][A-Za-z]|[A-Za-z][0-9]/;

export function isSymbolShapedTerm(term) {
  return (
    /[A-Z]/.test(term) ||
    term.includes('_') ||
    term.includes('$') ||
    term.includes('.') || // registered criterion; dead post-split, see JSDoc above
    DIGIT_ADJACENT_LETTER.test(term)
  );
}

/** Ranker I's terms, filtered to the symbol-shaped subset (L+Isym arm only). */
export function deriveSymbolOnlyTerms(query) {
  return deriveRankerITerms(query).filter(isSymbolShapedTerm);
}

// ---------------------------------------------------------------------------
// Match-expression builder — SAME semantics as searchIdentifierNearMiss
// ---------------------------------------------------------------------------

/**
 * Build an FTS5 MATCH expression: each term phrase-quoted
 * (`"${term.replace(/"/g, '""')}"`), OR-joined. Returns `null` for an empty
 * term list so the caller can short-circuit to "no query issued, contributes
 * nothing to RRF" (registration's explicit empty-match rule).
 *
 * PROVENANCE: this is the identical phrase-quote + OR-join expression built
 * inline inside `searchIdentifierNearMiss` (`src/search/fts.ts:140-154`,
 * expression itself at line 147: ``cleaned.map((t) => `"${t.replace(/"/g,
 * '""')}"`).join(' OR ')``). It is REPLICATED here, not imported, because
 * `searchIdentifierNearMiss` bundles this expression-building step together
 * with an un-ordered `.limit(n).execute()` call (no `ORDER BY bm25(...)`) and
 * does not export the expression-builder as a separable function — ranker I
 * needs the same expression but with the registered explicit BM25 ordering
 * neither shipped identifier_fts function has. No behavioural difference from
 * the shipped builder for the OR-join step itself.
 */
export function buildOrMatchExpression(terms) {
  const cleaned = terms.map((t) => t.trim()).filter((t) => t.length > 0);
  if (cleaned.length === 0) return null;
  return cleaned.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

// ---------------------------------------------------------------------------
// The ranker itself
// ---------------------------------------------------------------------------

/**
 * @typedef {object} RankerIRow
 * @property {string} chunk_id
 * @property {number} bm25_score
 */

/**
 * Ranker I: BM25-ordered search over `identifier_fts`.
 *
 * @param {import('kysely').Kysely<any>} db
 * @param {string} query - the RAW query string (term derivation happens here).
 * @param {object} options
 * @param {number} options.limit - the FINAL SQL limit to apply (the caller's
 *   already-multiplied candidate pool — same convention as `searchVectors`,
 *   which also takes its caller's pre-multiplied `candidateLimit` directly
 *   with no further internal multiplication). Callers wanting the registered
 *   "4x limit" pool pass `limit * RANKER_I_POOL_MULTIPLIER`.
 * @param {boolean} [options.symbolOnly=false] - L+Isym sensitivity arm: feed
 *   only the symbol-shaped terms (F7).
 * @returns {Promise<RankerIRow[]>} empty array for an empty/no-match term set
 *   (contributes nothing to RRF), per the registration.
 */
export async function searchRankerI(db, query, { limit, symbolOnly = false } = {}) {
  const terms = symbolOnly ? deriveSymbolOnlyTerms(query) : deriveRankerITerms(query);
  const matchExpr = buildOrMatchExpression(terms);
  if (matchExpr === null) return [];

  return db
    .selectFrom('identifier_fts')
    .select(['chunk_id', sql`bm25(identifier_fts)`.as('bm25_score')])
    .where(sql`identifier_fts MATCH ${matchExpr}`)
    .orderBy(sql`bm25(identifier_fts)`, 'asc')
    .limit(limit)
    .execute();
}
