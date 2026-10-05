import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Harness } from './hook.js';
import { hookFilePath } from './setup-command.js';
import { cursorRulesPath, windsurfRulesPaths, ZED_RULES_FILES } from './setup-rules.js';
import { BEGIN_MARKER, SKILL_TARGET_FILES } from './skill-install.js';

/**
 * What of mast's own writing `mast upgrade` found installed, so it can say what to re-check
 * after upgrading. `mast upgrade` runs on the OLD binary and cannot know what a newer
 * version's files should contain; it can only know that they exist.
 */
export interface InstalledArtifacts {
  /** Harnesses whose project-level hook file holds a mast hook command. */
  readonly projectHooks: readonly Harness[];
  /** Harnesses whose user-level hook file holds a mast hook command. */
  readonly globalHooks: readonly Harness[];
  /** Harnesses with a mast-owned rules file in the project. */
  readonly rulesHarnesses: readonly ('cursor' | 'windsurf')[];
  /** Zed rules files, outside the `mast skill --install` set, that carry the marked block. */
  readonly zedOnlyBlockFiles: readonly string[];
  /** Files `mast skill --install` reaches that carry the marked block. */
  readonly skillBlockFiles: readonly string[];
}

export const NO_INSTALLED_ARTIFACTS: InstalledArtifacts = {
  projectHooks: [], globalHooks: [], rulesHarnesses: [], zedOnlyBlockFiles: [], skillBlockFiles: [],
};

const HOOK_HARNESSES: readonly Harness[] = ['claude', 'cursor', 'vscode'];

/** Null for a file that is absent or unreadable: an advisory scan cannot fail `mast upgrade`. */
export function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// A plain substring test on the raw text, not a JSON parse: a file that does not parse is
// still worth a `--check`, which will report the parse problem itself.
const hasMastHook = (text: string | null, harness: Harness): boolean =>
  text !== null && (text.includes(` hook ${harness} session-start`) || text.includes(` hook ${harness} search`));

export function findInstalledArtifacts(
  projectRoot: string,
  home: string,
  readFile: (path: string) => string | null,
): InstalledArtifacts {
  const hooksIn = (scope: 'project' | 'global'): Harness[] =>
    HOOK_HARNESSES.filter((h) => hasMastHook(readFile(hookFilePath(h, scope, projectRoot, home)), h));
  const present = (path: string): boolean => readFile(path) !== null;
  const carriesBlock = (rel: string): boolean => readFile(join(projectRoot, rel))?.includes(BEGIN_MARKER) === true;

  const rulesHarnesses: ('cursor' | 'windsurf')[] = [];
  if (present(cursorRulesPath(projectRoot))) rulesHarnesses.push('cursor');
  if (windsurfRulesPaths(projectRoot).some(present)) rulesHarnesses.push('windsurf');

  return {
    projectHooks: hooksIn('project'),
    globalHooks: hooksIn('global'),
    rulesHarnesses,
    zedOnlyBlockFiles: ZED_RULES_FILES.filter((f) => !SKILL_TARGET_FILES.includes(f) && carriesBlock(f)),
    skillBlockFiles: SKILL_TARGET_FILES.filter(carriesBlock),
  };
}
