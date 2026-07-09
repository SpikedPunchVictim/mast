import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../../graph/db.js';
import type { LanceStore } from '../../store/lance.js';
import type { ResolvedConfig } from '../../store/config.js';
import type { VerifiedCaller, PotentialMatch } from '../../ast/types.js';
import { searchIdentifiers } from '../../search/fts.js';
import { checkAndRefreshIfStale, type StalenessCheckResult } from '../staleness.js';

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
  lance: LanceStore,
  config: ResolvedConfig,
  filePath: string,
): Promise<StalenessCheckResult> {
  const row = await db
    .selectFrom('files')
    .select('mtime')
    .where('path', '=', filePath)
    .executeTakeFirst();
  if (row === undefined) return { busy: false, refreshed: false };
  return checkAndRefreshIfStale(db, lance, config, filePath, row.mtime);
}

/**
 * Identifier-FTS hits for `symbolName` that are NOT already covered by a
 * verified caller — the "review required" set. Shared by `mast_callers` and
 * `mast_rename_impact` so the two tools can never disagree about what counts
 * as a potential match.
 */
export async function collectPotentialMatches(
  db: Db,
  lance: LanceStore,
  symbolName: string,
  verified: readonly VerifiedCaller[],
  limit = 50,
): Promise<PotentialMatch[]> {
  const identRows = await searchIdentifiers(db, symbolName, limit);
  const chunks = await lance.getChunksByIds(identRows.map((r) => r.chunk_id));

  // Exclude chunk IDs already covered by the verified set.
  const verifiedKeys = new Set(verified.map((c) => `${c.file_path}:${c.line}`));
  const matches: PotentialMatch[] = [];
  for (const chunk of chunks) {
    if (verifiedKeys.has(`${chunk.file_path}:${chunk.start_line}`)) continue;
    matches.push({
      file_path: chunk.file_path,
      line: chunk.start_line,
      context: chunk.symbol_name ?? '',
      reason: 'identifier_match_no_resolved_edge',
    });
  }
  return matches;
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
