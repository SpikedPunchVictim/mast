/**
 * How far the index has drifted from the working tree — one producer, read by
 * both `mast status` (CLI) and `mast_status` (MCP).
 *
 * The two surfaces used to compute this separately and disagree. The CLI
 * diffed `file_manifest.json` against a fresh walk; the MCP tool enumerated the
 * `files` table and stat'd each row. Neither is sufficient alone, which is why
 * this reads **both** signals and takes the union:
 *
 *  - The **manifest** knows which files the last run considered. It is the only
 *    signal that can see a file which exists on disk and was never indexed —
 *    such a file is in no `files` row, so a table-driven check is structurally
 *    blind to it. That blindness was the MCP tool's defect
 *    (`docs/defects/LEDGER.md` D035): add one file to a project and it reported
 *    `index_fresh: true`.
 *  - The **`files.mtime` stamp** knows what was actually written, and records
 *    the mtime of the content that was parsed (invariant 1 in `runIndex`'s
 *    WHY-comment — stamped BEFORE the extract, never re-stat'd at write time).
 *    The manifest, by contrast, is stamped from a re-stat during the finalise
 *    phase, so an edit landing mid-run leaves the manifest looking current
 *    while the row correctly reads stale. It is also the only signal that sees
 *    a file which is in the manifest but absent from the index — the residue
 *    D034 left on indexes written before that fix, which would otherwise need a
 *    full reindex to detect.
 *
 * A file counts once, under the first heading that applies.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../graph/db.js';
import { CURRENT_SCHEMA_VERSION, type ResolvedConfig } from '../store/config.js';
import type { StalePaths } from '../ast/types.js';
import { countPendingEdgeRepairs } from '../graph/importer-repair.js';
import { walkProject } from './walker.js';

export interface IndexFreshness {
  /**
   * On disk and known to the index, but its content has changed since, or its
   * row was written by another schema version.
   */
  readonly stale: number;
  /** On disk and not indexed — never seen, or lost to a failed run. */
  readonly unindexed: number;
  /** Known to the index, no longer on disk. */
  readonly deleted: number;
  /** `stale + unindexed + deleted` — what both surfaces report as `stale_files`. */
  readonly total: number;
  /**
   * Files whose content the index has, but whose edges are waiting to be
   * resolved again after another file changed (`graph/importer-repair.ts`).
   * Not part of `total`: the file itself is not behind, and a search over it is
   * right. What may be wrong is an answer drawn from edges.
   */
  readonly pendingEdgeRepairs: number;
  /**
   * Indexable files this walk found, whatever their index state — the
   * denominator the three counts above are drawn against.
   *
   * Carried so a caller can tell "some of this tree is unindexed" from "none of
   * this tree is indexed", which is the difference between a stale index and an
   * index built for a different project root (D048). Without it `unindexed` is
   * a bare count with nothing to compare it to.
   */
  readonly walked: number;
  /**
   * Every path behind the three counts, sorted and uncapped. The status
   * surfaces publish {@link stalePathsSample} of this, not the lists themselves.
   */
  readonly paths: StalePaths;
}

/**
 * How many paths per category the status surfaces print. An index built for a
 * different project root counts thousands of files on each side (D048), and a
 * status report that long would bury the fields above it.
 */
export const STALE_PATHS_CAP = 20;

/** The first {@link STALE_PATHS_CAP} paths of each category, for publishing. */
export function stalePathsSample(freshness: IndexFreshness): StalePaths {
  return {
    changed: freshness.paths.changed.slice(0, STALE_PATHS_CAP),
    unindexed: freshness.paths.unindexed.slice(0, STALE_PATHS_CAP),
    deleted: freshness.paths.deleted.slice(0, STALE_PATHS_CAP),
  };
}

/**
 * Measure the index against the working tree.
 *
 * Costs one project walk plus one `files` scan per call, which is why it is
 * called from the status surfaces and not from the read tools. The walk stats
 * every file anyway, so the mtime comparisons below are free.
 */
export async function measureFreshness(config: ResolvedConfig, db: Db): Promise<IndexFreshness> {
  const manifestPath = join(config.resolved_state_dir, 'file_manifest.json');
  const manifest: Record<string, number> = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, number>)
    : {};

  const currentFiles = await walkProject(config);
  const onDisk = new Map(currentFiles.map((e) => [e.relativePath, e.mtime]));

  const rows = await db.selectFrom('files').select(['path', 'mtime', 'written_by']).execute();
  const indexed = new Map(rows.map((r) => [r.path, r.mtime]));
  // A row another schema version wrote counts as changed: its content may be
  // current and its shape is not this version's (D142). An index run queues
  // the same rows, so what is counted here is what a run acts on.
  const writtenByAnotherVersion = new Set(
    rows.filter((r) => r.written_by !== CURRENT_SCHEMA_VERSION).map((r) => r.path),
  );

  const changedPaths: string[] = [];
  const unindexedPaths: string[] = [];
  for (const [path, diskMtime] of onDisk) {
    const manifestMtime = manifest[path];
    const storedMtime = indexed.get(path);
    // Absent from either record means it is not in the index: never walked
    // before, or walked and then lost when its parse or write failed.
    if (manifestMtime === undefined || storedMtime === undefined) {
      unindexedPaths.push(path);
      continue;
    }
    if (diskMtime > manifestMtime || diskMtime > storedMtime || writtenByAnotherVersion.has(path)) changedPaths.push(path);
  }

  // A path recorded by either side but no longer on disk. Deduplicated: the
  // usual case is that both sides still carry it.
  const gone = new Set<string>();
  for (const path of Object.keys(manifest)) if (!onDisk.has(path)) gone.add(path);
  for (const path of indexed.keys()) if (!onDisk.has(path)) gone.add(path);

  return {
    stale: changedPaths.length,
    unindexed: unindexedPaths.length,
    deleted: gone.size,
    total: changedPaths.length + unindexedPaths.length + gone.size,
    pendingEdgeRepairs: await countPendingEdgeRepairs(db),
    walked: onDisk.size,
    paths: {
      changed: changedPaths.sort(),
      unindexed: unindexedPaths.sort(),
      deleted: [...gone].sort(),
    },
  };
}
