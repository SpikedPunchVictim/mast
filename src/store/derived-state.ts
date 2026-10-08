import { rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * All index-derived state under the state directory. Everything here is rebuilt
 * from source by a reindex; `config.json` and the lock marker files are NOT in
 * this set and are preserved.
 */
const DERIVED_STATE_ENTRIES = [
  'lance',              // chunks + vectors tables
  'graph.db',           // knowledge graph + FTS
  'graph.db-wal',       // SQLite WAL sidecar
  'graph.db-shm',       // SQLite shared-memory sidecar
  'file_manifest.json', // mtime snapshot
  'embed_cache',        // per-content-hash embedding cache
] as const;

/**
 * Remove all index-derived state from `stateDir`, keeping `config.json` and the
 * advisory lock markers. Used on a schema-version change (§7.4 Step 2) so a
 * stale on-disk shape can never be read by code expecting the new schema.
 */
export function wipeDerivedState(stateDir: string): void {
  for (const entry of DERIVED_STATE_ENTRIES) {
    rmSync(join(stateDir, entry), { recursive: true, force: true });
  }
}
