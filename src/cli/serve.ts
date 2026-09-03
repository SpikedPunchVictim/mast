import type { Command } from 'commander';
import { resolveConfig } from '../store/config.js';
import { serve, type ServeOptions } from '../mcp/server.js';

/**
 * @param runServe Injected so the flag semantics below can be tested without
 *   standing up a real stdio MCP server (§4.4). Production passes `serve`.
 */
export function registerServeCommand(
  program: Command,
  runServe: (options: ServeOptions) => Promise<void> = serve,
): void {
  program
    .command('serve')
    .description('Start the MCP server over stdio')
    .option('--state-dir <dir>', 'State directory')
    .option('--no-startup-reindex', 'Skip the startup staleness check (not recommended)')
    // Declaration order is load-bearing: commander gives a boolean pair its
    // default from whichever half is declared FIRST, so `--no-watch` must come
    // before `--watch` for the default to be true. `--watch` is kept because
    // existing MCP client configs pass it explicitly; it is now a no-op that
    // selects the default. Pinned by cli/__tests__/serve-options.test.ts.
    .option('--no-watch', 'Do not watch source files; rely on the startup reindex and explicit mast_reindex calls')
    .option('--watch', 'Watch source files and incrementally reindex on change (the default)')
    .action(async (opts: {
      stateDir?: string;
      startupReindex: boolean;  // commander --no-startup-reindex sets to false
      watch: boolean;           // commander --no-watch sets to false
    }) => {
      const config = resolveConfig({ stateDirOverride: opts.stateDir });
      await runServe({
        config,
        noStartupReindex: !opts.startupReindex,
        watch: opts.watch,
      });
    });
}
