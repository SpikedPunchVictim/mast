#!/usr/bin/env node
import { Command } from 'commander';
import { registerInitCommand }         from './init.js';
import { registerIndexCommand }        from './index-cmd.js';
import { registerServeCommand }        from './serve.js';
import { registerStatusCommand }       from './status.js';
import { registerInstallHooksCommand } from './install-hooks.js';
import { registerMetricsCommand }       from './metrics-cmd.js';
import { registerQueryCommand }        from './query.js';

const program = new Command()
  .name('mast')
  .description('Monorepo AST Search Tool — lexical + declaration-exact code search over an MCP or CLI surface')
  .version('0.1.0');

registerInitCommand(program);
registerIndexCommand(program);
registerServeCommand(program);
registerStatusCommand(program);
registerInstallHooksCommand(program);
registerMetricsCommand(program);
registerQueryCommand(program);

await program.parseAsync(process.argv);
