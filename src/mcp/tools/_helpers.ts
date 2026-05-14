import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../../graph/db.js';
import type { LanceStore } from '../../store/lance.js';
import type { ResolvedConfig } from '../../store/config.js';
import { checkAndRefreshIfStale, type StalenessCheckResult } from '../staleness.js';

/** Extract the first JSDoc comment block from chunk content, if present. */
export function extractDoc(content: string): string | null {
  const match = /\/\*\*([\s\S]*?)\*\//.exec(content);
  return match != null ? match[0].trim() : null;
}

/**
 * Convert a glob pattern to a RegExp.
 * `*`  — matches any sequence not containing `/`
 * `**` — matches any sequence including `/`
 * `?`  — matches a single non-`/` character
 */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const rx = escaped
    .replace(/\*\*\//g, '(.+/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${rx}$`);
}

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
