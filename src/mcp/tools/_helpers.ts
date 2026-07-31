import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../../graph/db.js';
import type { ResolvedConfig } from '../../store/config.js';
import { checkAndRefreshIfStale, type StalenessCheckResult } from '../staleness.js';

// collectPotentialMatches/collectPotentialMatchCandidates moved to
// search/potential-matches.ts (Stage 1.2) so the `mast index --checker` pass
// (graph/checker-resolver.ts) can share the exact same "what counts as a
// potential match" definition without an mcp/tools → graph layering
// inversion — `search` already sits between `graph`/`store` and their
// consumers. Re-exported here so mast_callers/mast_rename_impact's existing
// `from './_helpers.js'` imports keep working unchanged.
export {
  collectPotentialMatches,
  collectPotentialMatchCandidates,
  type ChunkByIdSource,
  type PotentialMatchCandidate,
  type PotentialMatchesResult,
} from '../../search/potential-matches.js';

/** Extract the first JSDoc comment block from chunk content, if present. */
export function extractDoc(content: string): string | null {
  const match = /\/\*\*([\s\S]*?)\*\//.exec(content);
  return match != null ? match[0].trim() : null;
}

// globToRegex moved to indexer/walker.ts (file-discovery domain) so watch mode
// can use it without an indexer → mcp dependency; re-exported for existing users.
export { globToRegex } from '../../indexer/walker.js';

/**
 * Look up the stored mtime for `filePath` from the `files` table and run a JIT
 * single-file re-parse if the disk version is newer. Returns `{ busy: false,
 * refreshed: false }` when the file is not yet indexed.
 */
export async function jitRefreshFile(
  db: Db,
  config: ResolvedConfig,
  filePath: string,
): Promise<StalenessCheckResult> {
  const row = await db
    .selectFrom('files')
    .select('mtime')
    .where('path', '=', filePath)
    .executeTakeFirst();
  if (row === undefined) return { busy: false, refreshed: false };
  return checkAndRefreshIfStale(db, config, filePath, row.mtime);
}

/**
 * Count files in the `files` table whose disk mtime exceeds the stored mtime.
 * Deleted files are also counted as stale.
 */
export async function countStaleFiles(
  db: Db,
  projectRoot: string,
): Promise<number> {
  const rows = await db.selectFrom('files').select(['path', 'mtime']).execute();
  let count = 0;
  for (const row of rows) {
    try {
      const stat = statSync(join(projectRoot, row.path));
      if (stat.mtimeMs / 1_000 > row.mtime) count++;
    } catch {
      count++;
    }
  }
  return count;
}
