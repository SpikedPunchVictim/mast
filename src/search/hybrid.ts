import type { SearchInput, SearchResult, SearchMode, SearchSuggestion, RelatedHint, Chunk, ChunkType } from '../ast/types.js';
import type { Db } from '../graph/db.js';
import type { LanceStore, ChunkRecord } from '../store/lance.js';
import type { ChunkStore } from '../store/sqliteChunkStore.js';
import type { EmbedderLike } from '../indexer/embedder.js';
import { searchFts, searchIdentifierNearMiss, splitIdentifierTerms } from './fts.js';
import { querySymbolsBySimilarity } from '../graph/queries.js';
import { searchVectors } from './vector.js';

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

export interface HybridSearchConfig {
  readonly rrf_k: number;
}

// ---------------------------------------------------------------------------
// Hybrid search
// ---------------------------------------------------------------------------

/**
 * Hybrid BM25 + vector search fused via Reciprocal Rank Fusion.
 *
 * Mode selection:
 * - `lexical` — embedder is null, or the vector search returns no hits
 *   (vectors table empty / Phase 2 not yet run).
 * - `hybrid` — both FTS and vector results are available and fused.
 *
 * Post-filters (`chunk_type`, `only_exported`) are applied after RRF ranking,
 * on the full chunk records fetched from LanceDB. SQL-level filters
 * (`file_pattern`, `language`) are pushed into the FTS query.
 */
export async function hybridSearch(
  db: Db,
  lance: LanceStore,
  embedder: EmbedderLike | null,
  input: SearchInput,
  config: HybridSearchConfig,
  // SPIKE (eval/GITNEXUS_COMPARISON.md §13.5/§14.1): chunk reads are split
  // from `lance` so they can be redirected onto SqliteChunkStore while vector
  // search (`searchVectors(lance, ...)` below) always stays on Lance.
  // Defaulting to `lance` keeps every existing call site byte-identical.
  chunkStore: ChunkStore = lance,
): Promise<{ mode: SearchMode; results: SearchResult[]; suggestions?: SearchSuggestion[] }> {
  const limit = input.limit ?? 10;
  // Over-fetch so post-filters don't starve the final result set.
  const candidateLimit = limit * 4;

  // --- BM25 ---
  const ftsRows = await searchFts(db, input.query, {
    limit: candidateLimit,
    filePattern: input.file_pattern,
    language: input.language,
  });

  // Build rank + metadata maps for RRF.
  const ftsMap = new Map<string, { rank: number; bm25Score: number; snippet: string }>();
  ftsRows.forEach((r, i) => {
    ftsMap.set(r.chunk_id, { rank: i + 1, bm25Score: r.bm25_score, snippet: r.match_snippet });
  });

  // --- Vector search ---
  let mode: SearchMode = 'lexical';
  const vecMap = new Map<string, { rank: number; score: number }>();

  if (embedder !== null) {
    try {
      await embedder.load();
      const [queryVec] = await embedder.embed([queryAsChunk(input.query)]);
      if (queryVec !== undefined) {
        // Rank-based inclusion (Task 9): every top-candidateLimit vector hit
        // feeds RRF, regardless of absolute cosine. The old absolute gate
        // (similarity_threshold: 0.70) was miscalibrated — 0/28 gold-set
        // conceptual queries produced a jina cosine ≥ 0.70, so shipped hybrid
        // silently collapsed to lexical on exactly the query class vectors
        // exist for. No floor replaces it: measured gold top-1 cosines
        // (0.40–0.66) interleave with junk-query top-1 cosines (0.41–0.54),
        // so no absolute cutoff separates relevant from junk on this model —
        // and cosine scales are model-specific anyway. RRF's rank fusion is
        // the relevance arbiter (§7.3); `similarity_score` is reported so
        // consumers can judge confidence themselves.
        const hits = await searchVectors(lance, queryVec.embedding, candidateLimit);
        if (hits.length > 0) {
          mode = 'hybrid';
          hits.forEach((h, i) => {
            vecMap.set(h.chunkId, { rank: i + 1, score: h.score });
          });
        }
      }
    } catch {
      // Embedding failure is non-fatal — fall back to lexical.
    }
  }

  // --- RRF fusion ---
  const allIds = new Set([...ftsMap.keys(), ...vecMap.keys()]);

  const scored: Array<{ chunk_id: string; rrf: number }> = [];
  for (const id of allIds) {
    let rrf = 0;
    const ftsMeta = ftsMap.get(id);
    const vecMeta = vecMap.get(id);
    if (ftsMeta !== undefined) rrf += rrfScore(ftsMeta.rank, config.rrf_k);
    if (vecMeta !== undefined) rrf += rrfScore(vecMeta.rank, config.rrf_k);
    scored.push({ chunk_id: id, rrf });
  }
  scored.sort((a, b) => b.rrf - a.rrf);

  // --- Fetch chunk data and apply post-filters ---
  const topIds = scored.slice(0, candidateLimit).map((s) => s.chunk_id);
  const chunkRecords = await chunkStore.getChunksByIds(topIds);

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
    const vecMeta = vecMap.get(c.chunk_id);
    return {
      file_path:      c.file_path,
      start_line:     c.start_line,
      end_line:       c.end_line,
      content:        c.content,
      chunk_type:     c.chunk_type as ChunkType,
      symbol_name:    c.symbol_name,
      parent_symbol:  c.parent_symbol,
      is_exported:    c.is_exported,
      similarity_score: mode === 'hybrid' ? (vecMeta?.score ?? null) : null,
      match_score:    ftsMeta?.bm25Score ?? null,
      // Re-ranked after dedup so consumers keep contiguous ranks from 1.
      rank:           i + 1,
      match_snippet:  ftsMeta?.snippet ?? null,
      ...(related !== undefined ? { related } : {}),
    };
  });

  // Zero-result assist: when nothing survived (no FTS/vector hit, or filters
  // emptied the set), gather advisory "did you mean" candidates instead of
  // returning a bare dead end (§9 mast_search). Suggestions never become
  // results — the caller keeps `results: []`.
  if (results.length === 0) {
    const suggestions = await gatherSuggestions(db, chunkStore, input.query, limit);
    return { mode, results, suggestions };
  }

  return { mode, results };
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
 */
async function gatherSuggestions(
  db: Db,
  chunkStore: ChunkStore,
  query: string,
  limit: number,
): Promise<SearchSuggestion[]> {
  const out: SearchSuggestion[] = [];
  const seen = new Set<string>();
  const add = (symbol: string | null, filePath: string, reason: string): void => {
    if (symbol === null || out.length >= limit) return;
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
    const ftsRows = await searchFts(db, terms.join(' '), { limit });
    const ftsChunks = await chunkStore.getChunksByIds(ftsRows.map((r) => r.chunk_id));
    for (const c of ftsChunks) add(c.symbol_name, c.file_path, 'matched split query terms');

    // (c) Identifier near-miss over the split terms.
    const nearRows = await searchIdentifierNearMiss(db, terms, limit);
    const nearChunks = await chunkStore.getChunksByIds(nearRows.map((r) => r.chunk_id));
    for (const c of nearChunks) add(c.symbol_name, c.file_path, 'identifier near-miss');
  }

  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a raw query string as a minimal Chunk for the embedder.
 * Only `content` and `chunk_id` are used by the embedding pipeline.
 */
function queryAsChunk(query: string): Chunk {
  return {
    chunk_id:     '__query__',
    file_path:    '__query__',
    start_line:   0,
    end_line:     0,
    content:      query,
    chunk_type:   'block',
    symbol_name:  null,
    parent_symbol: null,
    is_exported:  false,
    language:     'typescript',
    file_mtime:   0,
  };
}
