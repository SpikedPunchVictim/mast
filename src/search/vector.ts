import type { LanceStore } from '../store/lance.js';

// ---------------------------------------------------------------------------
// Vector similarity search
// ---------------------------------------------------------------------------

export interface VectorHit {
  /** chunk_id from the vectors table. */
  readonly chunkId: string;
  /**
   * Cosine similarity ∈ [-1, 1]; higher is better, 1 = identical direction.
   *
   * LanceDB's cosine distance is `1 - cosine_similarity` (range [0, 2]), so the
   * similarity is `1 - distance`. This is the real cosine value the
   * `similarity_threshold` config and the reported `similarity_score` mean.
   */
  readonly score: number;
}

/**
 * Query the vector store for nearest neighbours of `queryVector`.
 *
 * Returns an empty array when the vectors table has no rows (cold start /
 * lexical mode) — callers use this to detect and fall back gracefully.
 */
export async function searchVectors(
  lance: LanceStore,
  queryVector: readonly number[],
  limit: number,
): Promise<VectorHit[]> {
  const rows = await lance.searchVectors(queryVector, limit);
  return rows.map((r) => ({
    chunkId: r.chunk_id,
    score: 1 - r._distance,
  }));
}
