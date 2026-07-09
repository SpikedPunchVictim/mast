import type { Command } from 'commander';
import { resolveConfig } from '../store/config.js';
import { openDatabase } from '../graph/db.js';
import {
  queryMetricsSummary,
  rollupMetrics,
  vacuumMetrics,
} from '../telemetry/metrics.js';
import { TOKENIZER_LABEL } from '../telemetry/tokenizer.js';

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
// Table printer
// ---------------------------------------------------------------------------

function printTable(rows: {
  tool_name: string;
  calls: number;
  tokens_returned_total: number;
  avg_duration_ms: number;
  efficiency_ratio: number;
}[]): void {
  if (rows.length === 0) {
    process.stdout.write('No metrics recorded in the requested window.\n');
    return;
  }

  const header = ['Tool', 'Calls', 'Tokens', 'Avg ms', 'Efficiency'];
  const widths = [
    Math.max(header[0]!.length, ...rows.map((r) => r.tool_name.length)),
    Math.max(header[1]!.length, ...rows.map((r) => String(r.calls).length)),
    Math.max(header[2]!.length, ...rows.map((r) => String(r.tokens_returned_total).length)),
    Math.max(header[3]!.length, ...rows.map((r) => r.avg_duration_ms.toFixed(1).length)),
    header[4]!.length,
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
        `${(r.efficiency_ratio * 100).toFixed(1)}%`,
      ]) + '\n',
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
    .option('--state-dir <dir>', 'State directory override')
    .action(async (projectPath: string | undefined, opts: {
      since: string;
      byTool: boolean;
      rollup?: boolean;
      vacuum?: boolean;
      keepDays?: string;
      stateDir?: string;
    }) => {
      const config = resolveConfig({ projectRoot: projectPath, stateDirOverride: opts.stateDir });
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
          const rows = await queryMetricsSummary(db, sinceMs);
          printTable(rows);
          if (rows.length > 0) {
            // Honesty footer (§14.5): counts are approximate for current
            // models; the savings ratio is robust to the per-count error.
            process.stdout.write(`\nTokenizer: ${TOKENIZER_LABEL}\n`);
          }
        }
      } finally {
        await db.destroy();
      }
    });
}
