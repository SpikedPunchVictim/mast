import type { Command } from 'commander';
import { resolveConfig, writeStateConfig } from '../store/config.js';
import { initLockMarkers } from '../store/lock.js';
import { runIndex } from '../indexer/index.js';

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
