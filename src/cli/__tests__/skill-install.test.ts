import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectSkillTargets, spliceSkillBlock, BEGIN_MARKER, END_MARKER } from '../skill-install.js';

const proj = (): string => mkdtempSync(join(tmpdir(), 'mast-skill-'));

describe('spliceSkillBlock', () => {
  it('appends a marked block to a file that has none', () => {
    const out = spliceSkillBlock('# My rules\n\nBe careful.\n', 'SKILL TEXT');
    expect(out).toContain('# My rules');
    expect(out).toContain(BEGIN_MARKER);
    expect(out).toContain('SKILL TEXT');
    expect(out).toContain(END_MARKER);
  });

  /**
   * The reason this is a marked block and not an append: a user runs `--install` again
   * after upgrading, and a second copy of the skill in their CLAUDE.md is worse than
   * none — it doubles the prompt and the two copies disagree after the next upgrade.
   */
  it('replaces an existing block rather than adding a second', () => {
    const once = spliceSkillBlock('# Rules\n', 'VERSION ONE');
    const twice = spliceSkillBlock(once, 'VERSION TWO');
    expect(twice.match(new RegExp(BEGIN_MARKER, 'g'))?.length).toBe(1);
    expect(twice).toContain('VERSION TWO');
    expect(twice).not.toContain('VERSION ONE');
  });

  it('leaves the user content outside the block untouched', () => {
    const original = '# Rules\n\nNever force push.\n';
    const twice = spliceSkillBlock(spliceSkillBlock(original, 'A'), 'B');
    expect(twice).toContain('Never force push.');
    expect(twice.indexOf('# Rules')).toBe(0);
  });

  it('is a no-op in content when the skill text has not changed', () => {
    const once = spliceSkillBlock('# Rules\n', 'SAME');
    expect(spliceSkillBlock(once, 'SAME')).toBe(once);
  });

  it('creates a usable file from empty content', () => {
    expect(spliceSkillBlock('', 'SKILL')).toContain('SKILL');
  });
});

describe('detectSkillTargets', () => {
  it('finds nothing in a project with no agent config', () => {
    expect(detectSkillTargets(proj())).toEqual([]);
  });

  it.each([
    ['CLAUDE.md', 'CLAUDE.md'],
    ['AGENTS.md', 'AGENTS.md'],
    ['.cursorrules', '.cursorrules'],
    ['.windsurfrules', '.windsurfrules'],
  ])('detects %s', (file) => {
    const dir = proj();
    writeFileSync(join(dir, file), '# existing\n');
    expect(detectSkillTargets(dir).map((t) => t.file)).toContain(file);
  });

  it('detects a nested copilot instructions file', () => {
    const dir = proj();
    mkdirSync(join(dir, '.github'), { recursive: true });
    writeFileSync(join(dir, '.github', 'copilot-instructions.md'), '');
    expect(detectSkillTargets(dir).map((t) => t.file)).toContain('.github/copilot-instructions.md');
  });

  /**
   * Only files that already exist are offered. Creating CLAUDE.md in a repo that
   * deliberately has none is a decision this tool does not get to make for someone.
   */
  it('never invents a target that does not exist', () => {
    const dir = proj();
    writeFileSync(join(dir, 'CLAUDE.md'), '');
    expect(detectSkillTargets(dir).map((t) => t.file)).toEqual(['CLAUDE.md']);
  });

  it('reports a path that can be read back', () => {
    const dir = proj();
    writeFileSync(join(dir, 'CLAUDE.md'), '# hi\n');
    const [target] = detectSkillTargets(dir);
    expect(readFileSync(target!.path, 'utf8')).toBe('# hi\n');
  });
});
