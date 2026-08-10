import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { computeDurationPercentiles } from './metrics.js';
import { LOCK_METRICS_FILENAME } from '../store/lockMetrics.js';

// ---------------------------------------------------------------------------
// Lock-hold summarizer (D6, IMPLEMENTATION_PLAN.md Stage 4 "D6 RESCOPE"
// deliverable 2) — `mast metrics --locks`.
//
// Generalizes eval/baseline-locks.json's one-off capture-and-hand-compute
// into a repeatable report over store/lockMetrics.ts's JSONL sink
// (`<stateDir>/lock-metrics.jsonl`). That module's `LockEvent` union is the
// source of truth for the shape summarized here: 'acquired' {waitMs},
// 'released' {holdMs}, 'failed' {waitMs}, each carrying {type, caller,
// timestamp}. `structure` lock hold-by-caller "SURVIVES, narrowed" per the
// D6 rescope table — this is that surviving row's standing instrument.
// ---------------------------------------------------------------------------

// Validated at the boundary (§3.2): a hand-appended JSONL file on disk is
// untrusted input, not a value already known to match `LockEvent` — a
// truncated write (process killed mid-`appendFileSync`) or a future event
// kind this summarizer doesn't know about must be skipped, not crash the
// report.
const LockEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('acquired'),
    type: z.string(),
    caller: z.string(),
    waitMs: z.number(),
    timestamp: z.number(),
  }),
  z.object({
    kind: z.literal('released'),
    type: z.string(),
    caller: z.string(),
    holdMs: z.number(),
    timestamp: z.number(),
  }),
  z.object({
    kind: z.literal('failed'),
    type: z.string(),
    caller: z.string(),
    waitMs: z.number(),
    timestamp: z.number(),
  }),
]);

/** Per-caller lock timing summary. */
export interface LockCallerSummary {
  readonly caller: string;
  /** Number of completed acquire-then-release cycles observed for this caller. */
  readonly count: number;
  readonly hold_p50_ms: number;
  readonly hold_p95_ms: number;
  readonly hold_max_ms: number;
  readonly wait_p50_ms: number;
  readonly wait_p95_ms: number;
  readonly wait_max_ms: number;
  /** Acquisition attempts that exhausted retries without ever acquiring the lock. */
  readonly failed_count: number;
}

export interface LockMetricsSummary {
  readonly callers: readonly LockCallerSummary[];
  /** Lines that failed JSON.parse or did not match the LockEvent schema — skipped, not thrown. */
  readonly malformed_line_count: number;
}

/**
 * Summarize raw `lock-metrics.jsonl` content into per-caller count/p50/p95/max
 * for both hold duration (`released` events) and wait/acquire duration
 * (`acquired` events), plus a failed-acquisition count (`failed` events).
 *
 * Pure — takes the file's text directly rather than a path, so it is
 * unit-testable against fixture strings without touching the filesystem.
 * Malformed lines (bad JSON, or JSON that doesn't match a known `LockEvent`
 * shape) are skipped and counted rather than thrown, matching
 * store/lockMetrics.ts's own best-effort discipline for this data.
 */
export function summarizeLockMetricsJsonl(jsonlContent: string): LockMetricsSummary {
  const holdsByCaller = new Map<string, number[]>();
  const waitsByCaller = new Map<string, number[]>();
  const failedCountByCaller = new Map<string, number>();
  let malformedLineCount = 0;

  const lines = jsonlContent.split('\n').filter((line) => line.trim().length > 0);
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLineCount++;
      continue;
    }

    const result = LockEventSchema.safeParse(parsed);
    if (!result.success) {
      malformedLineCount++;
      continue;
    }

    const event = result.data;
    switch (event.kind) {
      case 'released': {
        const holds = holdsByCaller.get(event.caller) ?? [];
        holds.push(event.holdMs);
        holdsByCaller.set(event.caller, holds);
        break;
      }
      case 'acquired': {
        const waits = waitsByCaller.get(event.caller) ?? [];
        waits.push(event.waitMs);
        waitsByCaller.set(event.caller, waits);
        break;
      }
      case 'failed': {
        failedCountByCaller.set(event.caller, (failedCountByCaller.get(event.caller) ?? 0) + 1);
        break;
      }
    }
  }

  const allCallers = new Set([
    ...holdsByCaller.keys(),
    ...waitsByCaller.keys(),
    ...failedCountByCaller.keys(),
  ]);

  const callers: LockCallerSummary[] = [...allCallers].sort().map((caller) => {
    const holds = holdsByCaller.get(caller) ?? [];
    const waits = waitsByCaller.get(caller) ?? [];
    const holdPercentiles = computeDurationPercentiles(holds);
    const waitPercentiles = computeDurationPercentiles(waits);

    return {
      caller,
      count: holds.length,
      hold_p50_ms: holdPercentiles.p50,
      hold_p95_ms: holdPercentiles.p95,
      hold_max_ms: holds.length > 0 ? Math.max(...holds) : 0,
      wait_p50_ms: waitPercentiles.p50,
      wait_p95_ms: waitPercentiles.p95,
      wait_max_ms: waits.length > 0 ? Math.max(...waits) : 0,
      failed_count: failedCountByCaller.get(caller) ?? 0,
    };
  });

  return { callers, malformed_line_count: malformedLineCount };
}

/**
 * Read and summarize `<stateDir>/lock-metrics.jsonl`.
 *
 * Returns `null` when the file is missing or empty — the "no lock metrics
 * recorded" case `mast metrics --locks` reports distinctly from a
 * zero-caller summary, so callers can tell "never ran a coarse write" apart
 * from "ran, but every event was malformed" (the latter still returns a
 * summary object, with `malformed_line_count > 0` and `callers: []`).
 */
export function readLockMetricsSummary(stateDir: string): LockMetricsSummary | null {
  const path = join(stateDir, LOCK_METRICS_FILENAME);
  if (!existsSync(path)) return null;

  const content = readFileSync(path, 'utf-8');
  if (content.trim().length === 0) return null;

  return summarizeLockMetricsJsonl(content);
}
