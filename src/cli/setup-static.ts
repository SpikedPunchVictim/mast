import { join } from 'node:path';
import type { SetupEnv, SetupIo, SetupOptions } from './setup-cmd.js';
import {
  chooseWindsurfRulesPath, cursorRulesPath, firstExisting, planMarkedBlock, planOwnedFile,
  renderOwnedRules, windsurfRulesPaths, ZED_RULES_FILES, type TextPlan,
} from './setup-rules.js';

/**
 * The static channel of `mast setup` (ADR 017 sections 2 and 6): rules files, for harnesses
 * with no usable hook system and, for Cursor, alongside its hooks. The planners are pure
 * (`setup-rules.ts`); this file is the shell around them, with every read and write injected.
 */

export type StaticHarness = 'windsurf' | 'zed' | 'desktop';
export const STATIC_HARNESSES: readonly StaticHarness[] = ['windsurf', 'zed', 'desktop'];

type Flags = Pick<SetupOptions, 'check' | 'remove' | 'dryRun'>;

const HARNESS_NAMES: Readonly<Record<StaticHarness, string>> = {
  windsurf: 'Windsurf',
  zed: 'Zed',
  desktop: 'Claude Desktop',
};

/** One output line for the file, in stage 4's vocabulary, and the write that goes with it. */
function applyTextTarget(io: SetupIo, path: string, plan: TextPlan, flags: Flags, showContent: boolean): number {
  if (flags.check) {
    if (plan.state === 'current' && !plan.changed) {
      io.out(`${path}: already up to date`);
      return 0;
    }
    io.out(`${path}: ${plan.state === 'missing' ? 'not installed' : 'out of date'}`);
    return 1;
  }
  const status = flags.remove
    ? plan.changed ? 'removed' : 'not installed'
    : !plan.changed ? 'already up to date' : plan.state === 'missing' ? 'installed' : 'updated';
  if (flags.dryRun) {
    io.out(`${path}: ${status} (dry run, nothing written)`);
    if (plan.changed && showContent) io.out(plan.next === null ? '(the file would be deleted)' : plan.next.trimEnd());
    return 0;
  }
  if (plan.changed) {
    if (plan.next === null) io.removeFile(path);
    else io.writeFileAtomic(path, plan.next);
  }
  io.out(`${path}: ${status}`);
  return 0;
}

function runOwnedFile(io: SetupIo, path: string, wanted: string, flags: Flags): number {
  return applyTextTarget(io, path, planOwnedFile(io.readFile(path), wanted, flags.remove), flags, true);
}

function guarded(io: SetupIo, where: string, work: () => number): number {
  try {
    return work();
  } catch (error) {
    io.err(`mast setup: ${where}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** Cursor's `.cursor/rules/mast.mdc`, project scope only. */
export function runCursorRules(opts: SetupOptions, env: SetupEnv, io: SetupIo): number {
  if (opts.global) {
    if (!opts.remove) io.out('Note: Cursor has no user-level rules file, so --global handled the hooks only.');
    return 0;
  }
  const path = cursorRulesPath(opts.projectRoot);
  return guarded(io, path, () => runOwnedFile(io, path, renderOwnedRules('cursor', env.skillText), opts));
}

function runWindsurf(opts: SetupOptions, env: SetupEnv, io: SetupIo): number {
  const chosen = chooseWindsurfRulesPath(opts.projectRoot, io.directoryExists(join(opts.projectRoot, '.devin')));
  if (!opts.remove) return runOwnedFile(io, chosen, renderOwnedRules('windsurf', env.skillText), opts);
  // Removal sweeps both locations: the `.devin` directory may have appeared after install.
  const present = windsurfRulesPaths(opts.projectRoot).filter((p) => io.readFile(p) !== null);
  if (present.length === 0) return runOwnedFile(io, chosen, '', opts);
  return Math.max(...present.map((p) => runOwnedFile(io, p, '', opts)));
}

function runZed(opts: SetupOptions, env: SetupEnv, io: SetupIo): number {
  const exists = (rel: string): boolean => io.fileExists(join(opts.projectRoot, rel));
  if (opts.remove) {
    // Every candidate is swept, not just the first: the block may sit in a file that is no
    // longer the first one Zed reads, because someone created `.rules` after install.
    let touched = 0;
    let code = 0;
    for (const rel of ZED_RULES_FILES.filter(exists)) {
      const path = join(opts.projectRoot, rel);
      const plan = planMarkedBlock(io.readFile(path) ?? '', env.skillText, true);
      if (!plan.changed) continue;
      touched += 1;
      code = Math.max(code, applyTextTarget(io, path, plan, opts, false));
    }
    if (touched === 0) io.out(`${opts.projectRoot}: not installed (no mast block in any Zed rules file)`);
    return code;
  }
  const rel = firstExisting(ZED_RULES_FILES, exists);
  if (rel === null) {
    if (opts.check) {
      io.out(`${opts.projectRoot}: not installed (no Zed rules file found)`);
    } else {
      io.err(
        `mast setup: no Zed rules file found in ${opts.projectRoot}. mast does not create one, because a rules file is a prompt you curate. ` +
          'Create .rules and run `mast setup zed` again.',
      );
    }
    return 1;
  }
  const path = join(opts.projectRoot, rel);
  return applyTextTarget(io, path, planMarkedBlock(io.readFile(path) ?? '', env.skillText, false), opts, false);
}

/** Returns the process exit code: 0 done, 1 refused or failed. */
export function runStaticSetup(harness: StaticHarness, opts: SetupOptions, env: SetupEnv, io: SetupIo): number {
  if (harness === 'desktop') {
    io.out(`${HARNESS_NAMES[harness]} has no hook system mast can use, so only static instructions apply.`);
    io.out('Its only channel is the instructions string `mast serve` sends in the MCP handshake. That needs no setup, and nothing was written.');
    return 0;
  }
  io.out(`${HARNESS_NAMES[harness]} has no hook system mast can use, so only static instructions are installed.`);
  if (opts.global) {
    io.err(`mast setup: no user-level rules file is supported for ${harness}. Run without --global, from the project root.`);
    return 1;
  }
  return guarded(io, opts.projectRoot, () => (harness === 'windsurf' ? runWindsurf(opts, env, io) : runZed(opts, env, io)));
}
