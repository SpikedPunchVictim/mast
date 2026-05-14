import type { LanceStore } from '../store/lance.js';

// ---------------------------------------------------------------------------
// Vector similarity search
// ---------------------------------------------------------------------------

export interface VectorHit {
  /** chunk_id from the vectors table. */
  readonly chunkId: string;
  /**
   * Cosine similarity ∈ [0, 1]; higher is better.
   *
   * LanceDB returns cosine distance ∈ [0, 2]; we convert via `1 - d/2`.
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
    score: 1 - r._distance / 2,
  }));
}
