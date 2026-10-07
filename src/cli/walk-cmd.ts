import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { resolveConfig } from '../store/config.js';
import { walkProject } from '../indexer/walker.js';

export interface WalkedDirectory {
  /** Project-relative directory, `.` for the project root. */
  readonly directory: string;
  /** Walked files in it; with a depth limit, in it and everything below it. */
  readonly files: number;
}

export interface IncludedDotDir {
  readonly directory: string;
  /**
   * False when nothing by this name is a directory on disk. Reported next to
   * `files` because zero files has two causes that want opposite fixes: a
   * misspelt entry, or a real directory holding nothing the config indexes.
   */
  readonly exists: boolean;
  /** Walked files below it. */
  readonly files: number;
}

export interface WalkReport {
  readonly project_root: string;
  /** The `mast.config.json` that was read, or null when the project has none. */
  readonly config_file: string | null;
  /**
   * The `<state_dir>/config.json` that was read, or null. Reported because it
   * fills every key `mast.config.json` leaves unset: an entry deleted from
   * `mast.config.json` keeps applying from here after `mast init` or
   * `mast serve` has saved it, and without this line nothing would say why.
   */
  readonly saved_config_file: string | null;
  readonly file_extensions: readonly string[];
  readonly exclude_patterns: readonly string[];
  readonly include_dot_dirs: readonly IncludedDotDir[];
  readonly total_files: number;
  readonly directories: readonly WalkedDirectory[];
  /** Every walked file, project-relative, in walk order. */
  readonly files: readonly string[];
}

function directoryOf(relativePath: string, depth: number | undefined): string {
  const segments = relativePath.split('/').slice(0, -1);
  const kept = depth === undefined ? segments : segments.slice(0, depth);
  return kept.length === 0 ? '.' : kept.join('/');
}

/**
 * Reports what an index run would walk for this project's config, without
 * reading or writing an index.
 *
 * It calls `walkProject`, the same function `runIndex` and `measureFreshness`
 * walk with, so the report cannot disagree with what gets indexed.
 *
 * @throws whatever `resolveConfig` throws for a config it rejects.
 */
export async function buildWalkReport(
  options: { path?: string; stateDir?: string; depth?: number } = {},
): Promise<WalkReport> {
  const config = resolveConfig({ projectRoot: options.path, stateDirOverride: options.stateDir });
  const files = (await walkProject(config)).map((entry) => entry.relativePath);

  const counts = new Map<string, number>();
  for (const file of files) {
    const directory = directoryOf(file, options.depth);
    counts.set(directory, (counts.get(directory) ?? 0) + 1);
  }
  const directories = [...counts.entries()]
    .map(([directory, count]) => ({ directory, files: count }))
    .sort((a, b) => (a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0));

  const configFile = join(config.resolved_project_root, 'mast.config.json');
  const savedConfigFile = join(config.resolved_state_dir, 'config.json');

  return {
    project_root: config.resolved_project_root,
    config_file: existsSync(configFile) ? configFile : null,
    saved_config_file: existsSync(savedConfigFile) ? savedConfigFile : null,
    file_extensions: config.file_extensions,
    exclude_patterns: config.exclude_patterns,
    include_dot_dirs: config.include_dot_dirs.map((directory) => ({
      directory,
      exists: statSync(join(config.resolved_project_root, directory), { throwIfNoEntry: false })?.isDirectory() === true,
      files: files.filter((file) => file.startsWith(`${directory}/`)).length,
    })),
    total_files: files.length,
    directories,
    files,
  };
}

function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${String(count)} ${count === 1 ? noun : pluralNoun}`;
}

export function formatWalkReport(report: WalkReport, options: { files: boolean }): string {
  const lines = [
    `project_root:      ${report.project_root}`,
    `config:            ${report.config_file ?? 'no mast.config.json'}`,
    ...(report.saved_config_file !== null
      ? [`saved config:      ${report.saved_config_file} (supplies any key mast.config.json does not set)`]
      : []),
    `file_extensions:   ${report.file_extensions.join(' ')}`,
    `exclude_patterns:  ${report.exclude_patterns.join(' ')}`,
    `include_dot_dirs:  ${report.include_dot_dirs.length === 0 ? '(none: no dot directory is walked)' : report.include_dot_dirs.map((d) => d.directory).join(' ')}`,
  ];

  for (const dotDir of report.include_dot_dirs) {
    if (!dotDir.exists) {
      lines.push(`! ${dotDir.directory}: no such directory under the project root. Check the spelling in include_dot_dirs.`);
    } else if (dotDir.files === 0) {
      lines.push(`! ${dotDir.directory}: exists, but no file in it matches file_extensions once exclude_patterns is applied.`);
    }
  }

  lines.push('', `${plural(report.total_files, 'file')} in ${plural(report.directories.length, 'directory', 'directories')}`, '');

  if (options.files) {
    lines.push(...report.files);
  } else {
    const width = Math.max(...report.directories.map((d) => String(d.files).length), 1);
    for (const d of report.directories) lines.push(`${String(d.files).padStart(width + 2)}  ${d.directory}`);
  }

  return lines.join('\n') + '\n';
}

function parseDepth(value: string): number | null {
  return /^[1-9]\d*$/.test(value) ? Number(value) : null;
}

export function registerWalkCommand(program: Command): void {
  program
    .command('walk [path]')
    .description('Show which directories and files the config makes mast walk, without indexing')
    .option('--depth <n>', 'Roll directories up to this many path segments')
    .option('--files', 'List every walked file instead of the directories')
    .option('--state-dir <dir>', 'State directory')
    .option('--json', 'Output as JSON')
    .addHelpText('after', [
      '',
      'Examples:',
      '  mast walk                  directories that would be indexed, with file counts',
      '  mast walk --depth 1        the same, rolled up to top-level directories',
      '  mast walk --files          every file, for checking exclude_patterns',
    ].join('\n'))
    .action(async (projectPath: string | undefined, opts: {
      depth?: string;
      files?: boolean;
      stateDir?: string;
      json?: boolean;
    }) => {
      const depth = opts.depth === undefined ? undefined : parseDepth(opts.depth);
      if (depth === null) {
        process.stderr.write(`mast walk: --depth must be a whole number of 1 or more, got ${JSON.stringify(opts.depth)}\n`);
        process.exitCode = 2;
        return;
      }

      let report: WalkReport;
      try {
        report = await buildWalkReport({
          path: projectPath,
          stateDir: opts.stateDir,
          ...(depth !== undefined ? { depth } : {}),
        });
      } catch (err) {
        // This is the command for testing a config, so a config it rejects is an
        // answer to print, not a stack trace.
        process.stderr.write(`mast walk: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
        return;
      }

      process.stdout.write(
        opts.json === true
          ? JSON.stringify(report, null, 2) + '\n'
          : formatWalkReport(report, { files: opts.files === true }),
      );
    });
}
