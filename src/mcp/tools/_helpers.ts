import type { Db } from '../../graph/db.js';
import type { ResolvedConfig } from '../../store/config.js';
import type { AppContext } from '../context.js';
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
  type PotentialMatchCandidatesResult,
  type PotentialMatchesResult,
} from '../../search/potential-matches.js';

// ---------------------------------------------------------------------------
// M6 Part B (eval/GITNEXUS_COMPARISON.md §13.8 item 4): empty-index signal.
// ---------------------------------------------------------------------------

/**
 * True when the `chunks` table has zero rows — i.e. nothing is indexed yet,
 * whether that's a never-indexed state dir mid-background-reindex (the
 * legitimate §7.4 startup-ladder window Part A deliberately leaves alone) or
 * a genuinely empty corpus. Every read tool with a primary result array
 * calls this ONLY on its empty-result path (`ast/types.ts`'s `index_empty`
 * field) to distinguish "empty because nothing indexed" from "empty because
 * no match" — never called when results were found, so a populated index
 * pays nothing extra per call.
 */
export async function isIndexEmpty(ctx: AppContext): Promise<boolean> {
  return (await ctx.chunkStore.chunkCount()) === 0;
}

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

// countStaleFiles removed 2026-08-20 (D035). It enumerated the `files` table,
// so a file on disk that was never indexed was in no row and therefore
// invisible to it — `mast_status` reported a fresh index while `mast status`
// reported the same index stale. Freshness now has one producer for both
// surfaces: `indexer/freshness.ts` `measureFreshness`.
