import type { Command } from 'commander';
import { resolveConfig, writeStateConfig } from '../store/config.js';
import { initLockMarkers } from '../store/lock.js';
import { runIndex } from '../indexer/index.js';

/** Splits a comma-separated CLI flag value, trimming entries and dropping empties. */
function parseCommaSeparatedList(raw: string): readonly string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Normalizes a user-supplied extension to the leading-dot form `MastConfig.file_extensions`
 * expects (`indexer/walker.ts`'s `walkProject` builds glob patterns as `**\/*${ext}`) — both
 * '.py' and 'py' are accepted on the CLI so users don't have to remember the internal form.
 */
function normalizeExtension(ext: string): string {
  return ext.startsWith('.') ? ext : `.${ext}`;
}

/**
 * Parses `mast init --extensions <ext,...>` into `resolveConfig`'s `extensions` override.
 * Returns `undefined` when the flag is absent, so flag absence keeps `resolveConfig`'s
 * default-priority behavior byte-identical (F9, Stage 3.5).
 */
export function parseExtensionsFlag(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  return parseCommaSeparatedList(raw).map(normalizeExtension);
}

/**
 * Parses `mast init --exclude <pattern,...>` into `resolveConfig`'s `excludePatterns` override.
 * Returns `undefined` when the flag is absent, same rationale as `parseExtensionsFlag`.
 */
export function parseExcludeFlag(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  return parseCommaSeparatedList(raw);
}

export function registerInitCommand(program: Command): void {
  program
    .command('init [path]')
    .description('Initialise mast for a project and run the initial index')
    .option('--state-dir <dir>', 'Where to write index state (default: <path>/.mast)')
    .option('--extensions <ext,...>', 'Comma-separated file extensions to index (default: .ts,.tsx,.js,.jsx)')
    .option('--exclude <pattern,...>', 'Comma-separated glob patterns to exclude')
    .option('--no-index', 'Create config only; skip initial indexing')
    .action(async (projectPath: string | undefined, opts: {
      stateDir?: string;
      extensions?: string;
      exclude?: string;
      index: boolean;   // commander --no-index sets this to false
    }) => {
      const config = resolveConfig({
        projectRoot: projectPath,
        stateDirOverride: opts.stateDir,
        extensions: parseExtensionsFlag(opts.extensions),
        excludePatterns: parseExcludeFlag(opts.exclude),
      });

      initLockMarkers(config.resolved_state_dir);
      writeStateConfig(config.resolved_state_dir, config);
      process.stdout.write(`Initialised ${config.resolved_state_dir}\n`);

      if (opts.index) {
        const result = await runIndex(config, { incremental: false });
        process.stdout.write(
          `Indexed ${result.filesIndexed} files, ${result.chunksAdded} chunks in ${result.durationMs}ms` +
          (result.parseErrors > 0 ? ` (${result.parseErrors} parse errors — check stderr)` : '') +
          '\n',
        );
      }
    });
}
