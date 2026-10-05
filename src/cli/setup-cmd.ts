import type { Command } from 'commander';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Harness, HookEvent } from './hook.js';
import { readDoc } from './docs-cmd.js';
import { buildHookCommand, hookFilePath, type SetupScope } from './setup-command.js';
import { HOOK_DEFS, planFor, type Commands, type PlanMode, type PlanResult } from './setup-plan.js';
import { runCursorRules, runStaticSetup, STATIC_HARNESSES } from './setup-static.js';
import { detectInstallKind, type InstallKind } from './upgrade-cmd.js';
import { PACKAGE_NAME } from './version.js';

/**
 * `mast setup <harness>` writes hook configuration and, for harnesses with a rules file
 * mast can own (or Zed's, via a marked block), that file too. It follows the rules
 * `skill-install.ts` states: touch nothing it does not own, and be a byte-level no-op on
 * re-run. Unlike `skill --install` it creates its file when absent, because a hook file
 * is tool configuration and not a hand-curated prompt (ADR 017 section 3).
 */

const HOOK_HARNESSES: readonly Harness[] = ['claude', 'cursor', 'vscode'];
const ALL_HARNESSES: readonly string[] = [...HOOK_HARNESSES, ...STATIC_HARNESSES];

export interface SetupOptions {
  readonly harness: string;
  readonly projectRoot: string;
  readonly global: boolean;
  readonly check: boolean;
  readonly remove: boolean;
  readonly dryRun: boolean;
}

/** Everything about the machine `setup` reads, injected so tests never touch the real home. */
export interface SetupEnv {
  readonly installKind: InstallKind;
  readonly home: string;
  readonly cliEntry: string;
  /** The text of `assets/skill.md`, which every rules file is rendered from. */
  readonly skillText: string;
}

export interface SetupIo {
  /** Null when the file does not exist. Throws on any other failure. */
  readFile(path: string): string | null;
  /** Creates parent directories. Must never leave a half-written file at `path`. */
  writeFileAtomic(path: string, content: string): void;
  removeFile(path: string): void;
  fileExists(path: string): boolean;
  directoryExists(path: string): boolean;
  out(line: string): void;
  err(line: string): void;
}

/** Re-emits `value` in the file's own indentation, line endings and trailing-newline state. */
function serialize(value: object, previous: string | null): string {
  const indent = previous === null ? '  ' : (/^([ \t]+)\S/m.exec(previous)?.[1] ?? '  ');
  const trailingNewline = previous === null || previous.endsWith('\n');
  let text = JSON.stringify(value, null, indent) + (trailingNewline ? '\n' : '');
  if (previous?.includes('\r\n')) text = text.replace(/\n/g, '\r\n');
  return text;
}

function parseJson(raw: string): { ok: true; value: unknown } | { ok: false; problem: string } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, problem: `not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
}

function buildCommands(harness: Harness, scope: SetupScope, env: SetupEnv): { ok: true; commands: Commands } | { ok: false; problem: string } {
  const commands: Partial<Record<HookEvent, string>> = {};
  for (const def of HOOK_DEFS[harness]) {
    const built = buildHookCommand({ harness, event: def.event, installKind: env.installKind, scope, cliEntry: env.cliEntry });
    if (!built.ok) return built;
    commands[def.event] = built.command;
  }
  return { ok: true, commands };
}

function notesFor(harness: Harness, scope: SetupScope, env: SetupEnv): string[] {
  const notes: string[] = [];
  if (harness === 'vscode') {
    notes.push(
      'Only the session primer is installed for VS Code. A search reminder is not: VS Code ignores hook matchers, ' +
        'so it would run on every tool call, and the name of its search tool is not documented.',
    );
  }
  if (env.installKind === 'source') {
    notes.push('The hook command contains a path specific to this machine; do not commit this file.');
  }
  if (env.installKind === 'local' && scope === 'project' && harness === 'vscode') {
    notes.push('The relative command node_modules/.bin/mast is unverified in VS Code: its docs do not say what directory hooks run in.');
  }
  return notes;
}

function describePlan(plan: Extract<PlanResult, { ok: true }>, existed: boolean, remove: boolean): string {
  if (remove) return plan.removedCount > 0 ? 'removed' : 'not installed';
  if (!plan.changed) return 'already up to date';
  return !existed || plan.items.every((i) => i.state === 'missing') ? 'installed' : 'updated';
}

function reportProblem(io: SetupIo, path: string, problem: string): void {
  io.err(`mast setup: cannot update ${path}: ${problem}.`);
  io.err('The file was left unchanged. Fix or delete it, then run the command again.');
}

/** Returns the process exit code: 0 done, 1 refused or failed, 2 usage error. */
export function runSetup(opts: SetupOptions, env: SetupEnv, io: SetupIo): number {
  const hookHarness = HOOK_HARNESSES.find((h) => h === opts.harness);
  const staticHarness = STATIC_HARNESSES.find((h) => h === opts.harness);
  if (hookHarness === undefined && staticHarness === undefined) {
    io.err(`mast setup: unknown harness "${opts.harness}". Supported: ${ALL_HARNESSES.join(', ')}.`);
    return 2;
  }
  if (opts.check && (opts.remove || opts.dryRun)) {
    io.err('mast setup: --check cannot be combined with --remove or --dry-run.');
    return 2;
  }
  if (staticHarness !== undefined) return runStaticSetup(staticHarness, opts, env, io);
  if (hookHarness === undefined) return 2;

  const hookCode = runHookSetup(hookHarness, opts, env, io);
  if (hookHarness !== 'cursor') return hookCode;
  // A failed hooks step stops the rules step, except under --check, which reports both.
  if (hookCode !== 0 && !opts.check) return hookCode;
  const rulesCode = runCursorRules(opts, env, io);
  return hookCode !== 0 ? hookCode : rulesCode;
}

function runHookSetup(harness: Harness, opts: SetupOptions, env: SetupEnv, io: SetupIo): number {
  const scope: SetupScope = opts.global ? 'global' : 'project';
  const path = hookFilePath(harness, scope, opts.projectRoot, env.home);

  let mode: PlanMode = { kind: 'remove' };
  if (!opts.remove) {
    const built = buildCommands(harness, scope, env);
    if (!built.ok) {
      io.err(`mast setup: ${built.problem}`);
      return 1;
    }
    if (env.installKind === 'local' && scope === 'project' && !io.fileExists(join(opts.projectRoot, 'node_modules', '.bin', 'mast'))) {
      io.err(`mast setup: ${join(opts.projectRoot, 'node_modules', '.bin', 'mast')} does not exist, so the hook command would not run. Install mast in this project (pnpm add -D ${PACKAGE_NAME}) or install it globally.`);
      return 1;
    }
    mode = { kind: 'install', commands: built.commands };
  }

  try {
    const raw = io.readFile(path);
    let existing: unknown = null;
    if (raw !== null) {
      const parsed = parseJson(raw);
      if (!parsed.ok) {
        reportProblem(io, path, parsed.problem);
        return 1;
      }
      existing = parsed.value;
    }
    const plan = planFor(harness, existing, mode);
    if (!plan.ok) {
      reportProblem(io, path, plan.problem);
      return 1;
    }

    if (opts.check) {
      const stale = plan.items.filter((i) => i.state !== 'current');
      if (stale.length === 0) {
        io.out(`${path}: already up to date`);
        return 0;
      }
      // A settings file that exists but holds none of mast's hooks is "not installed",
      // the same as no file: "out of date" would send someone looking for a stale entry.
      io.out(`${path}: ${stale.length === plan.items.length && stale.every((i) => i.state === 'missing') ? 'not installed' : 'out of date'}`);
      for (const item of stale) io.out(`  ${item.state === 'missing' ? 'missing' : 'out of date'}: ${item.label}`);
      return 1;
    }

    const status = describePlan(plan, raw !== null, opts.remove);
    const willWrite = plan.changed;
    if (opts.dryRun) {
      io.out(`${path}: ${status} (dry run, nothing written)`);
      if (willWrite) io.out(plan.next === null ? '(the file would be deleted)' : serialize(plan.next, raw).trimEnd());
    } else {
      if (willWrite) {
        if (plan.next === null) io.removeFile(path);
        else io.writeFileAtomic(path, serialize(plan.next, raw));
      }
      io.out(`${path}: ${status}`);
    }
    if (!opts.remove) for (const note of notesFor(harness, scope, env)) io.out(`Note: ${note}`);
    return 0;
  } catch (error) {
    io.err(`mast setup: ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export function createNodeSetupIo(): SetupIo {
  return {
    readFile: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
    writeFileAtomic: (path, content) => {
      // Resolve a symlinked settings file first, or the rename would replace the link
      // (a dotfiles checkout, say) with a regular file.
      const target = existsSync(path) ? realpathSync(path) : path;
      mkdirSync(dirname(target), { recursive: true });
      // Same directory, so the rename cannot cross a filesystem and stays atomic.
      const temp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
      writeFileSync(temp, content);
      if (existsSync(target)) chmodSync(temp, statSync(target).mode & 0o777);
      renameSync(temp, target);
    },
    removeFile: (path) => { rmSync(path); },
    fileExists: existsSync,
    directoryExists: (path) => existsSync(path) && statSync(path).isDirectory(),
    out: (line) => { process.stdout.write(`${line}\n`); },
    err: (line) => { process.stderr.write(`${line}\n`); },
  };
}

export function registerSetupCommand(program: Command): void {
  program
    .command('setup <harness> [path]')
    .description('Install the hooks and rules files that tell an agent to use mast (claude|cursor|vscode|windsurf|zed|desktop)')
    .option('--global', 'Write the user-level file instead of the project one')
    .option('--check', 'Write nothing; exit 0 only if everything is installed and current')
    .option('--remove', 'Remove what mast installed')
    .option('--dry-run', 'Print the file that would be written, and write nothing')
    .action((harness: string, path: string | undefined, opts: { global?: boolean; check?: boolean; remove?: boolean; dryRun?: boolean }) => {
      const projectRoot = resolve(path ?? '.');
      const moduleDir = dirname(fileURLToPath(import.meta.url));
      // The home directory is resolved here, at the edge, and nowhere below.
      process.exitCode = runSetup(
        { harness, projectRoot, global: opts.global === true, check: opts.check === true, remove: opts.remove === true, dryRun: opts.dryRun === true },
        { installKind: detectInstallKind(moduleDir, projectRoot), home: homedir(), cliEntry: join(moduleDir, 'index.js'), skillText: readDoc('skill') },
        createNodeSetupIo(),
      );
    });
}
