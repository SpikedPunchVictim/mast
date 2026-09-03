import type { Db } from '../graph/db.js';
import type { ChunkStore } from '../store/sqliteChunkStore.js';
import type { ResolvedConfig } from '../store/config.js';
import type { FreshnessProbe } from './freshness-probe.js';

// ---------------------------------------------------------------------------
// Shared application context passed to every MCP tool handler
// ---------------------------------------------------------------------------

/**
 * Shared state injected into every MCP tool handler at registration time.
 *
 * Stage 7.2 (IMPLEMENTATION_PLAN.md "Stage 7: Vector-store deletion") removed
 * `searchMode` — its only consumer was `mast_status`'s search-mode status
 * field, itself removed (decision 2). Nothing else ever read it.
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
  /** Stable identifier for this MCP server session (used in metrics). */
  readonly sessionId: string;
  /**
   * Cached "is the index missing files?" signal, read by `mast_search` to warn
   * that a result set may be incomplete.
   *
   * Optional, and absent is a real configuration rather than an oversight: the
   * probe amortises one project walk across a TTL, which only pays off in a
   * long-lived process. `mast serve` wires one (mcp/server.ts); the one-shot
   * CLI query path (cli/query.ts) deliberately does not, because a single
   * search there would pay the whole walk to answer a question it can answer
   * outright with `mast search --reindex`.
   *
   * Absent, or reporting `null`, means *unknown* — surfaces render that as
   * silence, never as zero.
   */
  readonly freshness?: FreshnessProbe;
}
