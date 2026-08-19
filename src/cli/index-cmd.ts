import type { Command } from 'commander';
import { resolveConfig } from '../store/config.js';
import { runIndex } from '../indexer/index.js';
import { newWriteSpans } from '../graph/populate.js';
import { openDatabase, type OpenDatabaseOptions } from '../graph/db.js';
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

/**
 * Parse an operator-supplied MiB figure for the SQLite tuning flags.
 *
 * Commander yields raw strings, so this is a trust boundary (§3.2) — the value
 * is validated here and the pragma layer downstream receives only numbers it
 * can apply verbatim. Fractions are refused rather than truncated so that an
 * arm's declared size and its applied size are always the same number; a silent
 * truncation would put a measurement's own label out of step with what ran.
 *
 * Exported for direct testing: a spawn-based CLI test resolves against `dist/`
 * and would grade a different binary than the one under review (the D8 failure
 * mode), which is why `isPhaseTimingEnabled` above is exported for the same
 * reason.
 *
 * @throws Error naming the flag and the rejected value, if it is not a
 *   non-negative whole number.
 */
export function parseMebibytes(flag: string, raw: string): number {
  // Number('') is 0 — an empty value must be an error, not a silent zero.
  const value = raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `${flag} expects a non-negative whole number of MiB, received "${raw}"`,
    );
  }
  return value;
}

/**
 * Whether to print the applied-pragma line.
 *
 * Emitted when the operator tuned something (they should see what actually took
 * effect, not what they typed), and also under the phase-timing gate — which is
 * what gives the A/B's *control* arm, which passes no tuning flag at all, a
 * `pragmas:` line to be graded against. Without the second clause the one arm
 * whose "un-pragma'd" claim carries the most weight would be the one arm with
 * no evidence for it.
 *
 * Extracted for the same reason as {@link isPhaseTimingEnabled}: a spawn-based
 * test resolves against `dist/`, where a negative assertion passes trivially on
 * empty stdout.
 */
export function shouldPrintPragmas(
  phaseTimingEnabled: boolean,
  dbOptions: OpenDatabaseOptions,
): boolean {
  return phaseTimingEnabled || Object.keys(dbOptions).length > 0;
}

/**
 * Whether this run skips the per-file FTS5 deletes — E1-FTS's arm G.
 *
 * The skip is only sound on a **cold** build, where those deletes match zero
 * rows and the finished database is therefore identical to the control's. On an
 * incremental run they are load-bearing: skipping them leaves the previous
 * version's rows in `chunk_fts` / `identifier_fts` alongside the new ones while
 * the ordinary tables replace correctly, so the index goes silently wrong — no
 * error, no missing rows, just stale search hits.
 *
 * Refused here, at the trust boundary, rather than documented and hoped for.
 * It **throws** instead of falling back to the safe path, because an operator
 * who asked for arm G and quietly received arm A would collect a null and have
 * no way to tell.
 *
 * Exported for direct testing, same reason as {@link parseMebibytes}.
 *
 * @throws Error naming both flags, if the skip is combined with `--incremental`.
 */
export function resolveSkipFtsDeletes(
  flag: boolean | undefined,
  incremental: boolean,
): boolean {
  if (flag !== true) return false;
  if (incremental) {
    throw new Error(
      '--unsafe-skip-fts-deletes cannot be combined with --incremental: the FTS deletes are ' +
      'only redundant on a cold build. On an incremental run they are what removes the ' +
      'previous version\'s rows, and skipping them corrupts the index silently.',
    );
  }
  return true;
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
    .option(
      '--cache-size-mib <mib>',
      'SQLite page-cache budget for this run, in MiB (PRAGMA cache_size). Diagnostic lever for the ' +
      'E1-PHASE mechanism probe; omitted, SQLite\'s own default stands and nothing is set.',
    )
    .option(
      '--mmap-size-mib <mib>',
      'SQLite memory-map budget for this run, in MiB (PRAGMA mmap_size); 0 disables memory mapping. ' +
      'Diagnostic lever for the E1-PHASE mechanism probe; omitted, SQLite\'s own default stands.',
    )
    .option(
      '--unsafe-skip-fts-deletes',
      'EVAL ONLY — skip the per-file FTS5 delete statements. Sound ONLY on a cold build, where they ' +
      'match zero rows; on any other path this leaves stale FTS rows behind and corrupts the index ' +
      'silently, so it is refused with --incremental. E1-FTS arm G.',
    )
    .action(async (projectPath: string | undefined, opts: {
      stateDir?: string;
      incremental?: boolean;
      showProgress?: boolean;
      checker?: boolean;
      phaseTiming?: boolean;
      cacheSizeMib?: string;
      mmapSizeMib?: string;
      unsafeSkipFtsDeletes?: boolean;
    }) => {
      const config = resolveConfig({
        projectRoot: projectPath,
        stateDirOverride: opts.stateDir,
      });

      // Built with conditional spreads, not `{ cacheSizeKib: maybeUndefined }`:
      // `exactOptionalPropertyTypes` distinguishes an absent property from one
      // explicitly set to undefined, and the A/B's control arm depends on the
      // property being genuinely absent.
      const dbOptions: OpenDatabaseOptions = {
        ...(opts.cacheSizeMib !== undefined
          ? { cacheSizeKib: parseMebibytes('--cache-size-mib', opts.cacheSizeMib) * 1024 }
          : {}),
        ...(opts.mmapSizeMib !== undefined
          ? { mmapSizeBytes: parseMebibytes('--mmap-size-mib', opts.mmapSizeMib) * 1024 * 1024 }
          : {}),
      };

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

      const incremental = opts.incremental ?? false;
      const skipFtsDeletes = resolveSkipFtsDeletes(opts.unsafeSkipFtsDeletes, incremental);

      // Allocated only under the phase-timing gate, and passed only when
      // allocated: `populateFile` reads no clock at all without an accumulator,
      // so an ordinary `mast index` is untouched by this instrument.
      const writeSpans = isPhaseTimingEnabled(opts.phaseTiming) ? newWriteSpans() : undefined;

      if (skipFtsDeletes) {
        // Loud on stderr as well as refused above: this run's database is a
        // measurement artifact, and anyone reading the log later must be able
        // to tell it apart from a production index.
        process.stderr.write(
          '[mast] WARN: --unsafe-skip-fts-deletes is set — FTS5 delete statements are being ' +
          'skipped. This is an eval instrument (E1-FTS arm G) and is sound only because this ' +
          'is a cold build. Do NOT reuse this index.\n',
        );
      }

      const result = await runIndex(config, {
        incremental,
        onProgress,
        dbOptions,
        ...(writeSpans !== undefined ? { writeSpans } : {}),
        ...(skipFtsDeletes ? { unsafeSkipFtsDeletes: true } : {}),
      });

      process.stdout.write(
        `files: ${result.filesIndexed} indexed, ${result.filesSkipped} skipped` +
        `  chunks: +${result.chunksAdded} -${result.chunksRemoved}` +
        `  duration: ${result.durationMs}ms` +
        (result.parseErrors > 0 ? `  parse_errors: ${result.parseErrors}` : '') +
        (result.writeErrors > 0 ? `  write_errors: ${result.writeErrors}` : '') +
        (result.miscasedImports.count > 0 ? `  miscased_imports: ${result.miscasedImports.count}` : '') +
        '\n',
      );

      // A mis-cased import is a defect in the indexed repository, not in MAST:
      // it compiles on APFS/NTFS and fails on a case-sensitive filesystem. MAST
      // indexes it correctly regardless (the edge points at the on-disk file),
      // so this is advisory and does not affect the exit code. stderr, because
      // stdout carries the machine-readable summary above.
      if (result.miscasedImports.count > 0) {
        const { count, samples } = result.miscasedImports;
        process.stderr.write(
          `warning: ${count} import${count === 1 ? '' : 's'} resolved only because this ` +
          `filesystem ignores case; ${count === 1 ? 'it' : 'they'} will not resolve on a ` +
          `case-sensitive one:\n` +
          samples.map((m) => `  ${m.fromFile}: '${m.specifier}' -> ${m.onDiskPath}\n`).join('') +
          (count > samples.length ? `  ... and ${count - samples.length} more\n` : ''),
        );
      }

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

      // The write phase's own decomposition (E1-FTS). A separate line from
      // `phases:` on purpose — `phases:` is E1-PHASE's scored instrument and a
      // finished record must not sit behind a moving definition, which is the
      // same rule that gave E1-AB its own schedule module rather than an
      // extension of E1's.
      if (writeSpans !== undefined) {
        process.stdout.write(`write_spans: ${JSON.stringify(writeSpans)}\n`);
      }

      // The pragmas SQLite reported for this run's own connection, not an echo
      // of the flags. A flag that failed to reach the connection would make the
      // A/B's two arms identical and produce a clean, credible-looking null —
      // this line is what makes that failure visible instead.
      if (shouldPrintPragmas(isPhaseTimingEnabled(opts.phaseTiming), dbOptions)) {
        process.stdout.write(`pragmas: ${JSON.stringify(result.appliedPragmas)}\n`);
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
        // Same tuning as the index run above: a flag that applied to one half
        // of `mast index` and silently not the other would be a trap.
        const db = openDatabase(config.resolved_state_dir, dbOptions);
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
