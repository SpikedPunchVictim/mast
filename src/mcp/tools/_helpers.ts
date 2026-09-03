import type { Db } from '../../graph/db.js';
import type { ResolvedConfig } from '../../store/config.js';
import type { AppContext } from '../context.js';
import { checkAndRefreshIfStale, type StalenessCheckResult } from '../staleness.js';

/** @see {@link DEFAULT_RESULT_LIMIT} — re-exported so every capped tool reads one constant (D043). */
export { DEFAULT_RESULT_LIMIT } from '../../search/potential-matches.js';

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

/**
 * How exhaustive a tool's answer claims to be. This is what decides whether a
 * partial index is worth mentioning alongside a *non-empty* result, and the two
 * cases are genuinely different claims rather than a style choice.
 *
 * - `exhaustive-set` — the answer is "these are the ones there are"
 *   (`mast_callers`, `mast_rename_impact`, `mast_implementors`, `mast_search`,
 *   `mast_project_skeleton`). A **non-empty** answer is the dangerous one here:
 *   "3 verified callers" computed over a corpus missing forty files is what
 *   drives a delete, and it reads exactly like a complete answer.
 * - `named-lookup` — the answer is about one thing the caller named
 *   (`mast_signature`, `mast_exports`, `mast_dependencies`). If it was found,
 *   the answer is correct however much else is unindexed; only *not finding* it
 *   is ambiguous between "absent" and "never indexed".
 */
export type CompletenessClaim = 'exhaustive-set' | 'named-lookup';

/**
 * The partial-index warning (D054), for every tool that returns a primary
 * result set — not just `mast_search`, which had it first only because that is
 * where it was written.
 *
 * The severity zero: a caller reads an empty or thin answer, concludes "it
 * isn't there", and edits or deletes code that is in fact referenced from a
 * file the index never saw. `index_empty` covers the all-or-nothing case; this
 * covers the far commoner partial one, where the index is populated and merely
 * behind.
 *
 * Free to call. `peekUnindexed` reads a TTL-cached count synchronously and
 * never awaits a walk (see `mcp/freshness-probe.ts`), so unlike `isIndexEmpty`
 * this costs nothing on a populated response and needs no empty-path guard for
 * performance — only for meaning.
 *
 * `null` from the probe means *no measurement has landed yet*, which is
 * unknown, not zero. Both render as an omitted field, but they are kept
 * distinct here because the next reader to add a branch would otherwise inherit
 * "unknown means clean" — the exact conflation this signal exists to prevent.
 */
export function unindexedFilesField(
  ctx: AppContext,
  claim: CompletenessClaim,
  isEmpty: boolean,
): { readonly unindexed_files?: number } {
  if (claim === 'named-lookup' && !isEmpty) return {};
  const unindexed = ctx.freshness?.peekUnindexed() ?? null;
  return unindexed !== null && unindexed > 0 ? { unindexed_files: unindexed } : {};
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
