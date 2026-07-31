import type { Db } from '../graph/db.js';
import type { LanceStore } from '../store/lance.js';
import type { ChunkStore } from '../store/sqliteChunkStore.js';
import type { Embedder } from '../indexer/embedder.js';
import type { ResolvedConfig } from '../store/config.js';
import type { SearchMode } from '../ast/types.js';

// ---------------------------------------------------------------------------
// Shared application context passed to every MCP tool handler
// ---------------------------------------------------------------------------

/**
 * Shared state injected into every MCP tool handler at registration time.
 *
 * Mutable fields (searchMode, embedder) are accessed via functions so that
 * background embedding progress is visible to handlers without a restart.
 */
export interface AppContext {
  readonly db: Db;
  readonly lance: LanceStore;
  /**
   * Chunk read/write surface (M1, eval/GITNEXUS_COMPARISON.md §15.1) —
   * separate from `lance` because chunks live in graph.db's `chunks` table
   * while vector search stays on Lance (M2 decides otherwise). Backed by
   * `SqliteChunkStore` wrapping the same `db` connection in production
   * (mcp/server.ts); tests may inject a fake.
   */
  readonly chunkStore: ChunkStore;
  readonly config: ResolvedConfig;
  /** Returns the current embedder, or null while vectors are still warming. */
  readonly getEmbedder: () => Embedder | null;
  /** Returns 'hybrid' once vectors are ready; 'lexical' during cold start. */
  readonly searchMode: () => SearchMode;
  /**
   * Embed any chunks that have no vector yet (e.g. those just written by the
   * agent and re-parsed via `mast_reindex`), reusing the background embedder.
   * Best-effort and serialised; resolves when embedding settles. A no-op when
   * nothing is pending. Called by `mast_reindex` after Phase 1.
   */
  readonly embedPending: () => Promise<void>;
  /** Stable identifier for this MCP server session (used in metrics). */
  readonly sessionId: string;
}
