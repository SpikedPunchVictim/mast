import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readDoc } from '../docs-cmd.js';
import { BEGIN_MARKER, END_MARKER } from '../skill-install.js';
import {
  renderOwnedRules, planOwnedFile, planMarkedBlock, firstExisting, ZED_RULES_FILES,
  cursorRulesPath, windsurfRulesPaths, chooseWindsurfRulesPath,
} from '../setup-rules.js';

const SKILL = '# Using MAST\n\nBody line.\n';

describe('renderOwnedRules', () => {
  it('gives Cursor a description and alwaysApply in the frontmatter, then the skill', () => {
    const text = renderOwnedRules('cursor', SKILL);

    expect(text.startsWith('---\ndescription: ')).toBe(true);
    const frontmatter = text.split('---\n')[1] ?? '';
    expect(frontmatter).toMatch(/^description: [^\n]+\nalwaysApply: true\n$/);
    expect(text).toContain('# Using MAST');
  });

  it('gives Windsurf trigger: always_on and nothing else in the frontmatter', () => {
    const text = renderOwnedRules('windsurf', SKILL);

    expect(text.startsWith('---\ntrigger: always_on\n---\n')).toBe(true);
  });

  it('ends with exactly one newline', () => {
    expect(renderOwnedRules('cursor', SKILL + '\n\n').endsWith('Body line.\n')).toBe(true);
  });

  // Windsurf documents a 12,000-character limit on workspace rule files; a longer file is
  // truncated or ignored, which would drop the end of the instructions without any error.
  it('keeps the Windsurf file under 12,000 characters for the real skill asset', () => {
    const text = renderOwnedRules('windsurf', readDoc('skill'));

    expect(text.length).toBeGreaterThan(readDoc('skill').length);
    expect(text.length).toBeLessThan(12_000);
  });
});

describe('planOwnedFile', () => {
  it('reports a missing file as missing, to be written', () => {
    expect(planOwnedFile(null, 'W\n', false)).toEqual({ state: 'missing', changed: true, next: 'W\n' });
  });

  it('reports identical content as current and unchanged', () => {
    expect(planOwnedFile('W\n', 'W\n', false)).toEqual({ state: 'current', changed: false, next: 'W\n' });
  });

  it('reports different content as outdated, to be overwritten', () => {
    expect(planOwnedFile('old\n', 'W\n', false)).toEqual({ state: 'outdated', changed: true, next: 'W\n' });
  });

  it('removes an existing file by planning a null next value', () => {
    expect(planOwnedFile('W\n', 'W\n', true)).toMatchObject({ changed: true, next: null });
  });

  it('plans nothing when removing a file that is not there', () => {
    expect(planOwnedFile(null, 'W\n', true)).toMatchObject({ changed: false });
  });
});

describe('planMarkedBlock', () => {
  it('appends the block to a file that has none, keeping the file text', () => {
    const plan = planMarkedBlock('Mine.\n', SKILL, false);

    expect(plan.state).toBe('missing');
    expect(plan.next?.startsWith('Mine.\n\n' + BEGIN_MARKER)).toBe(true);
  });

  it('is current, unchanged, when the identical block is present', () => {
    const once = planMarkedBlock('Mine.\n', SKILL, false).next ?? '';

    expect(planMarkedBlock(once, SKILL, false)).toEqual({ state: 'current', changed: false, next: once });
  });

  it('replaces a stale block in place and keeps text on both sides', () => {
    const stale = `Before.\n\n${BEGIN_MARKER}\n\nold\n\n${END_MARKER}\n\nAfter.\n`;

    const plan = planMarkedBlock(stale, SKILL, false);

    expect(plan.state).toBe('outdated');
    expect(plan.next).toContain('Before.');
    expect(plan.next).toContain('After.');
    expect(plan.next).toContain('Body line.');
    expect(plan.next).not.toContain('old\n');
  });

  it('removes only the block, leaving the rest of the file', () => {
    const withBlock = planMarkedBlock('Mine.\n', SKILL, false).next ?? '';

    const plan = planMarkedBlock(withBlock, SKILL, true);

    expect(plan).toEqual({ state: 'current', changed: true, next: 'Mine.\n' });
  });

  it('removes a block that sits between other text without joining the lines', () => {
    const text = `Before.\n\n${BEGIN_MARKER}\n\nx\n\n${END_MARKER}\n\nAfter.\n`;

    expect(planMarkedBlock(text, SKILL, true).next).toBe('Before.\n\nAfter.\n');
  });

  it('leaves an empty file when the block was all there was', () => {
    const only = planMarkedBlock('', SKILL, false).next ?? '';

    expect(planMarkedBlock(only, SKILL, true).next).toBe('');
  });

  it('plans nothing when removing a block that is absent', () => {
    expect(planMarkedBlock('Mine.\n', SKILL, true)).toMatchObject({ changed: false, next: 'Mine.\n' });
  });
});

describe('Zed rules file choice', () => {
  it('lists Zed\'s candidates in precedence order, .rules first', () => {
    expect(ZED_RULES_FILES[0]).toBe('.rules');
    expect(ZED_RULES_FILES).toContain('AGENTS.md');
    expect(ZED_RULES_FILES.indexOf('AGENTS.md')).toBeLessThan(ZED_RULES_FILES.indexOf('CLAUDE.md'));
  });

  it('picks the first candidate that exists, not the last', () => {
    const present = new Set(['CLAUDE.md', 'AGENTS.md']);

    expect(firstExisting(ZED_RULES_FILES, (f) => present.has(f))).toBe('AGENTS.md');
  });

  it('returns null when none exists', () => {
    expect(firstExisting(ZED_RULES_FILES, () => false)).toBeNull();
  });
});

describe('rules file locations', () => {
  it('puts Cursor\'s file at .cursor/rules/mast.mdc', () => {
    expect(cursorRulesPath('/p')).toBe(join('/p', '.cursor', 'rules', 'mast.mdc'));
  });

  it('chooses .devin/rules when that directory exists', () => {
    expect(chooseWindsurfRulesPath('/p', true)).toBe(join('/p', '.devin', 'rules', 'mast.md'));
  });

  it('chooses .windsurf/rules otherwise', () => {
    expect(chooseWindsurfRulesPath('/p', false)).toBe(join('/p', '.windsurf', 'rules', 'mast.md'));
  });

  it('knows both Windsurf locations, for removal', () => {
    expect(windsurfRulesPaths('/p')).toEqual([join('/p', '.devin', 'rules', 'mast.md'), join('/p', '.windsurf', 'rules', 'mast.md')]);
  });
});
