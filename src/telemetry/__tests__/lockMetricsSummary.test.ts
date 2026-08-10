import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { summarizeLockMetricsJsonl, readLockMetricsSummary } from '../lockMetricsSummary.js';
import { LOCK_METRICS_FILENAME } from '../../store/lockMetrics.js';

// ---------------------------------------------------------------------------
// summarizeLockMetricsJsonl — D6 (IMPLEMENTATION_PLAN.md Stage 4, "D6
// RESCOPE" deliverable 2), `mast metrics --locks`.
//
// Pure function over JSONL text (no filesystem access) so it is directly
// unit-testable against known fixture strings, per §5.1's red-first
// discipline for stub signatures. Fixture events follow the exact
// `LockEvent` shape store/lockMetrics.ts's default sink writes: 'acquired'
// {waitMs}, 'released' {holdMs}, 'failed' {waitMs}, each carrying
// {type, caller, timestamp}.
// ---------------------------------------------------------------------------

describe('summarizeLockMetricsJsonl', () => {
  it('groups by caller and computes count/p50/p95/max for hold and wait durations', () => {
    const lines = [
      { kind: 'acquired', type: 'structure', caller: 'index-run', waitMs: 5, timestamp: 1000 },
      { kind: 'released', type: 'structure', caller: 'index-run', holdMs: 120, timestamp: 1005 },
      { kind: 'acquired', type: 'structure', caller: 'index-run', waitMs: 10, timestamp: 2000 },
      { kind: 'released', type: 'structure', caller: 'index-run', holdMs: 80, timestamp: 2010 },
      { kind: 'acquired', type: 'structure', caller: 'jit-staleness', waitMs: 2, timestamp: 3000 },
      { kind: 'released', type: 'structure', caller: 'jit-staleness', holdMs: 15, timestamp: 3002 },
      { kind: 'failed', type: 'structure', caller: 'jit-staleness', waitMs: 300, timestamp: 4000 },
    ];
    const jsonl = lines.map((l) => JSON.stringify(l)).join('\n');

    const summary = summarizeLockMetricsJsonl(jsonl);

    expect(summary.malformed_line_count).toBe(0);
    expect(summary.callers).toHaveLength(2);

    const indexRun = summary.callers.find((c) => c.caller === 'index-run')!;
    // holds sorted [80, 120], N=2: p50 rank=ceil(1)=1->index0->80; p95 rank=ceil(1.9)=2->index1->120.
    expect(indexRun.count).toBe(2);
    expect(indexRun.hold_p50_ms).toBe(80);
    expect(indexRun.hold_p95_ms).toBe(120);
    expect(indexRun.hold_max_ms).toBe(120);
    // waits sorted [5, 10]: p50 rank=1->index0->5; p95 rank=2->index1->10.
    expect(indexRun.wait_p50_ms).toBe(5);
    expect(indexRun.wait_p95_ms).toBe(10);
    expect(indexRun.wait_max_ms).toBe(10);
    expect(indexRun.failed_count).toBe(0);

    const jit = summary.callers.find((c) => c.caller === 'jit-staleness')!;
    expect(jit.count).toBe(1);
    expect(jit.hold_p50_ms).toBe(15);
    expect(jit.hold_p95_ms).toBe(15);
    expect(jit.hold_max_ms).toBe(15);
    expect(jit.wait_p50_ms).toBe(2);
    expect(jit.wait_p95_ms).toBe(2);
    expect(jit.wait_max_ms).toBe(2);
    expect(jit.failed_count).toBe(1);
  });

  it('sorts caller rows alphabetically for stable output', () => {
    const lines = [
      { kind: 'released', type: 'structure', caller: 'zeta', holdMs: 1, timestamp: 1 },
      { kind: 'released', type: 'structure', caller: 'alpha', holdMs: 1, timestamp: 2 },
    ];
    const summary = summarizeLockMetricsJsonl(lines.map((l) => JSON.stringify(l)).join('\n'));
    expect(summary.callers.map((c) => c.caller)).toEqual(['alpha', 'zeta']);
  });

  it('skips lines that fail JSON.parse and counts them as malformed, without crashing', () => {
    const jsonl = [
      JSON.stringify({ kind: 'released', type: 'structure', caller: 'index-run', holdMs: 10, timestamp: 1 }),
      'not json at all {{{',
      JSON.stringify({ kind: 'released', type: 'structure', caller: 'index-run', holdMs: 20, timestamp: 2 }),
    ].join('\n');

    const summary = summarizeLockMetricsJsonl(jsonl);
    expect(summary.malformed_line_count).toBe(1);
    expect(summary.callers).toHaveLength(1);
    expect(summary.callers[0]!.count).toBe(2);
  });

  it('skips lines that parse as JSON but do not match the LockEvent shape', () => {
    const jsonl = [
      // Missing required `holdMs`/`timestamp` for an 'acquired'-only field set.
      JSON.stringify({ kind: 'acquired', type: 'structure', caller: 'index-run' }),
      // Unknown `kind`.
      JSON.stringify({ kind: 'renewed', type: 'structure', caller: 'index-run', timestamp: 1 }),
      // Valid.
      JSON.stringify({ kind: 'released', type: 'structure', caller: 'index-run', holdMs: 5, timestamp: 3 }),
    ].join('\n');

    const summary = summarizeLockMetricsJsonl(jsonl);
    expect(summary.malformed_line_count).toBe(2);
    expect(summary.callers).toHaveLength(1);
    expect(summary.callers[0]!.count).toBe(1);
  });

  it('ignores blank lines without counting them as malformed', () => {
    const jsonl = [
      JSON.stringify({ kind: 'released', type: 'structure', caller: 'index-run', holdMs: 5, timestamp: 1 }),
      '',
      '   ',
      '',
    ].join('\n');

    const summary = summarizeLockMetricsJsonl(jsonl);
    expect(summary.malformed_line_count).toBe(0);
    expect(summary.callers).toHaveLength(1);
  });

  it('returns an empty summary for empty input', () => {
    expect(summarizeLockMetricsJsonl('')).toEqual({ callers: [], malformed_line_count: 0 });
  });
});

// ---------------------------------------------------------------------------
// readLockMetricsSummary — thin filesystem wrapper (`<stateDir>/lock-metrics.jsonl`).
// ---------------------------------------------------------------------------

describe('readLockMetricsSummary', () => {
  let stateDir: string;

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('returns null when the JSONL file does not exist', () => {
    stateDir = mkdtempSync(join(tmpdir(), 'mast-lockmetrics-missing-'));
    expect(readLockMetricsSummary(stateDir)).toBeNull();
  });

  it('returns null when the JSONL file exists but is empty', () => {
    stateDir = mkdtempSync(join(tmpdir(), 'mast-lockmetrics-empty-'));
    writeFileSync(join(stateDir, LOCK_METRICS_FILENAME), '');
    expect(readLockMetricsSummary(stateDir)).toBeNull();
  });

  it('reads and summarizes a real JSONL file', () => {
    stateDir = mkdtempSync(join(tmpdir(), 'mast-lockmetrics-real-'));
    const event = { kind: 'released', type: 'structure', caller: 'index-run', holdMs: 42, timestamp: 1 };
    writeFileSync(join(stateDir, LOCK_METRICS_FILENAME), JSON.stringify(event) + '\n');

    const summary = readLockMetricsSummary(stateDir);
    expect(summary).not.toBeNull();
    expect(summary!.callers).toHaveLength(1);
    expect(summary!.callers[0]!.caller).toBe('index-run');
    expect(summary!.callers[0]!.hold_p50_ms).toBe(42);
  });
});
