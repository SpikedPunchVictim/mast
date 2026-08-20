import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `mast skill --install` — splices the MAST instructions into a project's agent config.
 *
 * Two rules shape this, both about not surprising someone. It writes only into files that
 * ALREADY exist — creating a `CLAUDE.md` in a repo that deliberately has none is not a
 * decision this tool gets to make. And it writes inside a marked block, so re-running
 * after an upgrade replaces the previous copy instead of appending a second one; two
 * copies of the skill in a prompt is worse than none, because after the next upgrade they
 * disagree with each other.
 *
 * It is never automatic. `mast skill` prints; `--install` writes, and `--dry-run` shows
 * exactly what would change first. These files are hand-curated and committed, and a tool
 * that edits them uninvited is a tool that turns up in someone's `git diff` unannounced.
 */

export const BEGIN_MARKER = '<!-- BEGIN mast skill — managed by `mast skill --install`, edits here are overwritten -->';
export const END_MARKER = '<!-- END mast skill -->';

export interface SkillTarget {
  /** Path relative to the project root, as displayed. */
  readonly file: string;
  /** Absolute path. */
  readonly path: string;
  /** The agent this file configures, for the confirmation line. */
  readonly agent: string;
}

const CANDIDATES: readonly { file: string; agent: string }[] = [
  { file: 'CLAUDE.md',                        agent: 'Claude Code / Claude Desktop' },
  { file: 'AGENTS.md',                        agent: 'Codex and other AGENTS.md readers' },
  { file: '.cursorrules',                     agent: 'Cursor' },
  { file: '.windsurfrules',                   agent: 'Windsurf' },
  { file: '.github/copilot-instructions.md',  agent: 'GitHub Copilot' },
];

/** Agent config files that exist in this project. Never invents one. */
export function detectSkillTargets(projectRoot: string): readonly SkillTarget[] {
  return CANDIDATES
    .map((c) => ({ ...c, path: join(projectRoot, c.file) }))
    .filter((c) => existsSync(c.path));
}

/**
 * Inserts or replaces the managed block. Returns the content unchanged when the block is
 * already present and identical, so a re-run is a genuine no-op rather than a whitespace diff.
 */
export function spliceSkillBlock(existing: string, skillText: string): string {
  const block = `${BEGIN_MARKER}\n\n${skillText.trimEnd()}\n\n${END_MARKER}`;
  const begin = existing.indexOf(BEGIN_MARKER);
  const end = existing.indexOf(END_MARKER);

  if (begin !== -1 && end !== -1 && end > begin) {
    const replaced = existing.slice(0, begin) + block + existing.slice(end + END_MARKER.length);
    return replaced === existing ? existing : replaced;
  }
  const base = existing.trimEnd();
  return base === '' ? block + '\n' : `${base}\n\n${block}\n`;
}

export interface InstallOutcome {
  readonly target: SkillTarget;
  readonly changed: boolean;
}

export function installSkillInto(
  targets: readonly SkillTarget[],
  skillText: string,
  options: { dryRun?: boolean } = {},
): readonly InstallOutcome[] {
  return targets.map((target) => {
    const before = existsSync(target.path) ? readFileSync(target.path, 'utf8') : '';
    const after = spliceSkillBlock(before, skillText);
    const changed = after !== before;
    if (changed && options.dryRun !== true) writeFileSync(target.path, after);
    return { target, changed };
  });
}
