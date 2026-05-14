import type { Command } from 'commander';
import { resolveConfig } from '../store/config.js';
import { serve } from '../mcp/server.js';

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Start the MCP server over stdio')
    .option('--state-dir <dir>', 'State directory')
    .option('--no-startup-reindex', 'Skip the startup staleness check (not recommended)')
    .action(async (opts: {
      stateDir?: string;
      startupReindex: boolean;  // commander --no-startup-reindex sets to false
    }) => {
      const config = resolveConfig({ stateDirOverride: opts.stateDir });
      await serve({
        config,
        noStartupReindex: !opts.startupReindex,
      });
    });
}
