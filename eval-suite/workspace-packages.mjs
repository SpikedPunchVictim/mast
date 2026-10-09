/**
 * Where a workspace's packages are, for `graph-scorecard.mjs run --workspace-src`. Reads the
 * file system and nothing else; tested in `__tests__/workspace-packages.test.mjs`.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Directories that hold installed or built files, never a workspace package's source. */
const NOT_SOURCE = new Set(['node_modules', 'dist', 'build']);

/**
 * Every directory under `<root>/packages`, at any depth, that holds a `package.json`,
 * sorted. `node_modules`, build output and dot directories are not entered.
 *
 * Any depth because a workspace may group packages (`packages/testing/janitor`,
 * `packages/frontend/@scope/chat`). A package the lookup misses is resolved by the
 * compiler to its build output, which mast does not index, and a right edge into its
 * source is then scored as wrong (D152).
 */
export function workspacePackageDirs(root) {
  const dirs = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || NOT_SOURCE.has(entry.name)) continue;
      const child = join(dir, entry.name);
      if (existsSync(join(child, 'package.json'))) dirs.push(child);
      visit(child);
    }
  };
  const base = join(root, 'packages');
  if (existsSync(base)) visit(base);
  return dirs.sort();
}
