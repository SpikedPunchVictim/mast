import type { Db } from '../graph/db.js';
import type { LanceStore } from '../store/lance.js';
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
  readonly config: ResolvedConfig;
  /** Returns the current embedder, or null while vectors are still warming. */
  readonly getEmbedder: () => Embedder | null;
  /** Returns 'hybrid' once vectors are ready; 'lexical' during cold start. */
  readonly searchMode: () => SearchMode;
  /** Stable identifier for this MCP server session (used in metrics). */
  readonly sessionId: string;
}
