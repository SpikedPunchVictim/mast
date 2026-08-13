import type { Command } from 'commander';
import { resolveConfig } from '../store/config.js';
import { runIndex } from '../indexer/index.js';
import { openDatabase } from '../graph/db.js';
import { SqliteChunkStore } from '../store/sqliteChunkStore.js';
import { runCheckerPass } from '../graph/checker-resolver.js';

/**
 * Whether to print the per-phase breakdown.
 *
 * Extracted rather than inlined in the action so the gate is testable without spawning the
 * built CLI: a spawn-based test resolves against `dist/`, and a negative assertion
 * ("stdout does not contain phases:") passes trivially when the spawn produces no output at
 * all. That false green is the D8 failure mode in miniature.
 *
 * This is the first environment flag in the codebase and so sets the convention:
 * `ENABLE_`-prefixed, and the value is the word `true` or `false`, never `1`/`0`. Compared
 * case-insensitively after trimming, because env vars are typed by hand. Anything that is
 * not `true` is off, so a typo fails closed rather than silently switching instrumentation
 * on in an ordinary run.
 */
export function isPhaseTimingEnabled(
  flag: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (flag === true) return true;
  return env.ENABLE_MAST_PHASE_TIMING?.trim().toLowerCase() === 'true';
}

export function registerIndexCommand(program: Command): void {
  program
    .command('index [path]')
    .description('Build or update the index')
    .option('--state-dir <dir>', 'State directory (resolved from config if omitted)')
    .option('--incremental', 'Only reindex files changed since last index run')
    .option('--show-progress', 'Print indexing progress to stderr')
    .option(
      '--checker',
      'Opt-in TypeScript-checker pass (Stage 1.2): upgrade heuristic potential_matches into verified edges ' +
      'or drop non-call-site/wrong-declaration noise. Holds one ts.Program at a time; can take tens of seconds ' +
      'on a large monorepo — not part of the default index path (MAST_SPEC §10.3.2).',
    )
    .option(
      '--phase-timing',
      'Print a machine-readable per-phase breakdown of the index run (walk/parse/write/edges/finalise). ' +
      'Also enabled by ENABLE_MAST_PHASE_TIMING=true. The timers themselves always run — this only ' +
      'controls the output line — so enabling it costs nothing but a line of stdout.',
    )
    .action(async (projectPath: string | undefined, opts: {
      stateDir?: string;
      incremental?: boolean;
      showProgress?: boolean;
      checker?: boolean;
      phaseTiming?: boolean;
    }) => {
      const config = resolveConfig({
        projectRoot: projectPath,
        stateDirOverride: opts.stateDir,
      });

      const onProgress = opts.showProgress
        ? (processed: number, total: number) => {
            if (total === 0) return;
            const pct = Math.round((processed / total) * 100);
            const line = `  indexing ${processed}/${total} files (${pct}%)`;
            // \r rewrites the line in place on a TTY; fall back to newlines otherwise.
            process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
            if (processed === total && process.stderr.isTTY) process.stderr.write('\n');
          }
        : undefined;

      const result = await runIndex(config, { incremental: opts.incremental ?? false, onProgress });

      process.stdout.write(
        `files: ${result.filesIndexed} indexed, ${result.filesSkipped} skipped` +
        `  chunks: +${result.chunksAdded} -${result.chunksRemoved}` +
        `  duration: ${result.durationMs}ms` +
        (result.parseErrors > 0 ? `  parse_errors: ${result.parseErrors}` : '') +
        (result.writeErrors > 0 ? `  write_errors: ${result.writeErrors}` : '') +
        '\n',
      );

      // Machine-readable phase breakdown, opt-in. E1 measured a growth exponent of ~1.75
      // from `duration` alone and could not say which phase carried it; the scaling harness
      // parses this line to decompose the next ladder.
      //
      // Gated because it is instrumentation, not a user-facing summary, and an unconditional
      // extra stdout line changes the CLI's output contract for everyone. The env var exists
      // so a harness that spawns the shipped binary can enable it without every call site
      // growing an argument — read HERE, at the CLI boundary, and never inside the indexer.
      if (isPhaseTimingEnabled(opts.phaseTiming)) {
        process.stdout.write(`phases: ${JSON.stringify(result.phaseMs)}\n`);
      }

      // Non-zero exit so CI/scripts catch a silently-amputated file — a
      // chunk-store write failure must be impossible to miss, not just a
      // console line a human happens to read (GITNEXUS_COMPARISON.md §16).
      // `exitCode` (not `process.exit()`) lets stdout/stderr flush and any
      // later steps in this action (Phase 2 embed, checker pass) still run.
      if (result.writeErrors > 0) process.exitCode = 1;

      // Opt-in Stage 1.2 checker pass — runs after Phase 1 (parse/chunk/graph/
      // FTS is all there is post-Stage-7.1) so it classifies against the
      // freshest graph.db this invocation just wrote. Opens its own db handle
      // (chunkStore wraps it, §15.1) and destroys it itself (runIndex already
      // closed its own), matching the one-shot-process pattern this command
      // already used for the now-removed Phase 2 embed step.
      if (opts.checker) {
        const db = openDatabase(config.resolved_state_dir);
        const chunkStore = new SqliteChunkStore(db);
        try {
          const checkerResult = await runCheckerPass(db, chunkStore, config, {
            onProject: opts.showProgress
              ? (configDir: string, index: number, total: number) => {
                  const line = `  checker ${index}/${total}: ${configDir}`;
                  process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
                }
              : undefined,
          });
          if (opts.showProgress && process.stderr.isTTY) process.stderr.write('\n');

          // No silent caps: every project the pass skipped is named, not just counted.
          for (const skip of checkerResult.projectsSkipped) {
            process.stderr.write(`[mast] checker: skipped ${skip.configDir} (${skip.reason})\n`);
          }

          process.stdout.write(
            `checker: ${checkerResult.projectsChecked} project(s) checked, ${checkerResult.projectsSkipped.length} skipped` +
            `  symbols_checked: ${checkerResult.symbolsChecked}` +
            `  outside_ts_scope: ${checkerResult.potentialSitesOutsideScope}\n` +
            `  edges_upgraded: ${checkerResult.edgesUpgraded}` +
            `  non_call_site: ${checkerResult.classifiedNonCallSite}` +
            `  different_declaration: ${checkerResult.classifiedDifferentDeclaration}` +
            `  unresolved: ${checkerResult.unresolved}\n` +
            `  duration: ${checkerResult.durationMs}ms` +
            `  peak_rss_mb: ${Math.round(checkerResult.peakRssBytes / (1024 * 1024))}\n`,
          );
        } finally {
          await db.destroy();
        }
      }
    });
}
