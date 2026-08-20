import { Command } from 'commander';
import { CLI_VERSION } from './version.js';
import { registerInitCommand } from './init.js';
import { registerIndexCommand } from './index-cmd.js';
import { registerSearchCommand } from './search-cmd.js';
import { registerServeCommand } from './serve.js';
import { registerStatusCommand } from './status.js';
import { registerInstallHooksCommand } from './install-hooks.js';
import { registerMetricsCommand } from './metrics-cmd.js';
import { registerQueryCommand } from './query.js';
import { registerDocsCommand, registerSkillCommand } from './docs-cmd.js';
import { registerUpgradeCommand } from './upgrade-cmd.js';

/**
 * Builds the CLI. This is the *only* place commands are registered.
 *
 * `cli/index.ts` parses the program this returns, and the README drift guard in
 * `docs-cmd.test.ts` enumerates it. Both read the same builder on purpose: a
 * separate list of commands maintained for the test would be a second producer of
 * one value (shape S-05), and a guard that can fall out of step with the thing it
 * guards is worse than none — it reports green while the README rots.
 */
export function buildProgram(): Command {
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
  registerUpgradeCommand(program);

  return program;
}

/** Every registered command name, sorted. Derived from `buildProgram`, never restated. */
export function registeredCommandNames(): readonly string[] {
  return buildProgram().commands.map((c) => c.name()).sort();
}
