#!/usr/bin/env node
import { Command } from 'commander';
import { CLI_VERSION } from './version.js';
import { registerInitCommand }         from './init.js';
import { registerIndexCommand }        from './index-cmd.js';
import { registerServeCommand }        from './serve.js';
import { registerStatusCommand }       from './status.js';
import { registerInstallHooksCommand } from './install-hooks.js';
import { registerMetricsCommand }       from './metrics-cmd.js';
import { registerQueryCommand }        from './query.js';
import { registerSearchCommand }       from './search-cmd.js';
import { registerDocsCommand, registerSkillCommand } from './docs-cmd.js';

const program = new Command()
  .name('mast')
  .description('Monorepo AST Search Tool — lexical + declaration-exact code search over an MCP or CLI surface')
  .version(CLI_VERSION);

registerInitCommand(program);
registerIndexCommand(program);
registerSearchCommand(program);
registerServeCommand(program);
registerStatusCommand(program);
registerInstallHooksCommand(program);
registerMetricsCommand(program);
registerQueryCommand(program);
registerDocsCommand(program);
registerSkillCommand(program);

await program.parseAsync(process.argv);
