import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { clearDerivedTables } from '../graph/db.js';

/**
 * Index-derived state that lives beside `graph.db`, rebuilt from source by a
 * reindex. `config.json`, `index.json` and the lock marker files are not in
 * this set and are kept.
 */
const DERIVED_STATE_FILES = [
  'lance',              // chunks + vectors tables of a pre-2026-08-06 install
  'file_manifest.json', // mtime snapshot
  'embed_cache',        // per-content-hash embedding cache of the same era
] as const;

/**
 * Empty the index in `stateDir` so that rows an older version wrote can never
 * be read by this one (§7.4 Step 2). The tables of `graph.db` are cleared
 * inside the file, which stays in place for any process that has it open, and
 * the metrics tables in it are kept (see {@link clearDerivedTables}).
 *
 * The caller holds the structure lock.
 *
 * @throws SqliteError when another connection is writing to `graph.db` and
 *   does not finish in time. Nothing has been removed in that case.
 */
export function clearDerivedState(stateDir: string): void {
  // The database first: if it cannot be cleared, the manifest that describes
  // it has to stay too.
  clearDerivedTables(stateDir);
  for (const entry of DERIVED_STATE_FILES) {
    rmSync(join(stateDir, entry), { recursive: true, force: true });
  }
}
