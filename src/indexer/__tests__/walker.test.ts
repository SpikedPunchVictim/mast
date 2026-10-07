import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../../store/config.js';
import { UserError } from '../../user-error.js';
import { walkProject } from '../walker.js';

/**
 * A directory mast may not read stops the walk. Skipping it would index the rest
 * and report the result as complete, which is the failure this package ranks
 * worst; a bare EACCES names neither the cause nor the two ways out.
 */
// Root reads a mode-000 directory, so the condition cannot be set up as root.
describe.skipIf(process.getuid?.() === 0)('walkProject — a directory it cannot read', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'mast-walker-unreadable-'));
    for (const rel of ['src/a.ts', 'locked/x.md']) {
      mkdirSync(join(project, dirname(rel)), { recursive: true });
      writeFileSync(join(project, rel), '# heading\n');
    }
    chmodSync(join(project, 'locked'), 0o000);
  });

  afterEach(() => {
    chmodSync(join(project, 'locked'), 0o755);
    rmSync(project, { recursive: true, force: true });
  });

  it('throws a UserError', async () => {
    await expect(walkProject(resolveConfig({ projectRoot: project }))).rejects.toThrow(UserError);
  });

  it('names the directory and how to get past it', async () => {
    await expect(walkProject(resolveConfig({ projectRoot: project }))).rejects.toThrow(
      /cannot read .*locked: permission denied\. Make it readable, or add "locked\/\*\*" to exclude_patterns/,
    );
  });

  it('walks the rest once the directory is excluded', async () => {
    writeFileSync(join(project, 'mast.config.json'), JSON.stringify({ exclude_patterns: ['locked/**'] }));

    const entries = await walkProject(resolveConfig({ projectRoot: project }));

    expect(entries.map((e) => e.relativePath)).toEqual(['src/a.ts']);
  });
});
