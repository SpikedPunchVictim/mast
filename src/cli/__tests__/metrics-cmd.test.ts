/**
 * D6 (IMPLEMENTATION_PLAN.md Stage 4, "D6 RESCOPE") — thin CLI wiring tests
 * for `mast metrics --by-tool`'s new p50/p95 columns and the new
 * `mast metrics --locks` report.
 *
 * The underlying query/summarizer functions (queryMetricsSummaryWithPercentiles,
 * summarizeLockMetricsJsonl, readLockMetricsSummary) already have full unit
 * coverage in telemetry/__tests__/. These tests exist only to prove the CLI
 * option wiring itself — flag parsing, the --locks short-circuit before
 * opening graph.db, and --json serialisation — which no unit test on the
 * underlying functions can catch.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { registerMetricsCommand } from '../metrics-cmd.js';
import { resolveConfig } from '../../store/config.js';
import { openDatabase } from '../../graph/db.js';
import { recordToolCall } from '../../telemetry/metrics.js';
import { LOCK_METRICS_FILENAME } from '../../store/lockMetrics.js';

function captureStdout(): { output: () => string; restore: () => void } {
  let buffer = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    buffer += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  });
  return { output: () => buffer, restore: () => spy.mockRestore() };
}

async function runMetricsCommand(args: string[]): Promise<void> {
  const program = new Command();
  registerMetricsCommand(program);
  await program.parseAsync(['metrics', ...args], { from: 'user' });
}

describe('mast metrics --by-tool — p50/p95 wiring', () => {
  let tmpDir: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('includes p50_duration_ms/p95_duration_ms in --json output', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-metrics-cmd-bytool-'));
    const config = resolveConfig({ projectRoot: tmpDir });
    mkdirSync(config.resolved_state_dir, { recursive: true });
    const db = openDatabase(config.resolved_state_dir);
    await recordToolCall(db, {
      toolName: 'mast_search', tokensReturned: 10, tokensFullFileBound: 100,
      durationMs: 42, sessionId: 's1', status: 'ok',
    });
    await db.destroy();

    const capture = captureStdout();
    try {
      await runMetricsCommand([tmpDir, '--since', '7d', '--json']);
    } finally {
      capture.restore();
    }

    const rows = JSON.parse(capture.output()) as Array<{ p50_duration_ms: number; p95_duration_ms: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.p50_duration_ms).toBe(42);
    expect(rows[0]!.p95_duration_ms).toBe(42);
  });
});

describe('mast metrics --locks — wiring', () => {
  let tmpDir: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prints "no lock metrics recorded" and does not open graph.db when the JSONL is absent', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-metrics-cmd-locks-missing-'));
    // resolveConfig's state dir is not created ahead of time — proves --locks
    // never touches graph.db (openDatabase would create/require the state dir).
    const config = resolveConfig({ projectRoot: tmpDir });

    const capture = captureStdout();
    try {
      await runMetricsCommand([tmpDir, '--locks']);
    } finally {
      capture.restore();
    }

    expect(capture.output()).toContain('No lock metrics recorded.');
    void config; // state dir intentionally left untouched by this command path
  });

  it('reads lock-metrics.jsonl and reports per-caller stats via --json, including malformed-line counting', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-metrics-cmd-locks-real-'));
    const config = resolveConfig({ projectRoot: tmpDir });
    mkdirSync(config.resolved_state_dir, { recursive: true });
    const lockFile = join(config.resolved_state_dir, LOCK_METRICS_FILENAME);
    writeFileSync(
      lockFile,
      JSON.stringify({ kind: 'released', type: 'structure', caller: 'index-run', holdMs: 30, timestamp: 1 }) + '\n',
    );
    appendFileSync(lockFile, 'not valid json\n');

    const capture = captureStdout();
    try {
      await runMetricsCommand([tmpDir, '--locks', '--json']);
    } finally {
      capture.restore();
    }

    const summary = JSON.parse(capture.output()) as {
      callers: Array<{ caller: string; hold_p50_ms: number }>;
      malformed_line_count: number;
    };
    expect(summary.callers).toHaveLength(1);
    expect(summary.callers[0]).toMatchObject({ caller: 'index-run', hold_p50_ms: 30 });
    expect(summary.malformed_line_count).toBe(1);
  });
});
