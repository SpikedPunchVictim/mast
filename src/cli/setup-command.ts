import type { Harness, HookEvent } from './hook.js';
import { join, relative, isAbsolute, sep } from 'node:path';
import type { InstallKind } from './upgrade-cmd.js';

export type SetupScope = 'project' | 'global';

export interface HookCommandInput {
  readonly harness: Harness;
  readonly event: HookEvent;
  readonly installKind: InstallKind;
  readonly scope: SetupScope;
  /** Absolute path of this build's `cli/index.js`; used only for a source checkout. */
  readonly cliEntry: string;
  /**
   * Where a project dependency's binary is, relative to the project root with forward
   * slashes. Defaults to the root's own `node_modules/.bin/mast`.
   */
  readonly localBin?: string;
}

export type HookCommandResult =
  | { readonly ok: true; readonly command: string }
  | { readonly ok: false; readonly problem: string };

/** The hook file `setup` writes for a harness: project-level, or under the user's home. */
export function hookFilePath(harness: Harness, scope: SetupScope, projectRoot: string, home: string): string {
  const base = scope === 'global' ? home : projectRoot;
  if (harness === 'claude') return join(base, '.claude', 'settings.json');
  if (harness === 'cursor') return join(base, '.cursor', 'hooks.json');
  return scope === 'global' ? join(home, '.copilot', 'hooks', 'mast.json') : join(projectRoot, '.github', 'hooks', 'mast.json');
}

// Claude Code expands this variable itself when it runs a project hook, so the spelling
// holds wherever the project is checked out. A template literal would interpolate it.
const CLAUDE_PROJECT_DIR = '$' + '{CLAUDE_PROJECT_DIR}';
const ROOT_LOCAL_BIN = 'node_modules/.bin/mast';

/**
 * Where a project dependency's `mast` binary can be, most likely first, relative to the
 * project root with forward slashes: beside each `node_modules` this build is running
 * out of (outermost first), then the project root's own.
 *
 * The root is not the only place (D070): a project whose package lives in a
 * subdirectory has `<sub>/node_modules/.bin/mast` and nothing at the root. The root
 * stays as the last candidate for a build that runs from outside the project.
 */
export function localBinCandidates(cliEntry: string, projectRoot: string): string[] {
  const rel = relative(projectRoot, cliEntry);
  const segments = rel.startsWith('..') || isAbsolute(rel) ? [] : rel.split(sep);
  const candidates: string[] = [];
  segments.forEach((segment, index) => {
    if (segment === 'node_modules') candidates.push([...segments.slice(0, index + 1), '.bin', 'mast'].join('/'));
  });
  if (!candidates.includes(ROOT_LOCAL_BIN)) candidates.push(ROOT_LOCAL_BIN);
  return candidates;
}

// A path made only of these needs no quoting in a POSIX shell. The plain spelling is
// kept for them so a file written by 0.4.0 still compares as current.
const SHELL_SAFE = /^[A-Za-z0-9_@+.\/-]+$/;

function escapeForDoubleQuotes(text: string): string {
  return text.replace(/["\\$`]/g, (ch) => `\\${ch}`);
}

function localCommand(harness: Harness, localBin: string): string {
  if (SHELL_SAFE.test(localBin)) {
    return harness === 'claude' ? `"${CLAUDE_PROJECT_DIR}"/${localBin}` : localBin;
  }
  const quoted = escapeForDoubleQuotes(localBin);
  return harness === 'claude' ? `"${CLAUDE_PROJECT_DIR}/${quoted}"` : `"${quoted}"`;
}

/**
 * The command line a harness runs for one hook. Every spelling ends in
 * ` hook <harness> <event>`: `setup` finds its own entries by that suffix, so the part
 * before it can change between installs without orphaning the old entry.
 *
 * A project-dependency install cannot be written into user-level settings: the path
 * points into one project's node_modules and fails in every other project.
 */
export function buildHookCommand(input: HookCommandInput): HookCommandResult {
  const tail = ` hook ${input.harness} ${input.event}`;
  if (input.installKind === 'global') return { ok: true, command: `mast${tail}` };
  if (input.installKind === 'source') return { ok: true, command: `node "${input.cliEntry}"${tail}` };
  if (input.scope === 'global') {
    return {
      ok: false,
      problem:
        'this mast is a project dependency, and a user-level hook that points into one project\'s node_modules ' +
        'breaks in every other project. Install mast globally, or run without --global.',
    };
  }
  return { ok: true, command: `${localCommand(input.harness, input.localBin ?? ROOT_LOCAL_BIN)}${tail}` };
}

/** True when `command` is the one `setup` installs for this harness and event, in any spelling. */
export function isMastCommand(command: string | undefined, harness: Harness, event: HookEvent): boolean {
  return command !== undefined && command.endsWith(` hook ${harness} ${event}`);
}
