import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { openDatabase } from '../../graph/db.js';
import type { Db } from '../../graph/db.js';
import {
  recordToolCall,
  queryMetricsSummary,
  querySessionSummary,
  rollupMetrics,
  vacuumMetrics,
  buildToolStats,
} from '../metrics.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: Db;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mast-metrics-'));
  db = openDatabase(tmpDir);
});

afterAll(async () => {
  await db.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(async () => {
  // Wipe metrics between tests so assertions are isolated.
  await db.deleteFrom('metrics').execute();
  await db.deleteFrom('metrics_daily').execute();
});

// ---------------------------------------------------------------------------
// recordToolCall
// ---------------------------------------------------------------------------

describe('recordToolCall', () => {
  it('inserts a row into the metrics table', async () => {
    await recordToolCall(db, {
      toolName: 'mast_search',
      tokensReturned: 100,
      tokensFullFileBound: 500,
      durationMs: 42,
      sessionId: 'session-1',
      status: 'ok',
    });

    const rows = await db.selectFrom('metrics').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool_name).toBe('mast_search');
    expect(rows[0]!.tokens_returned).toBe(100);
    expect(rows[0]!.tokens_full_file_upper_bound).toBe(500);
    expect(rows[0]!.duration_ms).toBe(42);
    expect(rows[0]!.session_id).toBe('session-1');
    expect(rows[0]!.status).toBe('ok');
    expect(rows[0]!.mode).toBeNull();
  });

  it('stores mode when provided', async () => {
    await recordToolCall(db, {
      toolName: 'mast_search',
      tokensReturned: 50,
      tokensFullFileBound: 0,
      durationMs: 10,
      mode: 'hybrid',
      sessionId: 's1',
      status: 'ok',
    });

    const row = await db.selectFrom('metrics').selectAll().executeTakeFirst();
    expect(row!.mode).toBe('hybrid');
  });

  it('upserts metrics_daily row for today', async () => {
    await recordToolCall(db, {
      toolName: 'mast_exports',
      tokensReturned: 200,
      tokensFullFileBound: 0,
      durationMs: 20,
      sessionId: 's1',
      status: 'ok',
    });
    await recordToolCall(db, {
      toolName: 'mast_exports',
      tokensReturned: 300,
      tokensFullFileBound: 0,
      durationMs: 40,
      sessionId: 's1',
      status: 'ok',
    });

    const daily = await db.selectFrom('metrics_daily').selectAll().execute();
    expect(daily).toHaveLength(1);
    expect(daily[0]!.tool_name).toBe('mast_exports');
    expect(daily[0]!.calls).toBe(2);
    expect(daily[0]!.tokens_returned_total).toBe(500);
  });

  it('creates separate daily rows for different tools', async () => {
    await recordToolCall(db, {
      toolName: 'mast_search', tokensReturned: 10, tokensFullFileBound: 0,
      durationMs: 5, sessionId: 's1', status: 'ok',
    });
    await recordToolCall(db, {
      toolName: 'mast_exports', tokensReturned: 20, tokensFullFileBound: 0,
      durationMs: 5, sessionId: 's1', status: 'ok',
    });

    const daily = await db.selectFrom('metrics_daily').selectAll().orderBy('tool_name', 'asc').execute();
    expect(daily).toHaveLength(2);
    expect(daily[0]!.tool_name).toBe('mast_exports');
    expect(daily[1]!.tool_name).toBe('mast_search');
  });
});

// ---------------------------------------------------------------------------
// queryMetricsSummary
// ---------------------------------------------------------------------------

describe('queryMetricsSummary', () => {
  it('aggregates all rows when sinceMs = 0', async () => {
    await recordToolCall(db, {
      toolName: 'mast_search', tokensReturned: 100, tokensFullFileBound: 400,
      durationMs: 30, sessionId: 's1', status: 'ok',
    });
    await recordToolCall(db, {
      toolName: 'mast_search', tokensReturned: 200, tokensFullFileBound: 600,
      durationMs: 50, sessionId: 's1', status: 'ok',
    });

    const rows = await queryMetricsSummary(db, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool_name).toBe('mast_search');
    expect(rows[0]!.calls).toBe(2);
    expect(rows[0]!.tokens_returned_total).toBe(300);
    expect(rows[0]!.tokens_full_file_total).toBe(1000);
    // efficiency = 1 - 300/1000 = 0.7
    expect(rows[0]!.efficiency_ratio).toBeCloseTo(0.7);
  });

  it('excludes rows outside the time window', async () => {
    await recordToolCall(db, {
      toolName: 'mast_search', tokensReturned: 50, tokensFullFileBound: 0,
      durationMs: 10, sessionId: 's1', status: 'ok',
    });

    // Pass a future sinceMs — should exclude the row just inserted.
    const futureMs = Date.now() + 60_000;
    const rows = await queryMetricsSummary(db, futureMs);
    expect(rows).toHaveLength(0);
  });

  it('returns efficiency_ratio = 0 when full_file_total = 0', async () => {
    await recordToolCall(db, {
      toolName: 'mast_exports', tokensReturned: 100, tokensFullFileBound: 0,
      durationMs: 10, sessionId: 's1', status: 'ok',
    });

    const rows = await queryMetricsSummary(db, 0);
    expect(rows[0]!.efficiency_ratio).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// querySessionSummary
// ---------------------------------------------------------------------------

describe('querySessionSummary', () => {
  it('returns only rows for the given session', async () => {
    await recordToolCall(db, {
      toolName: 'mast_search', tokensReturned: 10, tokensFullFileBound: 0,
      durationMs: 5, sessionId: 'session-A', status: 'ok',
    });
    await recordToolCall(db, {
      toolName: 'mast_search', tokensReturned: 20, tokensFullFileBound: 0,
      durationMs: 5, sessionId: 'session-B', status: 'ok',
    });

    const rowsA = await querySessionSummary(db, 'session-A');
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]!.tokens_returned_total).toBe(10);

    const rowsB = await querySessionSummary(db, 'session-B');
    expect(rowsB[0]!.tokens_returned_total).toBe(20);
  });

  it('returns [] for an unknown session', async () => {
    const rows = await querySessionSummary(db, 'no-such-session');
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// rollupMetrics / vacuumMetrics
// ---------------------------------------------------------------------------

describe('rollupMetrics', () => {
  it('deletes raw rows older than keepDays', async () => {
    // Insert a row with a timestamp 10 days in the past.
    const oldTs = (Date.now() - 10 * 86_400_000) / 1000;
    await db.insertInto('metrics').values({
      tool_name: 'mast_search', call_timestamp: oldTs,
      tokens_returned: 5, tokens_full_file_upper_bound: 0,
      duration_ms: 1, mode: null, session_id: 's', status: 'ok',
    }).execute();

    // Insert a recent row.
    await recordToolCall(db, {
      toolName: 'mast_search', tokensReturned: 10, tokensFullFileBound: 0,
      durationMs: 2, sessionId: 's', status: 'ok',
    });

    const deleted = await rollupMetrics(db, 7);
    expect(deleted).toBe(1);

    const remaining = await db.selectFrom('metrics').selectAll().execute();
    expect(remaining).toHaveLength(1);
  });

  it('returns 0 when no rows are old enough', async () => {
    await recordToolCall(db, {
      toolName: 'mast_search', tokensReturned: 5, tokensFullFileBound: 0,
      durationMs: 1, sessionId: 's', status: 'ok',
    });

    const deleted = await rollupMetrics(db, 7);
    expect(deleted).toBe(0);
  });
});

describe('vacuumMetrics', () => {
  it('deletes daily rows older than keepDays', async () => {
    const oldDay = new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10);
    await db.insertInto('metrics_daily').values({
      day: oldDay, tool_name: 'mast_search',
      calls: 1, tokens_returned_total: 10, tokens_full_file_total: 0, avg_duration_ms: 5,
    }).execute();

    const recentDay = new Date().toISOString().slice(0, 10);
    await db.insertInto('metrics_daily').values({
      day: recentDay, tool_name: 'mast_search',
      calls: 1, tokens_returned_total: 20, tokens_full_file_total: 0, avg_duration_ms: 5,
    }).execute();

    const deleted = await vacuumMetrics(db, 90);
    expect(deleted).toBe(1);

    const remaining = await db.selectFrom('metrics_daily').selectAll().execute();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.day).toBe(recentDay);
  });
});

// ---------------------------------------------------------------------------
// buildToolStats
// ---------------------------------------------------------------------------

describe('buildToolStats', () => {
  it('computes efficiency_ratio correctly', () => {
    const stats = buildToolStats('mast_search', 200, 1000, ['a.ts'], 30);
    expect(stats.efficiency_ratio).toBeCloseTo(0.8);
    expect(stats.tokens_returned).toBe(200);
    expect(stats.tokens_full_file_upper_bound).toBe(1000);
  });

  it('sets efficiency_ratio to 0 when full_file_bound = 0', () => {
    const stats = buildToolStats('mast_exports', 50, 0, [], 10);
    expect(stats.efficiency_ratio).toBe(0);
  });

  it('includes mode when provided', () => {
    const stats = buildToolStats('mast_search', 50, 0, [], 5, 'hybrid');
    expect(stats.mode).toBe('hybrid');
  });
});
