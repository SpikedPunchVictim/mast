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

// ---------------------------------------------------------------------------
// Orphaned vector-store state (IMPLEMENTATION_PLAN.md "Stage 7: Vector-store
// deletion", decision 3)
// ---------------------------------------------------------------------------

/**
 * State a pre-Stage-7 install can leave behind: `lance/` (the retired chunk +
 * vector tables), `embed_cache/` (per-content-hash embedding cache), and
 * `vectors.lock` (proper-lockfile's own `<marker>.lock` artifact for the
 * 'vectors' lock type, which Stage 7.1 removed — `store/lock.ts`'s
 * `LockType` union of one).
 */
const ORPHANED_VECTOR_STATE_ENTRIES = ['lance', 'embed_cache', 'vectors.lock'] as const;

/**
 * Best-effort delete orphaned vector-store state from `stateDir`.
 *
 * Stage 7 (decision 3) deliberately did NOT bump `CURRENT_SCHEMA_VERSION` —
 * nothing the new code READS changed shape, so `bootstrapState`'s schema
 * guard never fires for a pre-Stage-7 state dir and never runs
 * {@link wipeDerivedState} on its behalf. Without this, `lance/`/`embed_cache/`/
 * `vectors.lock` would sit on disk forever after an upgrade. Runs
 * unconditionally on every startup (not gated on the schema check), and never
 * throws: a permission error or a race with another process must not block
 * serving over a directory nothing reads any more.
 */
export function cleanupOrphanedVectorState(stateDir: string): void {
  const removed: string[] = [];
  for (const entry of ORPHANED_VECTOR_STATE_ENTRIES) {
    const entryPath = join(stateDir, entry);
    try {
      if (!existsSync(entryPath)) continue;
      rmSync(entryPath, { recursive: true, force: true });
      removed.push(entry);
    } catch (err) {
      process.stderr.write(`[mast] startup: failed to remove orphaned vector state "${entry}": ${String(err)}\n`);
    }
  }
  if (removed.length > 0) {
    process.stderr.write(`[mast] startup: removed orphaned vector state: ${removed.join(', ')}\n`);
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
 *   state dir is empty, ensure lock markers exist, persist the resolved
 *   config, and best-effort remove orphaned pre-Stage-7 vector-store state
 *   (IMPLEMENTATION_PLAN.md "Stage 7: Vector-store deletion", decision 3).
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
  // Runs on every startup, independent of the schema-version guard below —
  // Stage 7 deliberately did not bump CURRENT_SCHEMA_VERSION (decision 3), so
  // the guard's wipe path never fires for a pre-Stage-7 state dir and this is
  // the only thing that ever clears these orphans.
  cleanupOrphanedVectorState(config.resolved_state_dir);

  // Step 2.
  const meta = loadIndexMeta(config.resolved_state_dir);
  if (meta !== null && meta.schema_version !== CURRENT_SCHEMA_VERSION) {
    wipeDerivedState(config.resolved_state_dir);
    writeIndexMeta(config.resolved_state_dir, {
      schema_version: CURRENT_SCHEMA_VERSION,
      last_indexed: null,
      file_count: 0,
      chunk_count: 0,
    });
    return { needsFullReindex: true };
  }

  return { needsFullReindex: false };
}
