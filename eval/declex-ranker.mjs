// Q1/DECLEX — ranker D (IMPLEMENTATION_PLAN.md § "Q1/DECLEX — the
// declaration-exact ranker: PRE-REGISTRATION" + AMENDMENT 1, commit dd10796).
// BUILT AND UNIT-TESTED HERE (Gate B); NOT run over the frozen scored query
// set by this session (hard rule — see declex-rank-check.mjs's header for the
// measurement-phase boundary).
//
// Ranker D queries the `chunks` table DIRECTLY (not `chunk_fts`/`identifier_fts`):
// `chunk_fts.symbol_name` is stored UNINDEXED (`src/graph/db.ts:172-177`) — not
// reachable via FTS5 MATCH — and the registered match rule ("equals the chunk's
// own symbol_name OR its final dot-segment") is a structural string comparison,
// not a full-text match, so a direct SQL predicate against `chunks.symbol_name`
// is the correct primitive, not a repurposed FTS index.
//
// Term derivation (registration): raw-token split by `/[A-Za-z0-9_$]+/` — the
// SAME character class idfuse-ranker.mjs's `deriveRankerITerms` uses
// (`eval/idfuse-ranker.mjs:58-60`), reproduced here rather than imported so
// this file has no runtime dependency on a sibling instrument (both derive
// from the one registered regex; drift would be caught by either file's own
// tests).
//
// Eligibility gate (registration): `isSymbolShapedTerm` as actually
// implemented (`eval/idfuse-ranker.mjs:81-89`) MINUS the dead dot criterion —
// the registration's own words: "the implementation also tests
// term.includes('.'), but the upstream split character class
// `/[A-Za-z0-9_$]+/` never includes `.` in any surviving token ... Ranker D's
// eligibility gate reproduces this predicate but drops the dead clause rather
// than reimplementing dead code." `isSymbolShapedTerm` itself cannot be
// imported and reused verbatim (importing it would keep the dead clause,
// which is harmless but not what is registered here) — reproduced below with
// the clause dropped, referencing the source of truth by line number.

import { sql } from 'kysely';

/**
 * Ranker D's candidate pool multiplier — 4x the caller's own `limit`, the
 * SAME convention as ranker I (`idfuse-ranker.mjs:31-40`, AMENDMENT 1 F8) and
 * `searchVectors`: the caller multiplies by 4 and passes the already-
 * multiplied limit directly; `searchRankerD` applies no further internal
 * multiplication.
 */
export const RANKER_D_POOL_MULTIPLIER = 4;

/** The escape variant's default lowercase-token declaration-match cap
 * (registration: "IFF their declaration-match count within the tier is ≤ 20").
 * Parameterized on `searchRankerD`'s `escapeCap` option for the {5, 20, 50}
 * sensitivity sweep (AMENDMENT 1, F-8 — annotated there as "arbitrary,
 * sensitivity-reported"). */
export const DEFAULT_ESCAPE_CAP = 20;

// ---------------------------------------------------------------------------
// Term derivation + eligibility gate (pure, no DB)
// ---------------------------------------------------------------------------

/** Raw token split — identical character class to ranker I's own derivation
 * (`idfuse-ranker.mjs:58-60`); no camelCase split, no lowercasing. `Class.method`
 * splits into two independent terms (the dot is not in the character class). */
export function deriveRankerDTerms(query) {
  return query.match(/[A-Za-z0-9_$]+/g) ?? [];
}

const DIGIT_ADJACENT_LETTER = /[0-9][A-Za-z]|[A-Za-z][0-9]/;

/**
 * Symbol-shaped eligibility predicate for ranker D's PRIMARY arm — reproduces
 * `isSymbolShapedTerm` (`eval/idfuse-ranker.mjs:81-89`) MINUS the dead
 * `term.includes('.')` clause (registration, see this file's header). A term
 * qualifies if it contains an uppercase letter, an underscore, a dollar sign,
 * or a digit adjacent to a letter.
 */
export function isEligiblePrimaryTerm(term) {
  return (
    /[A-Z]/.test(term) ||
    term.includes('_') ||
    term.includes('$') ||
    DIGIT_ADJACENT_LETTER.test(term)
  );
}

/** Ranker D's PRIMARY-arm eligible terms: raw split, filtered to symbol-shaped. */
export function deriveEligiblePrimaryTerms(query) {
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
function escapeLikeToken(token) {
  return token.replace(/[\\%_]/g, (c) => `\\${c}`);
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
 *
 * @returns {Promise<Array<{chunk_id, symbol_name, chunk_type, parent_symbol, match_type: 'full'|'segment'}>>}
 */
async function matchToken(db, token) {
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
    .where(sql`(LOWER(symbol_name) = ${lower} OR LOWER(symbol_name) LIKE ${likePattern} ESCAPE '\\')`)
    .execute();

  return rows.map((r) => ({
    ...r,
    match_type: r.symbol_name.toLowerCase() === lower ? 'full' : 'segment',
  }));
}

/** The final dot-segment of a symbol name (itself, if no dot present). */
function finalDotSegment(symbolName) {
  const idx = symbolName.lastIndexOf('.');
  return idx === -1 ? symbolName : symbolName.slice(idx + 1);
}

// ---------------------------------------------------------------------------
// The ranker itself
// ---------------------------------------------------------------------------

/**
 * @typedef {object} RankerDRow
 * @property {string} chunk_id
 * @property {string} symbol_name
 * @property {string} chunk_type
 * @property {'full'|'segment'} match_type
 */

/**
 * @typedef {object} RankerDDiagnostics
 * @property {boolean} fired - D produced >= 1 candidate.
 * @property {'full'|'segment'|null} top_match_channel - the winning (first-
 *   ordered) candidate's match type, or null if D did not fire.
 * @property {number} candidate_count - pre-cap candidate pool size.
 * @property {string[]} primary_eligible_terms
 * @property {string[]|undefined} escape_eligible_terms - escape mode only.
 * @property {Record<string, number>|undefined} lowercase_token_match_counts -
 *   escape mode only: every lowercase (primary-ineligible) raw term's
 *   declaration-match count, INCLUDING those that exceeded the cap
 *   (AMENDMENT 1, F-8 — "the scorer publishes the matched-count distribution
 *   for all lowercase tokens considered under escape").
 */

/**
 * Ranker D: declaration-exact match against `chunks.symbol_name` (full-name
 * or final-dot-segment), case-insensitive, deterministically ordered.
 *
 * Ordering (registration): full-name matches before segment-only matches;
 * then fewer total same-matched-name candidates first; then ascending
 * chunk_id. JUDGMENT CALL (flagged per this codebase's convention, e.g.
 * `idfuse-score.mjs`'s a-fortiori routing note): "same-name" is read as "same
 * MATCHED name" — full-name candidates group by their own `symbol_name`;
 * segment candidates group by the shared final dot-segment (the quantity the
 * design review's F-4 finding is actually about — a `toJSON`-class query
 * facing ~140 candidates that all share the SEGMENT "toJSON", not 140
 * candidates sharing one `symbol_name`, since each belongs to a different
 * class). This groups the exact multiplicity class the registration's own
 * fixture (Gate B, high-multiplicity segment) is built to exercise.
 *
 * @param {import('kysely').Kysely<any>} db
 * @param {string} query - the RAW query string (term derivation happens here).
 * @param {object} options
 * @param {number} options.limit - the FINAL SQL limit to apply (the caller's
 *   already-multiplied candidate pool — same convention as ranker I / `searchVectors`).
 * @param {boolean} [options.escape=false] - the descriptive-only lowercase-
 *   escape sensitivity arm (D+esc).
 * @param {number} [options.escapeCap=DEFAULT_ESCAPE_CAP] - the escape arm's
 *   declaration-match-count cap, parameterized for the {5,20,50} sweep.
 * @returns {Promise<{rows: RankerDRow[], diagnostics: RankerDDiagnostics}>}
 */
export async function searchRankerD(db, query, { limit, escape = false, escapeCap = DEFAULT_ESCAPE_CAP } = {}) {
  const rawTerms = deriveRankerDTerms(query);
  const primaryTerms = [...new Set(rawTerms.filter(isEligiblePrimaryTerm))];
  const lowercaseTerms = [...new Set(rawTerms.filter((t) => !isEligiblePrimaryTerm(t)))];

  // matchesByTerm caches every matchToken() call so escape-mode's cap decision
  // and the final candidate assembly never re-query the same term twice.
  const matchesByTerm = new Map();
  for (const t of primaryTerms) matchesByTerm.set(t, await matchToken(db, t));

  let escapeEligibleTerms;
  let lowercaseTokenMatchCounts;
  if (escape) {
    escapeEligibleTerms = [];
    lowercaseTokenMatchCounts = {};
    for (const t of lowercaseTerms) {
      const matches = await matchToken(db, t);
      matchesByTerm.set(t, matches);
      lowercaseTokenMatchCounts[t] = matches.length;
      if (matches.length <= escapeCap) escapeEligibleTerms.push(t);
    }
  }

  const finalTerms = escape ? [...primaryTerms, ...escapeEligibleTerms] : primaryTerms;

  if (finalTerms.length === 0) {
    return {
      rows: [],
      diagnostics: {
        fired: false, top_match_channel: null, candidate_count: 0,
        primary_eligible_terms: primaryTerms,
        ...(escape ? { escape_eligible_terms: escapeEligibleTerms, lowercase_token_match_counts: lowercaseTokenMatchCounts } : {}),
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
  const byChunkId = new Map();
  for (const t of finalTerms) {
    for (const m of matchesByTerm.get(t)) {
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
  const matchedNameOf = (c) => (c.match_type === 'full' ? c.symbol_name : finalDotSegment(c.symbol_name)).toLowerCase();
  const nameCounts = new Map();
  for (const c of candidates) {
    const key = matchedNameOf(c);
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  candidates.sort((a, b) => {
    const typeRank = (c) => (c.match_type === 'full' ? 0 : 1);
    if (typeRank(a) !== typeRank(b)) return typeRank(a) - typeRank(b);
    const countA = nameCounts.get(matchedNameOf(a));
    const countB = nameCounts.get(matchedNameOf(b));
    if (countA !== countB) return countA - countB;
    return a.chunk_id < b.chunk_id ? -1 : a.chunk_id > b.chunk_id ? 1 : 0;
  });

  const capped = candidates.slice(0, limit);

  return {
    rows: capped.map((c) => ({ chunk_id: c.chunk_id, symbol_name: c.symbol_name, chunk_type: c.chunk_type, match_type: c.match_type })),
    diagnostics: {
      fired: candidates.length > 0,
      top_match_channel: candidates.length > 0 ? candidates[0].match_type : null,
      candidate_count: candidates.length,
      primary_eligible_terms: primaryTerms,
      ...(escape ? { escape_eligible_terms: escapeEligibleTerms, lowercase_token_match_counts: lowercaseTokenMatchCounts } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Per-query target-reach classification — shared by Gate F's mechanical
// anchor-rate computation (declex-build-queries.mjs, structural, no DB search)
// and the wrapper's per-query diagnostic (declex-rank-check.mjs, empirical,
// against D's actual returned rows). Pure function, no DB/search of its own.
// ---------------------------------------------------------------------------

/**
 * Classifies HOW (if at all) ranker D's returned `rows` reach `target`, under
 * the SAME three channels the design review's anchor-rate figures use:
 * full-name (D returned the target's own chunk via a 'full' match), segment
 * (D returned the target's own chunk via a 'segment' match), and
 * shell-counterpart (D returned the target's parent class_shell chunk via a
 * 'full' match — reachable only for `method` targets; the shell's existence
 * in `rows` is what the shipped hit-rule's `isCounterpart` would credit,
 * `scale-rank-check.mjs:92-101`).
 *
 * @param {RankerDRow[]} rows
 * @param {{chunk_id: string, chunk_type: string, parent_symbol: string|null}} target
 */
export function classifyTargetReach(rows, target) {
  const own = rows.find((r) => r.chunk_id === target.chunk_id);
  const fullName = own !== undefined && own.match_type === 'full';
  const segment = own !== undefined && own.match_type === 'segment';

  let shellCounterpart = false;
  if (target.chunk_type === 'method' && target.parent_symbol !== null) {
    shellCounterpart = rows.some((r) => r.chunk_type === 'class_shell' && r.match_type === 'full' && r.symbol_name.toLowerCase() === target.parent_symbol.toLowerCase());
  }

  return {
    full_name: fullName, segment, shell_counterpart: shellCounterpart,
    any: fullName || segment || shellCounterpart,
  };
}
