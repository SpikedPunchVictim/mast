import type { Db } from '../graph/db.js';
import type { ChunkStore } from '../store/sqliteChunkStore.js';
import type { ResolvedConfig } from '../store/config.js';
import type { SearchMode } from '../ast/types.js';

// ---------------------------------------------------------------------------
// Shared application context passed to every MCP tool handler
// ---------------------------------------------------------------------------

/**
 * Shared state injected into every MCP tool handler at registration time.
 *
 * `searchMode` is accessed via a function (rather than a plain field) for the
 * same reason it always was: handlers must never cache it across calls. Its
 * value is now frozen at `'lexical'` (Stage 7.1, IMPLEMENTATION_PLAN.md
 * "Stage 7: Vector-store deletion" — the vector subsystem that used to flip
 * it to `'hybrid'` was excised); Stage 7.2 redesigns the surface honestly.
 */
export interface AppContext {
  readonly db: Db;
  /**
   * Chunk read surface (M1, eval/GITNEXUS_COMPARISON.md §15.1). Backed by
   * `SqliteChunkStore` wrapping the same `db` connection in production
   * (mcp/server.ts); tests may inject a fake.
   */
  readonly chunkStore: ChunkStore;
  readonly config: ResolvedConfig;
  /** Always returns 'lexical' post-Stage-7.1 — see this interface's doc. */
  readonly searchMode: () => SearchMode;
  /** Stable identifier for this MCP server session (used in metrics). */
  readonly sessionId: string;
}
