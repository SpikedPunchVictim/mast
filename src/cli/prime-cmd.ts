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
  if (!status.index_fresh) health.push(...describeDrift(status));

  return rules.trimEnd() + '\n\n' + health.join('\n') + '\n';
}

/** How many paths of each category the primer names. It is read every session, so it stays short. */
const PRIMER_PATHS_PER_CATEGORY = 3;

/**
 * What a stale index means for the session, scoped to the files it affects.
 *
 * The earlier text was one line, "Call mast_reindex before relying on mast
 * results", for any non-zero count. An agent that read it against a count of
 * 116 stopped using mast, although none of the files it was working on were
 * among them. So this says how much of the index is affected, names the files,
 * and asks for a reindex only for the two categories mast cannot correct while
 * answering: a changed file is re-parsed or flagged on read, an unindexed or
 * deleted one is not.
 */
function describeDrift(status: StatusReport): string[] {
  const counts = status.stale_breakdown;
  const paths = status.stale_paths;
  const lines = [
    `The index is behind on ${String(status.stale_files ?? 0)} of ${String(status.indexed_files ?? 0)} files. ` +
    'Results for every other file are current, so keep using mast.',
  ];
  if (counts === null || paths === null) return lines;

  const named = (kind: 'changed' | 'unindexed' | 'deleted'): string => {
    const shown = paths[kind].slice(0, PRIMER_PATHS_PER_CATEGORY);
    const omitted = counts[kind] - shown.length;
    return shown.join(', ') + (omitted > 0 ? ` and ${String(omitted)} more` : '');
  };
  if (counts.changed > 0) {
    lines.push(
      `Changed since indexing (${String(counts.changed)}): ${named('changed')}. ` +
      'mast re-parses one of these when you query it by file or symbol, and marks a search result from one `stale`.',
    );
  }
  if (counts.unindexed > 0) {
    lines.push(`Not indexed (${String(counts.unindexed)}): ${named('unindexed')}. mast cannot see these.`);
  }
  if (counts.deleted > 0) {
    lines.push(`Indexed but gone from disk (${String(counts.deleted)}): ${named('deleted')}.`);
  }
  if (counts.unindexed > 0 || counts.deleted > 0) {
    lines.push('Call mast_reindex to bring those in; it only processes files that differ. `mast status` lists them all.');
  }
  return lines;
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
