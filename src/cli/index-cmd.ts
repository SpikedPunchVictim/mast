import type { Command } from 'commander';
import { resolveConfig } from '../store/config.js';
import { runIndex } from '../indexer/index.js';

export function registerIndexCommand(program: Command): void {
  program
    .command('index [path]')
    .description('Build or update the index')
    .option('--state-dir <dir>', 'State directory (resolved from config if omitted)')
    .option('--incremental', 'Only reindex files changed since last index run')
    .option('--phase1-only', 'Parse and chunk only; skip embedding')
    .option('--show-progress', 'Print indexing progress to stderr')
    .action(async (projectPath: string | undefined, opts: {
      stateDir?: string;
      incremental?: boolean;
      phase1Only?: boolean;
      showProgress?: boolean;
    }) => {
      const config = resolveConfig({
        projectRoot: projectPath,
        stateDirOverride: opts.stateDir,
      });

      const onProgress = opts.showProgress
        ? (processed: number, total: number) => {
            if (total === 0) return;
            const pct = Math.round((processed / total) * 100);
            const line = `  indexing ${processed}/${total} files (${pct}%)`;
            // \r rewrites the line in place on a TTY; fall back to newlines otherwise.
            process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
            if (processed === total && process.stderr.isTTY) process.stderr.write('\n');
          }
        : undefined;

      const result = await runIndex(config, { incremental: opts.incremental ?? false, onProgress });

      process.stdout.write(
        `files: ${result.filesIndexed} indexed, ${result.filesSkipped} skipped` +
        `  chunks: +${result.chunksAdded} -${result.chunksRemoved}` +
        `  duration: ${result.durationMs}ms` +
        (result.parseErrors > 0 ? `  parse_errors: ${result.parseErrors}` : '') +
        '\n',
      );

      // Phase 2 embedding is omitted when --phase1-only; otherwise the
      // background embedder would normally run here via the CLI path.
      // Stage 9 implementation: wire up Phase 2 for the CLI.
      if (!opts.phase1Only) {
        process.stdout.write('Note: Phase 2 (embedding) not yet wired for CLI — use `mast serve` for full indexing.\n');
      }
    });
}
