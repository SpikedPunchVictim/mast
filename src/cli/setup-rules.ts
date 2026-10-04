import { join } from 'node:path';
import { BEGIN_MARKER, END_MARKER, spliceSkillBlock } from './skill-install.js';

/**
 * The static channel of `mast setup` (ADR 017 sections 2 and 6): rules files that carry the
 * short skill text. Everything here is pure; reading and writing happen in `setup-cmd.ts`.
 */

export type TextState = 'missing' | 'outdated' | 'current';

export interface TextPlan {
  /** Install-mode state of the file or block as found. Meaningless in remove mode. */
  readonly state: TextState;
  /** False means nothing may be written. */
  readonly changed: boolean;
  /** The next file content, or null when the file should be deleted. */
  readonly next: string | null;
}

export type OwnedRulesHarness = 'cursor' | 'windsurf';

const CURSOR_DESCRIPTION = 'Use mast (AST code search) before grep or reading files';
const OWNED_NOTICE = '<!-- Managed by `mast setup`; edits here are overwritten. Remove with `mast setup <harness> --remove`. -->';

/**
 * Cursor: project rules are `.mdc` files in `.cursor/rules`, and `alwaysApply: true`
 * applies the rule to every chat (Cursor's rules docs). Windsurf: `trigger: always_on`
 * (Windsurf's rules docs). Both are read from the vendors' docs, not exercised in the tool.
 */
export function renderOwnedRules(harness: OwnedRulesHarness, skillText: string): string {
  const frontmatter =
    harness === 'cursor'
      ? `---\ndescription: ${CURSOR_DESCRIPTION}\nalwaysApply: true\n---\n`
      : '---\ntrigger: always_on\n---\n';
  return `${frontmatter}\n${OWNED_NOTICE}\n\n${skillText.trimEnd()}\n`;
}

/**
 * A file mast owns outright. There is no marker to tell mast's file from someone else's
 * with the same name: `.mdc` frontmatter has no room for a comment line, so the whole file
 * is treated as mast's because of its name (`mast.mdc`, `mast.md`). Someone who hand-writes
 * a file at that exact path gets it overwritten; the name is the claim.
 */
export function planOwnedFile(existing: string | null, wanted: string, remove: boolean): TextPlan {
  if (remove) return { state: 'current', changed: existing !== null, next: null };
  if (existing === null) return { state: 'missing', changed: true, next: wanted };
  if (existing === wanted) return { state: 'current', changed: false, next: wanted };
  return { state: 'outdated', changed: true, next: wanted };
}

const hasBlock = (text: string): boolean => {
  const begin = text.indexOf(BEGIN_MARKER);
  return begin !== -1 && text.indexOf(END_MARKER) > begin;
};

function withoutBlock(text: string): string {
  const begin = text.indexOf(BEGIN_MARKER);
  const before = text.slice(0, begin).trimEnd();
  // Only blank lines are dropped after the block: leading spaces on the next line are content.
  const after = text.slice(text.indexOf(END_MARKER) + END_MARKER.length).replace(/^(?:[ \t]*\r?\n)+/, '');
  if (before === '') return after;
  return after === '' ? `${before}\n` : `${before}\n\n${after}`;
}

/** The marked block inside a file mast does not own (Zed's rules file). */
export function planMarkedBlock(existing: string, skillText: string, remove: boolean): TextPlan {
  const present = hasBlock(existing);
  if (remove) return { state: 'current', changed: present, next: present ? withoutBlock(existing) : existing };
  const next = spliceSkillBlock(existing, skillText);
  if (!present) return { state: 'missing', changed: true, next };
  return next === existing ? { state: 'current', changed: false, next } : { state: 'outdated', changed: true, next };
}

/**
 * Files Zed reads project rules from, first existing one wins. This list is from memory of
 * Zed's docs (zed.dev/docs/ai/instructions) and has NOT been verified against them:
 * re-check the names and their order before relying on it.
 */
export const ZED_RULES_FILES: readonly string[] = [
  '.rules', '.cursorrules', '.windsurfrules', '.clinerules', '.github/copilot-instructions.md',
  'AGENT.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md',
];

export function firstExisting(files: readonly string[], exists: (file: string) => boolean): string | null {
  return files.find(exists) ?? null;
}

export const cursorRulesPath = (root: string): string => join(root, '.cursor', 'rules', 'mast.mdc');

export const windsurfRulesPaths = (root: string): readonly string[] => [
  join(root, '.devin', 'rules', 'mast.md'),
  join(root, '.windsurf', 'rules', 'mast.md'),
];

/** `.devin/rules` when a `.devin` directory exists (Windsurf's docs now redirect to Devin), else `.windsurf/rules`. */
export function chooseWindsurfRulesPath(root: string, devinDirExists: boolean): string {
  const [devin, windsurf] = windsurfRulesPaths(root);
  return (devinDirExists ? devin : windsurf) ?? join(root, '.windsurf', 'rules', 'mast.md');
}
