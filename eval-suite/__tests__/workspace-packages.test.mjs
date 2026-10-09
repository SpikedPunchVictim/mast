import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { workspacePackageDirs } from '../workspace-packages.mjs';

describe('workspacePackageDirs', () => {
  let root;
  const pkg = (dir) => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'package.json'), '{}');
  };
  const found = () => workspacePackageDirs(root).map((dir) => relative(root, dir));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mast-workspace-packages-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds a package directly under packages/ and one under a scope', () => {
    pkg('packages/core');
    pkg('packages/@scope/di');

    expect(found()).toEqual(['packages/@scope/di', 'packages/core']);
  });

  it('finds a package under a directory that only groups packages', () => {
    pkg('packages/testing/janitor');
    pkg('packages/frontend/@scope/chat');

    expect(found()).toEqual(['packages/frontend/@scope/chat', 'packages/testing/janitor']);
  });

  it('finds a package inside another package, and nothing under node_modules or a dot directory', () => {
    pkg('packages/core');
    pkg('packages/core/nested');
    pkg('packages/core/node_modules/dep');
    pkg('packages/core/.turbo/cache');

    expect(found()).toEqual(['packages/core', 'packages/core/nested']);
  });

  it('is empty when there is no packages directory', () => {
    expect(found()).toEqual([]);
  });
});
