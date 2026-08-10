import type { Command } from 'commander';
import { resolveConfig } from '../store/config.js';
import { openDatabase } from '../graph/db.js';
import {
  queryMetricsSummaryWithPercentiles,
  rollupMetrics,
  vacuumMetrics,
  type MetricsSummaryWithPercentiles,
} from '../telemetry/metrics.js';
import { TOKENIZER_LABEL } from '../telemetry/tokenizer.js';
import {
  readLockMetricsSummary,
  type LockCallerSummary,
  type LockMetricsSummary,
} from '../telemetry/lockMetricsSummary.js';

// ---------------------------------------------------------------------------
// Duration string parser  ("7d", "24h", "30m")
// ---------------------------------------------------------------------------

function parseSince(value: string): number {
  const match = /^(\d+)([dhm])$/.exec(value);
  if (match === null) {
    throw new Error(`Invalid --since value "${value}". Expected format: 7d, 24h, 30m`);
  }
  const n = match[1]!;
  const unit = match[2]!;
  const multipliers: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000 };
  return Number(n) * multipliers[unit]!;
}

// ---------------------------------------------------------------------------
// Table printer — per-tool efficiency (with D6's p50/p95 duration columns)
// ---------------------------------------------------------------------------

function printTable(rows: readonly MetricsSummaryWithPercentiles[]): void {
  if (rows.length === 0) {
    process.stdout.write('No metrics recorded in the requested window.\n');
    return;
  }

  const header = ['Tool', 'Calls', 'Tokens', 'Avg ms', 'p50 ms', 'p95 ms', 'Efficiency'];
  const widths = [
    Math.max(header[0]!.length, ...rows.map((r) => r.tool_name.length)),
    Math.max(header[1]!.length, ...rows.map((r) => String(r.calls).length)),
    Math.max(header[2]!.length, ...rows.map((r) => String(r.tokens_returned_total).length)),
    Math.max(header[3]!.length, ...rows.map((r) => r.avg_duration_ms.toFixed(1).length)),
    Math.max(header[4]!.length, ...rows.map((r) => String(r.p50_duration_ms).length)),
    Math.max(header[5]!.length, ...rows.map((r) => String(r.p95_duration_ms).length)),
    header[6]!.length,
  ];

  const pad = (s: string, w: number): string => s.padEnd(w);
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');

  const line = (cols: string[]): string =>
    cols.map((c, i) => pad(c, widths[i]!)).join('  ');

  process.stdout.write(line(header) + '\n');
  process.stdout.write(sep + '\n');
  for (const r of rows) {
    process.stdout.write(
      line([
        r.tool_name,
        String(r.calls),
        String(r.tokens_returned_total),
        r.avg_duration_ms.toFixed(1),
        String(r.p50_duration_ms),
        String(r.p95_duration_ms),
        `${(r.efficiency_ratio * 100).toFixed(1)}%`,
      ]) + '\n',
    );
  }
}

// ---------------------------------------------------------------------------
// Table printer — lock-hold summary (D6 deliverable 2, `mast metrics --locks`)
// ---------------------------------------------------------------------------

function printLocksTable(callers: readonly LockCallerSummary[]): void {
  const header = ['Caller', 'Count', 'Hold p50', 'Hold p95', 'Hold max', 'Wait p50', 'Wait p95', 'Wait max', 'Failed'];
  const cell = (c: LockCallerSummary): string[] => [
    c.caller,
    String(c.count),
    String(c.hold_p50_ms),
    String(c.hold_p95_ms),
    String(c.hold_max_ms),
    String(c.wait_p50_ms),
    String(c.wait_p95_ms),
    String(c.wait_max_ms),
    String(c.failed_count),
  ];
  const rows = callers.map(cell);

  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const pad = (s: string, w: number): string => s.padEnd(w);
  const line = (cols: string[]): string => cols.map((c, i) => pad(c, widths[i]!)).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');

  process.stdout.write(line(header) + '\n');
  process.stdout.write(sep + '\n');
  for (const r of rows) process.stdout.write(line(r) + '\n');
}

/**
 * Print the `--locks` report: human table or `--json`, for either a real
 * summary or the "nothing recorded" case (missing/empty JSONL).
 *
 * Never throws on malformed input — {@link readLockMetricsSummary} already
 * skips malformed lines inside {@link summarizeLockMetricsJsonl}; this
 * function surfaces the skipped-line count as a visible warning rather than
 * silently dropping it.
 */
function printLocksReport(stateDir: string, json: boolean): void {
  const summary: LockMetricsSummary = readLockMetricsSummary(stateDir) ?? {
    callers: [],
    malformed_line_count: 0,
  };

  if (json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return;
  }

  if (summary.callers.length === 0) {
    process.stdout.write('No lock metrics recorded.\n');
  } else {
    printLocksTable(summary.callers);
  }
  if (summary.malformed_line_count > 0) {
    process.stdout.write(
      `\nWarning: skipped ${summary.malformed_line_count} malformed line(s) in lock-metrics.jsonl.\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerMetricsCommand(program: Command): void {
  program
    .command('metrics [path]')
    .description('Show token-efficiency metrics from the metrics database')
    .option('--since <window>', 'Time window: 7d, 24h, 30m (default: 7d)', '7d')
    .option('--by-tool', 'Break down by tool name (default: true)', true)
    .option('--rollup', 'Collapse raw rows older than --keep-days into daily roll-ups')
    .option('--vacuum', 'Delete daily roll-up rows older than --keep-days')
    .option('--keep-days <n>', 'Retention days for --rollup / --vacuum (default: 7 for rollup, 90 for vacuum)', undefined)
    .option('--locks', 'Summarize structure-lock hold/wait timing by caller (store/lockMetrics.ts JSONL)')
    .option('--json', 'Machine-readable output')
    .option('--state-dir <dir>', 'State directory override')
    .action(async (projectPath: string | undefined, opts: {
      since: string;
      byTool: boolean;
      rollup?: boolean;
      vacuum?: boolean;
      keepDays?: string;
      locks?: boolean;
      json?: boolean;
      stateDir?: string;
    }) => {
      const config = resolveConfig({ projectRoot: projectPath, stateDirOverride: opts.stateDir });

      // --locks reads a flat JSONL file, not graph.db — no need to open the
      // database at all for this branch.
      if (opts.locks === true) {
        printLocksReport(config.resolved_state_dir, opts.json === true);
        return;
      }

      const db = openDatabase(config.resolved_state_dir);

      try {
        if (opts.rollup === true) {
          const keepDays = opts.keepDays !== undefined ? Number(opts.keepDays) : 7;
          const deleted = await rollupMetrics(db, keepDays);
          process.stdout.write(`Rolled up ${deleted} raw metric rows (kept last ${keepDays} days).\n`);
        }

        if (opts.vacuum === true) {
          const keepDays = opts.keepDays !== undefined ? Number(opts.keepDays) : 90;
          const deleted = await vacuumMetrics(db, keepDays);
          process.stdout.write(`Vacuumed ${deleted} daily roll-up rows (kept last ${keepDays} days).\n`);
        }

        if (opts.rollup !== true && opts.vacuum !== true) {
          const sinceMs = Date.now() - parseSince(opts.since);
          const rows = await queryMetricsSummaryWithPercentiles(db, sinceMs);
          if (opts.json === true) {
            process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
          } else {
            printTable(rows);
            if (rows.length > 0) {
              // Honesty footer (§14.5): counts are approximate for current
              // models; the savings ratio is robust to the per-count error.
              process.stdout.write(`\nTokenizer: ${TOKENIZER_LABEL}\n`);
            }
          }
        }
      } finally {
        await db.destroy();
      }
    });
}
