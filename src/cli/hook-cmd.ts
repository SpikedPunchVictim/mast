import type { Command } from 'commander';
import { runHookFromProcess } from './hook.js';

export function registerHookCommand(program: Command): void {
  program
    .command('hook <harness> <event>')
    .description('Hook entry point: read a harness hook JSON on stdin, write its envelope on stdout (claude|cursor|vscode, session-start|search)')
    .action(async (harness: string, event: string) => {
      // In normal use `cli/index.ts` dispatches `hook` before this program is ever
      // imported, to avoid its startup cost; this registration exists so `mast --help`
      // lists the command and the README drift guard sees it.
      await runHookFromProcess(harness, event);
    });
}
