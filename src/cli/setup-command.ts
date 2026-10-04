import type { Harness, HookEvent } from './hook.js';
import type { InstallKind } from './upgrade-cmd.js';

export type SetupScope = 'project' | 'global';

export interface HookCommandInput {
  readonly harness: Harness;
  readonly event: HookEvent;
  readonly installKind: InstallKind;
  readonly scope: SetupScope;
  /** Absolute path of this build's `cli/index.js`; used only for a source checkout. */
  readonly cliEntry: string;
}

export type HookCommandResult =
  | { readonly ok: true; readonly command: string }
  | { readonly ok: false; readonly problem: string };

// Claude Code expands this variable itself when it runs a project hook, so the spelling
// holds wherever the project is checked out. A template literal would interpolate it.
const CLAUDE_LOCAL_BIN = '"$' + '{CLAUDE_PROJECT_DIR}"/node_modules/.bin/mast';
const RELATIVE_LOCAL_BIN = 'node_modules/.bin/mast';

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
  const bin = input.harness === 'claude' ? CLAUDE_LOCAL_BIN : RELATIVE_LOCAL_BIN;
  return { ok: true, command: `${bin}${tail}` };
}

/** True when `command` is the one `setup` installs for this harness and event, in any spelling. */
export function isMastCommand(command: string | undefined, harness: Harness, event: HookEvent): boolean {
  return command !== undefined && command.endsWith(` hook ${harness} ${event}`);
}
