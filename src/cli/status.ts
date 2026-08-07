import type { Command } from 'commander';
import { resolveConfig } from '../store/config.js';
import { loadIndexMeta, freshnessCause } from '../indexer/index.js';
import { walkProject, diffManifest } from '../indexer/walker.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
      const config = resolveConfig({
        projectRoot: projectPath,
        stateDirOverride: opts.stateDir,
      });

      const meta = loadIndexMeta(config.resolved_state_dir);

      // Count stale files by diffing current mtime scan against manifest.
      const manifestPath = join(config.resolved_state_dir, 'file_manifest.json');
      const prevManifest: Record<string, number> = existsSync(manifestPath)
        ? (JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, number>)
        : {};

      const currentFiles = await walkProject(config);
      const { stale, added, deleted } = diffManifest(currentFiles, prevManifest);
      const staleCount = stale.length + added.length + deleted.length;

      const status = {
        state_dir:     config.resolved_state_dir,
        last_indexed:  meta?.last_indexed ?? null,
        indexed_files: meta?.file_count ?? 0,
        chunk_count:   meta?.chunk_count ?? 0,
        stale_files:   staleCount,
        parse_errors:  meta?.parse_errors ?? 0,
        write_errors:  meta?.write_errors ?? 0,
        index_fresh:   staleCount === 0 && meta !== null,
        freshness_cause: freshnessCause(staleCount),
        seed_commit:   meta?.seed_commit,
      };

      if (opts.json) {
        process.stdout.write(JSON.stringify(status, null, 2) + '\n');
        return;
      }

      const ago = status.last_indexed != null
        ? ` (${formatAge(new Date(status.last_indexed))} ago)`
        : '';

      process.stdout.write([
        `state_dir:      ${status.state_dir}`,
        `last_indexed:   ${status.last_indexed ?? 'never'}${ago}`,
        `indexed_files:  ${status.indexed_files}`,
        `chunk_count:    ${status.chunk_count}`,
        `stale_files:    ${status.stale_files}`,
        `parse_errors:   ${status.parse_errors}`,
        `write_errors:   ${status.write_errors}`,
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
