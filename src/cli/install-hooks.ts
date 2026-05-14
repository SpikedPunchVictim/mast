import type { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HOOKS: ReadonlyArray<{ name: string; body: string }> = [
  {
    name: 'post-commit',
    body: '#!/bin/sh\nmast index --incremental\n',
  },
  {
    name: 'post-checkout',
    body: '#!/bin/sh\nmast index --incremental\n',
  },
];

export function registerInstallHooksCommand(program: Command): void {
  program
    .command('install-hooks [path]')
    .description('Install git hooks that keep the index fresh after commits and checkouts')
    .action((projectPath: string | undefined) => {
      const root = resolve(projectPath ?? process.cwd());
      const hooksDir = join(root, '.git', 'hooks');

      if (!existsSync(join(root, '.git'))) {
        process.stderr.write(`mast: no .git directory found at ${root}\n`);
        process.exit(1);
      }

      mkdirSync(hooksDir, { recursive: true });

      for (const hook of HOOKS) {
        const hookPath = join(hooksDir, hook.name);
        writeFileSync(hookPath, hook.body, { encoding: 'utf-8' });
        // Git requires hooks to be executable.
        chmodSync(hookPath, 0o755);
        process.stdout.write(`Installed ${hookPath}\n`);
      }
    });
}
