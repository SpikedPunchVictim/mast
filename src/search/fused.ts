import type { SearchInput, SearchResult, SearchSuggestion, RelatedHint, ChunkType } from '../ast/types.js';
import type { Db } from '../graph/db.js';
import type { ChunkStore, ChunkRecord } from '../store/sqliteChunkStore.js';
import { searchFts, searchIdentifierNearMiss, splitIdentifierTerms } from './fts.js';
import { querySymbolsBySimilarity } from '../graph/queries.js';
import { searchRankerD, type DeclexDiagnostics } from './declex.js';
import { resolveScopedPaths, type SearchScope } from './scope.js';

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion helpers
// ---------------------------------------------------------------------------

/**
 * RRF score for a document at rank `r` (1-indexed) with fusion constant `k`.
 *
 * Standard formula: Score(d) = Σ 1/(k + r(d)) over all rankers.
 * The default k=60 dampens rank differences — a #1 vs #2 gap matters less
 * than the absolute score gap would suggest.
 */
export function rrfScore(rank: number, k: number): number {
  return 1 / (k + rank);
}

export interface FusedSearchConfig {
  readonly rrf_k: number;
  /**
   * F18 kill-switch (M2 decision memo condition 3) — fuses ranker D
   * (declaration-exact, `./declex.ts`) into RRF as a third input. OPTIONAL,
   * and absent means OFF: the eval instruments (`eval/*-rank-check.mjs`,
   * frozen at the `mast-pre-vector-delete` tag per IMPLEMENTATION_PLAN.md
   * Stage 7) call this function directly to reconstruct measured experiment
   * arms, so a function-level default-on would silently contaminate future
   * instrument re-runs against a config shape they never asked for. The
   * product's default-on lives in `MastConfig` DEFAULTS (`store/config.ts`) —
   * the config layer a kill-switch belongs to, not the function signature
   * every caller (including eval) shares.
   */
  readonly declaration_exact_ranker?: boolean;
}

// ---------------------------------------------------------------------------
// D-fire telemetry (Stage 6.3, M2 decision memo condition 3)
//
// The input signal for the F18 kill-switch and re-entry criteria: when
// ranker D fires on a `mast_search` call, what did it actually do to the
// fused ranking? Types live here (not declex.ts) because `window_effects` is
// a property of the FUSION, not of ranker D itself — it compares the shipped
// with-D result against an in-memory reconstruction of what RRF would have
// produced without D, which only `fusedSearch` has enough context to build.
// ---------------------------------------------------------------------------

/**
 * One chunk whose fused rank differs between the shipped (with-D) ranking
 * and the reconstructed without-D ranking.
 *
 * `rank_with_d`/`rank_without_d` are the ACTUAL 1-based fused rank in each
 * list — not `null` for a merely-displaced-out-of-window entry. `null` is
 * reserved for genuine absence from that list (a D-only chunk has no
 * `rank_without_d` because it never entered the without-D candidate pool at
 * all). This is a deliberate refinement of IMPLEMENTATION_PLAN.md Stage 6
 * design decision 4, which sketched reporting `null` for anything pushed out
 * of the window — the shipped contract is strictly more informative;
 * consumers who want window semantics compare the reported rank against
 * `limit` themselves.
 */
export interface DeclexWindowEffect {
  readonly chunk_id: string;
  /** From the already-fetched chunk records; `null` when the id fell outside the fetched candidate pool entirely. */
  readonly symbol_name: string | null;
  readonly rank_with_d: number | null;
  readonly rank_without_d: number | null;
}

/**
 * D-fire telemetry attached to `fusedSearch`'s return, present ONLY when
 * ranker D actually fired (`fired` is always `true` here by construction —
 * the field itself is omitted, not set to `{fired: false}`, when D was
 * silent or the flag was off).
 */
export interface DeclexTelemetry {
  readonly fired: true;
  readonly top_match_channel: DeclexDiagnostics['top_match_channel'];
  readonly candidate_count: number;
  readonly window_effects: readonly DeclexWindowEffect[];
}

// ---------------------------------------------------------------------------
// Fused search
// ---------------------------------------------------------------------------

/**
 * BM25 lexical search fused with ranker D (declaration-exact, `./declex.ts`)
 * via Reciprocal Rank Fusion.
 *
 * Stage 7 (IMPLEMENTATION_PLAN.md "Stage 7: Vector-store deletion") excised
 * the vector leg entirely — `mast_search` is FTS + ranker D only now, and
 * Stage 7.2 renamed this function (decision 4): its old name asserted a
 * vector-plus-lexical fusion that no longer exists. The response no longer
 * carries a search-mode discriminator or a per-result similarity score —
 * both described the retired vector leg and have no honest value to report
 * now that it's gone.
 *
 * Post-filters (`chunk_type`, `only_exported`) are applied after RRF ranking,
 * on the full chunk records fetched from `chunkStore`.
 *
 * The scope filters (`file_pattern`, `language`) are NOT post-filters: each
 * ranker applies them to its own candidate pool, through the shared
 * `./scope.ts`, before that pool is capped. Applying them here instead would
 * spend each ranker's candidate budget on rows about to be discarded. Anything
 * later fused into this function must be scoped the same way — the union below
 * is what carries a leak into the result set, and `__tests__/search-scope.test.ts`
 * asserts the union, not the individual legs, for exactly that reason.
 */
export async function fusedSearch(
  db: Db,
  input: SearchInput,
  config: FusedSearchConfig,
  // Required (Stage 7.1): retires two recorded defects — the retired-Lance
  // default and the swallowed embedder failure that used to live in this
  // function's now-deleted vector-search try/catch (HANDOFF_Q1.md §5).
  chunkStore: ChunkStore,
): Promise<{
  results: SearchResult[];
  suggestions?: SearchSuggestion[];
  /** Present only when ranker D fired — Stage 6.3 telemetry, see {@link DeclexTelemetry}. */
  declex?: DeclexTelemetry;
}> {
  const limit = input.limit ?? 10;
  // Over-fetch so post-filters don't starve the final result set.
  const candidateLimit = limit * 4;

  // One scope, handed to every ranker — see this function's doc.
  const scope: SearchScope = { filePattern: input.file_pattern, language: input.language };

  // --- BM25 ---
  const ftsRows = await searchFts(db, input.query, {
    limit: candidateLimit,
    filePattern: scope.filePattern,
    language: scope.language,
  });

  // Build rank + metadata maps for RRF.
  const ftsMap = new Map<string, { rank: number; bm25Score: number; snippet: string }>();
  ftsRows.forEach((r, i) => {
    ftsMap.set(r.chunk_id, { rank: i + 1, bm25Score: r.bm25_score, snippet: r.match_snippet });
  });

  // --- Ranker D (declaration-exact) ---
  // Gated on `=== true` (not truthiness) so `undefined` and `false` behave
  // identically — the absent-means-OFF contract `FusedSearchConfig`
  // documents above. `declex` is kept as the full result (not just its rows)
  // so a later telemetry stage can lift its diagnostics into the return value
  // without re-plumbing this call.
  const dMap = new Map<string, number>();
  // Lifted out of the `if` block (rather than left local) so the telemetry
  // block below can read `top_match_channel`/`candidate_count` without
  // re-running `searchRankerD` — see this function's return-type doc.
  let declexDiagnostics: DeclexDiagnostics | undefined;
  if (config.declaration_exact_ranker === true) {
    const declex = await searchRankerD(db, input.query, { limit: candidateLimit, scope });
    declex.rows.forEach((r, i) => {
      dMap.set(r.chunk_id, i + 1);
    });
    declexDiagnostics = declex.diagnostics;
  }

  // --- RRF fusion ---
  const allIds = new Set([...ftsMap.keys(), ...dMap.keys()]);

  const scored: Array<{ chunk_id: string; rrf: number }> = [];
  for (const id of allIds) {
    let rrf = 0;
    const ftsMeta = ftsMap.get(id);
    const dRank = dMap.get(id);
    if (ftsMeta !== undefined) rrf += rrfScore(ftsMeta.rank, config.rrf_k);
    if (dRank !== undefined) rrf += rrfScore(dRank, config.rrf_k);
    scored.push({ chunk_id: id, rrf });
  }
  scored.sort((a, b) => b.rrf - a.rrf);

  // --- Fetch chunk data and apply post-filters ---
  const topIds = scored.slice(0, candidateLimit).map((s) => s.chunk_id);
  const chunkRecords = await chunkStore.getChunksByIds(topIds);

  // --- Ranker D dual-fusion diff (Stage 6.3 D-fire telemetry) ---
  // Pure in-memory arithmetic over the already-fetched ftsMap list — no
  // second FTS/D query, no second chunk fetch. Reconstructs the RRF sum RRF
  // would have produced with D excluded entirely (not merely zero-scored — a
  // D-only id has no rank without D, so it cannot appear in this list at
  // all), to isolate exactly what D changed. Computed against `chunkRecords`
  // (PRE-dedup, PRE-post-filter) per this feature's contract — the fused rank
  // a consumer sees is the presentation-independent one.
  let declexTelemetry: DeclexTelemetry | undefined;
  if (dMap.size > 0 && declexDiagnostics !== undefined) {
    const idsWithoutD = new Set([...ftsMap.keys()]);
    const scoredWithoutD: Array<{ chunk_id: string; rrf: number }> = [];
    for (const id of idsWithoutD) {
      let rrf = 0;
      const ftsMeta = ftsMap.get(id);
      if (ftsMeta !== undefined) rrf += rrfScore(ftsMeta.rank, config.rrf_k);
      scoredWithoutD.push({ chunk_id: id, rrf });
    }
    scoredWithoutD.sort((a, b) => b.rrf - a.rrf);

    const rankWithD = new Map(scored.map((s, i) => [s.chunk_id, i + 1]));
    const rankWithoutD = new Map(scoredWithoutD.map((s, i) => [s.chunk_id, i + 1]));
    const symbolNameOf = new Map(chunkRecords.map((c) => [c.chunk_id, c.symbol_name]));

    // Union of both lists' top-`limit` ids — the window a consumer actually
    // sees, from either side of the diff.
    const unionIds = new Set([
      ...scored.slice(0, limit).map((s) => s.chunk_id),
      ...scoredWithoutD.slice(0, limit).map((s) => s.chunk_id),
    ]);

    const windowEffects: DeclexWindowEffect[] = [];
    for (const id of unionIds) {
      const rankWith = rankWithD.get(id) ?? null;
      const rankWithout = rankWithoutD.get(id) ?? null;
      if (rankWith === rankWithout) continue; // unaffected by D — not an "effect"
      windowEffects.push({
        chunk_id: id,
        symbol_name: symbolNameOf.get(id) ?? null,
        rank_with_d: rankWith,
        rank_without_d: rankWithout,
      });
    }
    // Ascending rank_with_d, nulls last, ascending chunk_id tie-break — determinism.
    windowEffects.sort((a, b) => {
      if (a.rank_with_d === null && b.rank_with_d === null) {
        return a.chunk_id < b.chunk_id ? -1 : a.chunk_id > b.chunk_id ? 1 : 0;
      }
      if (a.rank_with_d === null) return 1;
      if (b.rank_with_d === null) return -1;
      if (a.rank_with_d !== b.rank_with_d) return a.rank_with_d - b.rank_with_d;
      return a.chunk_id < b.chunk_id ? -1 : a.chunk_id > b.chunk_id ? 1 : 0;
    });

    declexTelemetry = {
      fired: true,
      top_match_channel: declexDiagnostics.top_match_channel,
      candidate_count: declexDiagnostics.candidate_count,
      window_effects: windowEffects,
    };
  }

  const filtered = chunkRecords.filter((c) => {
    if (input.chunk_type != null && c.chunk_type !== input.chunk_type) return false;
    if (input.only_exported === true && !c.is_exported) return false;
    return true;
  });

  // Re-sort filtered chunks by their RRF score (getChunksByIds order is arbitrary).
  const rrfByChunkId = new Map(scored.map((s) => [s.chunk_id, s.rrf]));
  filtered.sort((a, b) => (rrfByChunkId.get(b.chunk_id) ?? 0) - (rrfByChunkId.get(a.chunk_id) ?? 0));

  // Post-RRF presentation pass (§9 mast_search): a method chunk and its class
  // shell repeat the same signature, so when both land in the window only the
  // higher-ranked one is returned, with a hint at the suppressed counterpart.
  // Ranking math is untouched; freed slots backfill from the RRF tail.
  const deduped = dedupShellMethodCollisions(filtered, limit);

  const results: SearchResult[] = deduped.map(({ chunk: c, related }, i) => {
    const ftsMeta = ftsMap.get(c.chunk_id);
    return {
      file_path:      c.file_path,
      start_line:     c.start_line,
      end_line:       c.end_line,
      content:        c.content,
      chunk_type:     c.chunk_type as ChunkType,
      symbol_name:    c.symbol_name,
      parent_symbol:  c.parent_symbol,
      is_exported:    c.is_exported,
      match_score:    ftsMeta?.bm25Score ?? null,
      // Re-ranked after dedup so consumers keep contiguous ranks from 1.
      rank:           i + 1,
      match_snippet:  ftsMeta?.snippet ?? null,
      ...(related !== undefined ? { related } : {}),
    };
  });

  // Zero-result assist: when nothing survived (no FTS/D hit, or filters
  // emptied the set), gather advisory "did you mean" candidates instead of
  // returning a bare dead end (§9 mast_search). Suggestions never become
  // results — the caller keeps `results: []`.
  const declexField = declexTelemetry !== undefined ? { declex: declexTelemetry } : {};

  if (results.length === 0) {
    const suggestions = await gatherSuggestions(db, chunkStore, input.query, limit, scope);
    return { results, suggestions, ...declexField };
  }

  return { results, ...declexField };
}

// ---------------------------------------------------------------------------
// Shell/method dedup (presentation only — §9 mast_search)
// ---------------------------------------------------------------------------

interface KeptEntry {
  readonly chunk: ChunkRecord;
  /** Set when this method's class shell was suppressed below it. */
  parentSymbolHint?: string;
  /** Set when this shell's method chunks were suppressed below it. */
  methodsMatched?: string[];
}

/**
 * Walk RRF-ranked candidates and keep up to `limit`, suppressing the
 * lower-ranked half of every shell↔method pair from the same class:
 *
 * - a `class_shell` is dropped when any method of that class is already kept —
 *   the `{ parent_symbol }` hint lands on the highest-ranked such method;
 * - a `method` is dropped when its class's shell is already kept — its
 *   qualified name is appended to the shell's `{ methods_matched }` hint;
 * - methods never suppress each other, and classes are matched by
 *   file_path + class name so same-named classes in different files
 *   never collapse.
 *
 * Suppression frees slots, so later candidates backfill until `limit` distinct
 * results are kept. Purely presentational — RRF scores are not modified.
 */
export function dedupShellMethodCollisions(
  candidates: readonly ChunkRecord[],
  limit: number,
): Array<{ chunk: ChunkRecord; related: RelatedHint | undefined }> {
  const kept: KeptEntry[] = [];
  const keptShellByClass = new Map<string, KeptEntry>();
  const firstKeptMethodByClass = new Map<string, KeptEntry>();
  // NUL never appears in paths or identifiers, so the key cannot collide.
  const classKey = (filePath: string, className: string): string => `${filePath}\u0000${className}`;

  for (const c of candidates) {
    if (kept.length >= limit) break;

    if (c.chunk_type === 'class_shell' && c.symbol_name !== null) {
      const key = classKey(c.file_path, c.symbol_name);
      const method = firstKeptMethodByClass.get(key);
      if (method !== undefined) {
        method.parentSymbolHint = c.symbol_name;
        continue;
      }
      const entry: KeptEntry = { chunk: c };
      kept.push(entry);
      // First shell claims the class slot (split shells share the key).
      if (!keptShellByClass.has(key)) keptShellByClass.set(key, entry);
      continue;
    }

    if (c.chunk_type === 'method' && c.parent_symbol !== null) {
      const key = classKey(c.file_path, c.parent_symbol);
      const shell = keptShellByClass.get(key);
      if (shell !== undefined) {
        if (c.symbol_name !== null) {
          (shell.methodsMatched ??= []).push(c.symbol_name);
        }
        continue;
      }
      const entry: KeptEntry = { chunk: c };
      kept.push(entry);
      if (!firstKeptMethodByClass.has(key)) firstKeptMethodByClass.set(key, entry);
      continue;
    }

    kept.push({ chunk: c });
  }

  return kept.map((k) => ({
    chunk: k.chunk,
    related:
      k.methodsMatched !== undefined ? { methods_matched: k.methodsMatched }
      : k.parentSymbolHint !== undefined ? { parent_symbol: k.parentSymbolHint }
      : undefined,
  }));
}

// ---------------------------------------------------------------------------
// Zero-result assist
// ---------------------------------------------------------------------------

/**
 * Build advisory suggestions for a query that returned no results, from three
 * complementary passes:
 *   (a) trigram similarity against the `symbols` table ("did you mean"),
 *   (b) an FTS retry over camelCase/snake_case-split query terms,
 *   (c) an `identifier_fts` near-miss over the same split terms.
 * Results are de-duplicated by (symbol, file) and capped at `limit`.
 *
 * All three passes honour the caller's `scope`. A suggestion naming a file the
 * caller excluded is the same misleading answer a *result* naming it would be —
 * advisory or not, it points at code outside the boundary the caller asked
 * about. Only pass (b) can take the filters natively; (a) and (c) return just a
 * symbol and a path, so the scope is enforced in `add`, the one funnel all
 * three go through.
 */
async function gatherSuggestions(
  db: Db,
  chunkStore: ChunkStore,
  query: string,
  limit: number,
  scope: SearchScope,
): Promise<SearchSuggestion[]> {
  const scopedList = await resolveScopedPaths(db, scope);
  const scopedPaths = scopedList === null ? null : new Set(scopedList);
  const out: SearchSuggestion[] = [];
  const seen = new Set<string>();
  const add = (symbol: string | null, filePath: string, reason: string): void => {
    if (symbol === null || out.length >= limit) return;
    if (scopedPaths !== null && !scopedPaths.has(filePath)) return;
    const key = `${symbol}\u0000${filePath}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ symbol, file_path: filePath, reason });
  };

  // (a) Trigram-similar symbol names — the highest-signal "did you mean".
  const similar = await querySymbolsBySimilarity(db, query, limit);
  for (const s of similar) add(s.name, s.file_path, 'similar symbol name');

  const terms = splitIdentifierTerms(query);
  if (terms.length > 0) {
    // (b) FTS retry over the split terms.
    const ftsRows = await searchFts(db, terms.join(' '), {
      limit, filePattern: scope.filePattern, language: scope.language,
    });
    const ftsChunks = await chunkStore.getChunksByIds(ftsRows.map((r) => r.chunk_id));
    for (const c of ftsChunks) add(c.symbol_name, c.file_path, 'matched split query terms');

    // (c) Identifier near-miss over the split terms.
    const nearRows = await searchIdentifierNearMiss(db, terms, limit);
    const nearChunks = await chunkStore.getChunksByIds(nearRows.map((r) => r.chunk_id));
    for (const c of nearChunks) add(c.symbol_name, c.file_path, 'identifier near-miss');
  }

  return out;
}
