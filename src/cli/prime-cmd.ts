import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { buildStatus, type StatusReport } from './status.js';
import { PACKAGE_ROOT } from './docs-cmd.js';

/** Absolute path of the shipped rules text; `assets` is in the package's `files`. */
export const PRIME_ASSET_PATH = join(PACKAGE_ROOT, 'assets', 'prime.md');

/**
 * Renders the session primer for one of four index states.
 *
 * The rules are printed only when the index can be trusted to answer (fresh, or
 * stale with a reindex instruction). Telling a model to use an index that does not
 * exist, or one that describes a different tree, teaches it to ignore the primer,
 * so those two states say what is wrong instead.
 *
 * Pure: `now` is a parameter so the age line is deterministic.
 */
export function renderPrime(status: StatusReport, rules: string, now: Date): string {
  if (!status.initialised) {
    return [
      `mast has no index at ${status.state_dir}.`,
      'Use ordinary search tools (grep, glob, reading files) here.',
      'Run `mast init` in the project to create an index.',
    ].join('\n') + '\n';
  }

  if (status.freshness_cause === 'root_mismatch') {
    return [
      `The mast index at ${status.state_dir} describes a different tree than ${status.project_root}.`,
      'mast results here cannot be trusted, and reindexing will not fix it.',
      'Use ordinary search tools, and check the project path and --state-dir.',
    ].join('\n') + '\n';
  }

  const health = [
    `mast index: ${String(status.indexed_files ?? 0)} files, last indexed ${describeAge(status.last_indexed, now)}.`,
  ];
  if (!status.index_fresh) {
    const b = status.stale_breakdown;
    const split = b === null
      ? ''
      : ` (changed ${String(b.changed)}, unindexed ${String(b.unindexed)}, deleted ${String(b.deleted)})`;
    health.push(
      `The index is stale: ${String(status.stale_files ?? 0)} files differ from disk${split}.`,
      'Call mast_reindex before relying on mast results.',
    );
  }

  return rules.trimEnd() + '\n\n' + health.join('\n') + '\n';
}

function describeAge(lastIndexed: string | null, now: Date): string {
  if (lastIndexed === null) return 'never';
  const seconds = Math.max(0, Math.floor((now.getTime() - new Date(lastIndexed).getTime()) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function registerPrimeCommand(program: Command): void {
  program
    .command('prime [path]')
    .description('Print the session primer: how to use mast here, and the live index health')
    .option('--state-dir <dir>', 'State directory')
    .action(async (projectPath: string | undefined, opts: { stateDir?: string }) => {
      // Exit 0 in every state, unlike `mast status`: this runs from a session-start
      // hook, where a non-zero exit is a failure the user sees. "No index" is a
      // state the primer reports in its text, not an error of the command.
      const status = await buildStatus({ path: projectPath, stateDir: opts.stateDir });
      const rules = readFileSync(PRIME_ASSET_PATH, 'utf8');
      process.stdout.write(renderPrime(status, rules, new Date()));
    });
}
