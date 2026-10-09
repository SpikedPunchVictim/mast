import { existsSync, rmSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResolvedConfig } from '../store/config.js';
import { writeStateConfig } from '../store/config.js';
import { initLockMarkers, withLock } from '../store/lock.js';
import { markIndexCleared } from '../indexer/index.js';
import { NewerIndexError, readIndexStamp } from '../store/index-stamp.js';
import { clearDerivedState } from '../store/derived-state.js';

export { clearDerivedState };

/** Startup must not hang on a busy index: one attempt, then leave it to the reindex. */
const STARTUP_CLEAR_LOCK = { maxRetries: 0, retryIntervalMs: 100, caller: 'startup-clear' } as const;

/** Default location of the Docker-baked seed index (§13.8). */
const DEFAULT_SEED_PATH = '/opt/mast-seed';

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
 * {@link clearDerivedState} on its behalf. Without this, `lance/`/`embed_cache/`/
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
 *   written by an older `schema_version` (including a seed baked against an
 *   old schema, §13.8.2) or cannot be read, empty the index inside `graph.db`
 *   and request a full rebuild. The stamp keeps the old version's name until
 *   that rebuild writes its own.
 *
 * @throws NewerIndexError when `index.json` names a newer schema version; the
 * index is left as it is.
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
  const stamp = readIndexStamp(config.resolved_state_dir);
  if (stamp.kind === 'newer') throw new NewerIndexError(config.resolved_state_dir, stamp.meta.schema_version);
  if (stamp.kind === 'older' || stamp.kind === 'unreadable') {
    try {
      await withLock(config.resolved_state_dir, 'structure', STARTUP_CLEAR_LOCK, () => {
        clearDerivedState(config.resolved_state_dir);
        if (stamp.kind === 'older') markIndexCleared(config.resolved_state_dir, stamp.meta);
        return Promise.resolve();
      });
    } catch (err) {
      // Another process holds the lock or is writing. The index stays as the
      // old version left it, and so does its stamp, so the reindex this
      // return value asks for clears it under the lock itself.
      process.stderr.write(`[mast] startup: could not empty the index another version built: ${String(err)}\n`);
    }
    return { needsFullReindex: true };
  }

  return { needsFullReindex: false };
}
