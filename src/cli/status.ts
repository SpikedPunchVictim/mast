import type { Command } from 'commander';
import type { StaleBreakdown } from '../ast/types.js';
import { resolveConfig, CURRENT_SCHEMA_VERSION } from '../store/config.js';
import { loadIndexMeta, freshnessCause } from '../indexer/index.js';
import { measureFreshness, type IndexFreshness } from '../indexer/freshness.js';
import { openDatabase } from '../graph/db.js';

export interface StatusReport {
  readonly state_dir: string;
  /**
   * The tree this report was measured against.
   *
   * Reported because `state_dir` alone does not identify it, and the two are
   * independently settable: a relative `--state-dir` resolves against the path
   * argument, so it is entirely possible to read one project's index while
   * asking about another project's files (D048).
   */
  readonly project_root: string;
  /** False when nothing has ever been indexed at `state_dir`. */
  readonly initialised: boolean;
  readonly schema_version: string;
  readonly last_indexed: string | null;
  readonly indexed_files: number | null;
  readonly chunk_count: number | null;
  /** `null` when there is no index — a stale count against nothing is meaningless. */
  readonly stale_files: number | null;
  /**
   * `stale_files` split into the three categories it sums. `null` on the same
   * condition, and for the same reason.
   */
  readonly stale_breakdown: StaleBreakdown | null;
  readonly parse_errors: number | null;
  readonly write_errors: number | null;
  readonly index_fresh: boolean;
  readonly freshness_cause: string | null;
  readonly seed_commit?: string | undefined;
}

/**
 * Builds the status report.
 *
 * The `initialised` distinction is load-bearing. M6 (ADR 008) fixed `mast serve`
 * answering meaningfully against a never-indexed state directory; the same shape
 * survived here. Pointed at a path with no index, this used to report an invented
 * schema version, a stale-file count computed against an empty manifest, and
 * `freshness_cause: phase1_stale` — telling a caller their index was stale when in
 * fact they were looking in the wrong place. The case that produces it is ordinary:
 * `mast init --state-dir ./elsewhere`, then any later command without the flag,
 * because path keys are deliberately never read back from a persisted config.
 */
export async function buildStatus(
  options: { path?: string; stateDir?: string } = {},
): Promise<StatusReport> {
  const config = resolveConfig({ projectRoot: options.path, stateDirOverride: options.stateDir });
  const meta = loadIndexMeta(config.resolved_state_dir);

  if (meta === null) {
    return {
      state_dir: config.resolved_state_dir,
      project_root: config.resolved_project_root,
      initialised: false,
      schema_version: CURRENT_SCHEMA_VERSION,
      last_indexed: null,
      indexed_files: null,
      chunk_count: null,
      stale_files: null,
      stale_breakdown: null,
      parse_errors: null,
      write_errors: null,
      index_fresh: false,
      freshness_cause: 'not_initialised',
    };
  }

  // Freshness needs the `files` stamps as well as the manifest (see
  // `measureFreshness`), so this opens the graph db — safe here and nowhere
  // above, because the `meta === null` branch has already returned for a state
  // dir that was never indexed.
  const db = openDatabase(config.resolved_state_dir);
  let freshness: IndexFreshness;
  try {
    freshness = await measureFreshness(config, db);
  } finally {
    await db.destroy();
  }

  return {
    state_dir: config.resolved_state_dir,
    project_root: config.resolved_project_root,
    initialised: true,
    // From the binary, never from index.json — see StatusResult.schema_version.
    schema_version: CURRENT_SCHEMA_VERSION,
    last_indexed: meta.last_indexed ?? null,
    indexed_files: meta.file_count ?? 0,
    chunk_count: meta.chunk_count ?? 0,
    stale_files: freshness.total,
    stale_breakdown: {
      changed: freshness.stale,
      unindexed: freshness.unindexed,
      deleted: freshness.deleted,
    },
    parse_errors: meta.parse_errors ?? 0,
    write_errors: meta.write_errors ?? 0,
    index_fresh: freshness.total === 0,
    freshness_cause: freshnessCause(freshness),
    seed_commit: meta.seed_commit,
  };
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status [path]')
    .description('Print index health')
    .option('--state-dir <dir>', 'State directory')
    .option('--json', 'Output as JSON')
    .action(async (projectPath: string | undefined, opts: {
      stateDir?: string;
      json?: boolean;
    }) => {
      const status = await buildStatus({ path: projectPath, stateDir: opts.stateDir });

      if (opts.json) {
        process.stdout.write(JSON.stringify(status, null, 2) + '\n');
        return;
      }

      // An absent index gets a short, unambiguous answer and a non-zero exit — not a
      // health table with zeros in it, which reads as a report on something real.
      if (!status.initialised) {
        process.stdout.write([
          `state_dir:      ${status.state_dir}`,
          'index:          NOT INITIALISED — nothing has been indexed at this path',
          '',
          'Run `mast init` here, or pass --state-dir if you indexed somewhere else.',
          'A custom --state-dir is not remembered between runs; set `state_dir` in',
          'mast.config.json or export MAST_STATE_DIR to make it stick.',
        ].join('\n') + '\n');
        process.exitCode = 1;
        return;
      }

      const ago = status.last_indexed != null
        ? ` (${formatAge(new Date(status.last_indexed))} ago)`
        : '';

      // The split is printed inline rather than on its own line: `stale_files`
      // names one of the three things it counts, and the total alone has been
      // read as "3391 files changed" when it was one changed file and 3390
      // paths belonging to another tree (D049).
      const b = status.stale_breakdown;
      const split = b !== null && (status.stale_files ?? 0) > 0
        ? `  (changed ${String(b.changed)}, unindexed ${String(b.unindexed)}, deleted ${String(b.deleted)})`
        : '';

      process.stdout.write([
        `state_dir:      ${status.state_dir}`,
        `project_root:   ${status.project_root}`,
        `schema_version: ${status.schema_version}`,
        `last_indexed:   ${status.last_indexed ?? 'never'}${ago}`,
        `indexed_files:  ${String(status.indexed_files)}`,
        `chunk_count:    ${String(status.chunk_count)}`,
        `stale_files:    ${String(status.stale_files)}${split}`,
        `parse_errors:   ${String(status.parse_errors)}`,
        `write_errors:   ${String(status.write_errors)}`,
        `index_fresh:    ${String(status.index_fresh)}`,
        `freshness_cause: ${status.freshness_cause ?? 'none'}`,
        ...(status.seed_commit != null ? [`seed_commit:    ${status.seed_commit}`] : []),
        ...(status.freshness_cause === 'root_mismatch' ? [
          '',
          `! This index does not describe the tree at ${status.project_root}.`,
          '  Most files here are unknown to it, and most files it lists are not here —',
          '  it was built for a different project root, so reindexing will not move',
          '  these numbers. Check the path argument and --state-dir: a relative',
          '  --state-dir resolves against the path argument, not the shell\'s',
          '  working directory.',
        ] : []),
      ].join('\n') + '\n');
    });
}

function formatAge(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1_000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
