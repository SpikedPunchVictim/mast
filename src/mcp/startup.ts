import { existsSync, rmSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResolvedConfig } from '../store/config.js';
import { CURRENT_SCHEMA_VERSION, writeStateConfig } from '../store/config.js';
import { initLockMarkers } from '../store/lock.js';
import { loadIndexMeta, writeIndexMeta } from '../indexer/index.js';

/** Default location of the Docker-baked seed index (§13.8). */
const DEFAULT_SEED_PATH = '/opt/mast-seed';

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

export interface BootstrapResult {
  /** True when a full (non-incremental) reindex must run, e.g. after a wipe. */
  readonly needsFullReindex: boolean;
}

/**
 * Startup steps 1–2 of §7.4.
 *
 * Step 1 — bootstrap the state directory: copy the Docker-baked seed when the
 *   state dir is empty, ensure lock markers exist, persist the resolved config.
 * Step 2 — enforce the schema-version guard: if the on-disk `index.json` was
 *   written by a different `schema_version` (including a seed baked against an
 *   old schema, §13.8.2), wipe ALL derived state and request a full rebuild.
 *
 * `seedPath` is injectable so tests can point at a fixture or a path that does
 * not exist (the common test case).
 */
export async function bootstrapState(
  config: ResolvedConfig,
  seedPath: string = DEFAULT_SEED_PATH,
): Promise<BootstrapResult> {
  // Step 1.
  if (!existsSync(config.resolved_state_dir) && existsSync(seedPath)) {
    await cp(seedPath, config.resolved_state_dir, { recursive: true });
  }
  initLockMarkers(config.resolved_state_dir);
  writeStateConfig(config.resolved_state_dir, config);

  // Step 2.
  const meta = loadIndexMeta(config.resolved_state_dir);
  if (meta !== null && meta.schema_version !== CURRENT_SCHEMA_VERSION) {
    wipeDerivedState(config.resolved_state_dir);
    writeIndexMeta(config.resolved_state_dir, {
      schema_version: CURRENT_SCHEMA_VERSION,
      last_indexed: null,
      file_count: 0,
      chunk_count: 0,
      model: config.embedding_model,
    });
    return { needsFullReindex: true };
  }

  return { needsFullReindex: false };
}
