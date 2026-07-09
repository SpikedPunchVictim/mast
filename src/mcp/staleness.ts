import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../graph/db.js';
import type { LanceStore } from '../store/lance.js';
import type { ResolvedConfig } from '../store/config.js';
import { acquireLock } from '../store/lock.js';
import { extractFile } from '../ast/extract.js';
import { populateFile } from '../graph/populate.js';

// ---------------------------------------------------------------------------
// JIT staleness detection and re-parse (§9.0)
// ---------------------------------------------------------------------------

export interface StalenessCheckResult {
  /** True if a JIT re-parse was successfully performed. */
  readonly refreshed: boolean;
  /**
   * True when the file was stale but the lock could not be acquired (file is
   * mid-write). Callers should set `file_busy_returning_stale_cache: true` on
   * affected result objects rather than throwing.
   */
  readonly busy: boolean;
}

/**
 * Check `filePath` for staleness by comparing disk mtime against
 * `storedMtime`. If stale, acquire `structure.lock` and run Phase 1 for that
 * file only (10–50ms per spec §9.0).
 *
 * On lock acquisition failure (file mid-write) returns `{ busy: true }`
 * so the caller can fall back to the TOCTOU policy — return the stale chunk
 * with `file_busy_returning_stale_cache: true`.
 */
export async function checkAndRefreshIfStale(
  db: Db,
  lance: LanceStore,
  config: ResolvedConfig,
  filePath: string,
  storedMtime: number,
): Promise<StalenessCheckResult> {
  const absPath = join(config.resolved_project_root, filePath);
  let diskMtime: number;
  try {
    const stat = statSync(absPath);
    diskMtime = stat.mtimeMs / 1_000;
  } catch {
    // File deleted — nothing to refresh; callers handle missing results.
    return { refreshed: false, busy: false };
  }

  if (diskMtime <= storedMtime) return { refreshed: false, busy: false };

  // File is stale — attempt JIT re-parse under structure.lock.
  let release: (() => Promise<void>) | null = null;
  try {
    release = await acquireLock(config.resolved_state_dir, 'structure', {
      maxRetries: 3,
      retryIntervalMs: 100,
    });
  } catch {
    // Lock busy — fall through to TOCTOU policy.
    return { refreshed: false, busy: true };
  }

  try {
    let result;
    try {
      result = extractFile(absPath, config.resolved_project_root, config.context_lines, config.chunk_split_threshold, config.markdown_heading_depth);
    } catch {
      // TOCTOU: file mid-write, first parse attempt failed.
      await new Promise<void>((res) => setTimeout(res, 50));
      try {
        result = extractFile(absPath, config.resolved_project_root, config.context_lines, config.chunk_split_threshold, config.markdown_heading_depth);
      } catch {
        // Second attempt also failed — signal busy to caller.
        return { refreshed: false, busy: true };
      }
    }

    await lance.replaceChunksForFile(filePath, result.chunks);
    // populateFile handles FTS5 updates within the same SQLite transaction.
    await populateFile(db, {
      filePath,
      language: result.language,
      mtime: diskMtime,
      chunks: result.chunks,
      imports: result.imports,
      symbols: result.symbols,
      identifierRows: result.identifierRows,
    });

    return { refreshed: true, busy: false };
  } finally {
    await release();
  }
}
