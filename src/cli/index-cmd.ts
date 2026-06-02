import type { Command } from 'commander';
import { resolveConfig } from '../store/config.js';
import { runIndex, runEmbed } from '../indexer/index.js';

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

      // Phase 2 embedding. Run in-process here (unlike `mast serve`, which
      // forks for isolation) — `mast index` is a one-shot process, so there is
      // no long-lived MCP server to protect from an embedder crash. This is the
      // path the Docker seed build (§13.8) uses to ship a fully-embedded index.
      if (!opts.phase1Only) {
        const embed = await runEmbed(config, {
          onProgress: opts.showProgress
            ? (embedded: number, total: number) => {
                if (total === 0) return;
                const pct = Math.round((embedded / total) * 100);
                const line = `  embedding ${embedded}/${total} chunks (${pct}%)`;
                process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
                if (embedded === total && process.stderr.isTTY) process.stderr.write('\n');
              }
            : undefined,
        });
        process.stdout.write(
          `embedded: ${embed.chunksEmbedded} chunks, ${embed.chunksSkipped} skipped` +
          `  duration: ${embed.durationMs}ms\n`,
        );
      }
    });
}
