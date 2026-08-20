import type { Command } from 'commander';
import { resolveConfig, CURRENT_SCHEMA_VERSION } from '../store/config.js';
import { loadIndexMeta, freshnessCause } from '../indexer/index.js';
import { walkProject, diffManifest } from '../indexer/walker.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface StatusReport {
  readonly state_dir: string;
  /** False when nothing has ever been indexed at `state_dir`. */
  readonly initialised: boolean;
  readonly schema_version: string;
  readonly last_indexed: string | null;
  readonly indexed_files: number | null;
  readonly chunk_count: number | null;
  /** `null` when there is no index — a stale count against nothing is meaningless. */
  readonly stale_files: number | null;
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
      initialised: false,
      schema_version: CURRENT_SCHEMA_VERSION,
      last_indexed: null,
      indexed_files: null,
      chunk_count: null,
      stale_files: null,
      parse_errors: null,
      write_errors: null,
      index_fresh: false,
      freshness_cause: 'not_initialised',
    };
  }

  const manifestPath = join(config.resolved_state_dir, 'file_manifest.json');
  const prevManifest: Record<string, number> = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, number>)
    : {};

  const currentFiles = await walkProject(config);
  const { stale, added, deleted } = diffManifest(currentFiles, prevManifest);
  const staleCount = stale.length + added.length + deleted.length;

  return {
    state_dir: config.resolved_state_dir,
    initialised: true,
    // From the binary, never from index.json — see StatusResult.schema_version.
    schema_version: CURRENT_SCHEMA_VERSION,
    last_indexed: meta.last_indexed ?? null,
    indexed_files: meta.file_count ?? 0,
    chunk_count: meta.chunk_count ?? 0,
    stale_files: staleCount,
    parse_errors: meta.parse_errors ?? 0,
    write_errors: meta.write_errors ?? 0,
    index_fresh: staleCount === 0,
    freshness_cause: freshnessCause(staleCount),
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

      process.stdout.write([
        `state_dir:      ${status.state_dir}`,
        `schema_version: ${status.schema_version}`,
        `last_indexed:   ${status.last_indexed ?? 'never'}${ago}`,
        `indexed_files:  ${String(status.indexed_files)}`,
        `chunk_count:    ${String(status.chunk_count)}`,
        `stale_files:    ${String(status.stale_files)}`,
        `parse_errors:   ${String(status.parse_errors)}`,
        `write_errors:   ${String(status.write_errors)}`,
        `index_fresh:    ${String(status.index_fresh)}`,
        `freshness_cause: ${status.freshness_cause ?? 'none'}`,
        ...(status.seed_commit != null ? [`seed_commit:    ${status.seed_commit}`] : []),
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
