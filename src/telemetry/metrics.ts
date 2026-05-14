import { sql } from 'kysely';
import type { Db } from '../graph/db.js';
import type { ToolStats, SearchMode } from '../ast/types.js';

// ---------------------------------------------------------------------------
// Metrics persistence
// ---------------------------------------------------------------------------

export interface RecordToolCallOptions {
  readonly toolName: string;
  readonly tokensReturned: number;
  readonly tokensFullFileBound: number;
  readonly durationMs: number;
  readonly mode?: SearchMode;
  readonly sessionId: string;
  readonly status: 'ok' | 'stale_returned' | 'error';
}

/**
 * Persist a single tool-call record to `metrics` and upsert the
 * `metrics_daily` roll-up row for today.
 *
 * The write is fire-and-forget from the caller's perspective; any DB error
 * is swallowed so a metrics failure never breaks a tool response.
 */
export async function recordToolCall(
  db: Db,
  options: RecordToolCallOptions,
): Promise<void> {
  const now = Date.now() / 1000; // unix epoch seconds
  const day = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'

  await db
    .insertInto('metrics')
    .values({
      tool_name:                    options.toolName,
      call_timestamp:               now,
      tokens_returned:              options.tokensReturned,
      tokens_full_file_upper_bound: options.tokensFullFileBound,
      duration_ms:                  options.durationMs,
      mode:                         options.mode ?? null,
      session_id:                   options.sessionId,
      status:                       options.status,
    })
    .execute();

  // Upsert today's roll-up row.
  await db
    .insertInto('metrics_daily')
    .values({
      day,
      tool_name:             options.toolName,
      calls:                 1,
      tokens_returned_total: options.tokensReturned,
      tokens_full_file_total: options.tokensFullFileBound,
      avg_duration_ms:       options.durationMs,
    })
    .onConflict((oc) =>
      oc.columns(['day', 'tool_name']).doUpdateSet((eb) => ({
        calls:                 sql`${eb.ref('excluded.calls')} + metrics_daily.calls`,
        tokens_returned_total: sql`${eb.ref('excluded.tokens_returned_total')} + metrics_daily.tokens_returned_total`,
        tokens_full_file_total: sql`${eb.ref('excluded.tokens_full_file_total')} + metrics_daily.tokens_full_file_total`,
        // Incremental running average: (old_avg * old_n + new_val) / (old_n + 1)
        avg_duration_ms: sql`(metrics_daily.avg_duration_ms * metrics_daily.calls + ${eb.ref('excluded.avg_duration_ms')}) / (metrics_daily.calls + 1)`,
      })),
    )
    .execute();
}

// ---------------------------------------------------------------------------
// Aggregation queries
// ---------------------------------------------------------------------------

export interface MetricsSummary {
  readonly tool_name: string;
  readonly calls: number;
  readonly tokens_returned_total: number;
  readonly tokens_full_file_total: number;
  readonly avg_duration_ms: number;
  readonly efficiency_ratio: number;
}

/**
 * Aggregate `metrics` rows within the given time window.
 *
 * @param db - open database
 * @param sinceMs - unix epoch milliseconds; rows older than this are excluded
 * @param toolName - when provided, restrict to one tool
 */
export async function queryMetricsSummary(
  db: Db,
  sinceMs: number,
  toolName?: string,
): Promise<MetricsSummary[]> {
  const sinceEpochSec = sinceMs / 1000;

  let q = db
    .selectFrom('metrics')
    .select((eb) => [
      'tool_name',
      eb.fn.count<number>('id').as('calls'),
      eb.fn.sum<number>('tokens_returned').as('tokens_returned_total'),
      eb.fn.sum<number>('tokens_full_file_upper_bound').as('tokens_full_file_total'),
      eb.fn.avg<number>('duration_ms').as('avg_duration_ms'),
    ])
    .where('call_timestamp', '>=', sinceEpochSec)
    .groupBy('tool_name')
    .orderBy('tool_name', 'asc');

  if (toolName !== undefined) {
    q = q.where('tool_name', '=', toolName);
  }

  const rows = await q.execute();

  return rows.map((r) => ({
    tool_name:             r.tool_name,
    calls:                 Number(r.calls),
    tokens_returned_total: Number(r.tokens_returned_total),
    tokens_full_file_total: Number(r.tokens_full_file_total),
    avg_duration_ms:       Number(r.avg_duration_ms),
    efficiency_ratio:
      Number(r.tokens_full_file_total) > 0
        ? 1 - Number(r.tokens_returned_total) / Number(r.tokens_full_file_total)
        : 0,
  }));
}

/**
 * Aggregate `metrics` rows for a single session.
 */
export async function querySessionSummary(
  db: Db,
  sessionId: string,
): Promise<MetricsSummary[]> {
  const rows = await db
    .selectFrom('metrics')
    .select((eb) => [
      'tool_name',
      eb.fn.count<number>('id').as('calls'),
      eb.fn.sum<number>('tokens_returned').as('tokens_returned_total'),
      eb.fn.sum<number>('tokens_full_file_upper_bound').as('tokens_full_file_total'),
      eb.fn.avg<number>('duration_ms').as('avg_duration_ms'),
    ])
    .where('session_id', '=', sessionId)
    .groupBy('tool_name')
    .orderBy('tool_name', 'asc')
    .execute();

  return rows.map((r) => ({
    tool_name:             r.tool_name,
    calls:                 Number(r.calls),
    tokens_returned_total: Number(r.tokens_returned_total),
    tokens_full_file_total: Number(r.tokens_full_file_total),
    avg_duration_ms:       Number(r.avg_duration_ms),
    efficiency_ratio:
      Number(r.tokens_full_file_total) > 0
        ? 1 - Number(r.tokens_returned_total) / Number(r.tokens_full_file_total)
        : 0,
  }));
}

// ---------------------------------------------------------------------------
// Rotation helpers
// ---------------------------------------------------------------------------

/**
 * Collapse raw `metrics` rows older than `keepDays` into `metrics_daily`
 * (the roll-up already exists) and delete the raw rows.
 *
 * Safe to call repeatedly — idempotent.
 */
export async function rollupMetrics(db: Db, keepDays = 7): Promise<number> {
  const cutoffSec = (Date.now() - keepDays * 86_400_000) / 1000;
  const result = await db
    .deleteFrom('metrics')
    .where('call_timestamp', '<', cutoffSec)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

/**
 * Delete `metrics_daily` rows older than `keepDays` days.
 */
export async function vacuumMetrics(db: Db, keepDays = 90): Promise<number> {
  const cutoff = new Date(Date.now() - keepDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const result = await db
    .deleteFrom('metrics_daily')
    .where('day', '<', cutoff)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

// ---------------------------------------------------------------------------
// ToolStats builder
// ---------------------------------------------------------------------------

/**
 * Build a `ToolStats` block from raw measurements.
 *
 * Attached to every read-tool response so consumers can track token savings.
 */
export function buildToolStats(
  toolName: string,
  tokensReturned: number,
  tokensFullFileBound: number,
  filesReferenced: readonly string[],
  durationMs: number,
  mode?: SearchMode,
): ToolStats {
  const efficiency =
    tokensFullFileBound > 0
      ? 1 - tokensReturned / tokensFullFileBound
      : 0;

  return {
    tool: toolName,
    tokens_returned: tokensReturned,
    tokens_full_file_upper_bound: tokensFullFileBound,
    files_referenced: filesReferenced,
    efficiency_ratio: efficiency,
    duration_ms: durationMs,
    mode,
  };
}
