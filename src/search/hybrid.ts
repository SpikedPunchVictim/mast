import type { SearchInput, SearchResult, SearchMode, Chunk, ChunkType } from '../ast/types.js';
import type { Db } from '../graph/db.js';
import type { LanceStore } from '../store/lance.js';
import type { EmbedderLike } from '../indexer/embedder.js';
import { searchFts } from './fts.js';
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
  readonly similarity_threshold: number;
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
): Promise<{ mode: SearchMode; results: SearchResult[] }> {
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
        const hits = await searchVectors(lance, queryVec.embedding, candidateLimit);
        const aboveThreshold = hits.filter((h) => h.score >= config.similarity_threshold);
        if (aboveThreshold.length > 0) {
          mode = 'hybrid';
          aboveThreshold.forEach((h, i) => {
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
  const chunkRecords = await lance.getChunksByIds(topIds);

  const filtered = chunkRecords.filter((c) => {
    if (input.chunk_type != null && c.chunk_type !== input.chunk_type) return false;
    if (input.only_exported === true && !c.is_exported) return false;
    return true;
  });

  // Re-sort filtered chunks by their RRF score (getChunksByIds order is arbitrary).
  const rrfByChunkId = new Map(scored.map((s) => [s.chunk_id, s.rrf]));
  filtered.sort((a, b) => (rrfByChunkId.get(b.chunk_id) ?? 0) - (rrfByChunkId.get(a.chunk_id) ?? 0));

  const results: SearchResult[] = filtered.slice(0, limit).map((c, i) => {
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
      rank:           i + 1,
      match_snippet:  ftsMeta?.snippet ?? null,
    };
  });

  return { mode, results };
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
