import { Command } from 'commander';
import { CLI_VERSION } from './version.js';
import { registerInitCommand } from './init.js';
import { registerIndexCommand } from './index-cmd.js';
import { registerSearchCommand } from './search-cmd.js';
import { registerServeCommand } from './serve.js';
import { registerStatusCommand } from './status.js';
import { registerWalkCommand } from './walk-cmd.js';
import { registerInstallHooksCommand } from './install-hooks.js';
import { registerMetricsCommand } from './metrics-cmd.js';
import { registerQueryCommand } from './query.js';
import { registerDocsCommand, registerSkillCommand } from './docs-cmd.js';
import { registerUpgradeCommand } from './upgrade-cmd.js';
import { registerPrimeCommand } from './prime-cmd.js';
import { registerHookCommand } from './hook-cmd.js';
import { registerSetupCommand } from './setup-cmd.js';
import { UserError } from '../user-error.js';

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
  registerWalkCommand(program);
  registerInstallHooksCommand(program);
  registerMetricsCommand(program);
  registerQueryCommand(program);
  registerDocsCommand(program);
  registerSkillCommand(program);
  registerPrimeCommand(program);
  registerHookCommand(program);
  registerSetupCommand(program);
  registerUpgradeCommand(program);

  return program;
}

/** Every registered command name, sorted. Derived from `buildProgram`, never restated. */
export function registeredCommandNames(): readonly string[] {
  return buildProgram().commands.map((c) => c.name()).sort();
}

/**
 * Parses and runs one command line. A `UserError` is the user's to fix, so it
 * is written as one line and turned into exit code 1. Anything else propagates
 * with its stack trace: it is a bug, and the trace is the report.
 *
 * @returns 1 after a `UserError`; otherwise undefined, so that an exit code
 * the command set itself is left alone.
 */
export async function runCli(
  argv: readonly string[],
  writeError: (text: string) => void,
  program: Command = buildProgram(),
): Promise<1 | undefined> {
  try {
    await program.parseAsync([...argv]);
    return undefined;
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    writeError(`mast: ${err.message}\n`);
    return 1;
  }
}
