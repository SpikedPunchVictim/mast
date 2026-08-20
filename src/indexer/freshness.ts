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
import type { ResolvedConfig } from '../store/config.js';
import { walkProject } from './walker.js';

export interface IndexFreshness {
  /** On disk and known to the index, but its content has changed since. */
  readonly stale: number;
  /** On disk and not indexed — never seen, or lost to a failed run. */
  readonly unindexed: number;
  /** Known to the index, no longer on disk. */
  readonly deleted: number;
  /** `stale + unindexed + deleted` — what both surfaces report as `stale_files`. */
  readonly total: number;
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

  const rows = await db.selectFrom('files').select(['path', 'mtime']).execute();
  const indexed = new Map(rows.map((r) => [r.path, r.mtime]));

  let stale = 0;
  let unindexed = 0;
  for (const [path, diskMtime] of onDisk) {
    const manifestMtime = manifest[path];
    const storedMtime = indexed.get(path);
    // Absent from either record means it is not in the index: never walked
    // before, or walked and then lost when its parse or write failed.
    if (manifestMtime === undefined || storedMtime === undefined) {
      unindexed++;
      continue;
    }
    if (diskMtime > manifestMtime || diskMtime > storedMtime) stale++;
  }

  // A path recorded by either side but no longer on disk. Deduplicated: the
  // usual case is that both sides still carry it.
  const gone = new Set<string>();
  for (const path of Object.keys(manifest)) if (!onDisk.has(path)) gone.add(path);
  for (const path of indexed.keys()) if (!onDisk.has(path)) gone.add(path);

  return { stale, unindexed, deleted: gone.size, total: stale + unindexed + gone.size };
}
