import { sql } from 'kysely';
import type { Db } from '../graph/db.js';
import type { ToolStats } from '../ast/types.js';
import type { DeclexTelemetry } from '../search/fused.js';

// ---------------------------------------------------------------------------
// Metrics persistence
// ---------------------------------------------------------------------------

export interface RecordToolCallOptions {
  readonly toolName: string;
  readonly tokensReturned: number;
  readonly tokensFullFileBound: number;
  readonly durationMs: number;
  readonly sessionId: string;
  readonly status: 'ok' | 'stale_returned' | 'error';
  /** Pre-serialised via {@link buildArgsJson}. Omitted for tools that don't yet record argument identity. */
  readonly argsJson?: string;
  /** Pre-serialised via {@link buildResultsJson}. Omitted for tools that don't yet record result identity. */
  readonly resultsJson?: string;
  /** Pre-serialised via {@link buildDeclexJson}. Omitted when ranker D did not fire or the flag was off. */
  readonly declexJson?: string;
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
      // Stage 7.2 (IMPLEMENTATION_PLAN.md "Stage 7: Vector-store deletion"):
      // no code produces a search mode any more (the vector leg it used to
      // distinguish from lexical is gone), so every new row writes NULL. The
      // COLUMN stays — pre-Stage-7 rows carry 'hybrid'/'lexical' and remain
      // readable for historical queries.
      mode:                         null,
      session_id:                   options.sessionId,
      status:                       options.status,
      args_json:                    options.argsJson ?? null,
      results_json:                 options.resultsJson ?? null,
      declex_json:                  options.declexJson ?? null,
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
  };
}

// ---------------------------------------------------------------------------
// Capsule instrumentation — argument/result identity (§14.3, §P 2026-07-15)
//
// Makes the "linked chain" measurable: did a later mast_signature/mast_exports
// call target a symbol/file that an earlier mast_search returned in the same
// session? Neither helper throws — a malformed identity payload must never
// break a tool response, same discipline as the rest of the metrics path.
// ---------------------------------------------------------------------------

/** A single `{file_path, symbol_name}` identity pair returned by a read tool, in rank order. */
export interface ResultIdentity {
  readonly file_path: string;
  readonly symbol_name: string | null;
}

const ARGS_JSON_CHAR_CAP = 1_000;
const RESULTS_JSON_ENTRY_CAP = 20;

/**
 * Serialise the salient tool arguments for `metrics.args_json`, capped at
 * {@link ARGS_JSON_CHAR_CAP} characters.
 *
 * `JSON.stringify` already drops `undefined`-valued properties, so passing
 * the tool's raw zod-parsed input captures "query + filters" (or
 * "symbol/file_path") without extra bookkeeping at each call site.
 *
 * When the serialised form exceeds the cap, the truncation is stated
 * honestly in the payload itself (`_truncated`, `original_length`) rather
 * than silently cutting the string — an un-labelled truncated JSON string
 * would also risk being invalid JSON.
 */
export function buildArgsJson(args: Record<string, unknown>, capChars = ARGS_JSON_CHAR_CAP): string {
  const full = JSON.stringify(args);
  if (full.length <= capChars) return full;

  const wrap = (previewLen: number): string =>
    JSON.stringify({
      _truncated: true,
      original_length: full.length,
      preview: full.slice(0, previewLen),
    });

  // `preview` is a slice of an already-JSON-encoded string, so it can contain
  // quote/backslash characters that need escaping once re-embedded as a JSON
  // string value — a fixed-length guess can overshoot the cap. Shrink
  // iteratively by the observed overflow instead; the max() clamp guarantees
  // termination even if a shrink step's escaping happens to net zero.
  let previewLen = Math.max(0, capChars - wrap(0).length);
  let wrapped = wrap(previewLen);
  while (wrapped.length > capChars && previewLen > 0) {
    previewLen = Math.max(0, previewLen - (wrapped.length - capChars));
    wrapped = wrap(previewLen);
  }
  return wrapped;
}

/**
 * Serialise result identity pairs for `metrics.results_json`, capped at
 * {@link RESULTS_JSON_ENTRY_CAP} entries.
 *
 * Rank order is preserved. When the list exceeds the cap, a final
 * `{"_truncated": N}` element (N = the number of dropped entries) is
 * appended rather than silently dropping them — mirrors {@link buildArgsJson}'s
 * honesty rule.
 */
export function buildResultsJson(
  identities: readonly ResultIdentity[],
  cap = RESULTS_JSON_ENTRY_CAP,
): string {
  if (identities.length <= cap) return JSON.stringify(identities);

  const kept = identities.slice(0, cap);
  const droppedCount = identities.length - cap;
  return JSON.stringify([...kept, { _truncated: droppedCount }]);
}

// ---------------------------------------------------------------------------
// D-fire telemetry — `metrics.declex_json` (Stage 6.3, M2 decision memo
// condition 3: the input signal for the F18 kill-switch and re-entry
// criteria).
// ---------------------------------------------------------------------------

const DECLEX_JSON_ENTRY_CAP = 10;

/**
 * Serialise ranker D's fire telemetry for `metrics.declex_json`, capping
 * `window_effects` at {@link DECLEX_JSON_ENTRY_CAP} entries.
 *
 * Truncation shape: a top-level `_truncated: <dropped count>` field is set
 * (nothing appended to `window_effects` itself) — {@link buildArgsJson}'s
 * convention of a top-level marker rather than {@link buildResultsJson}'s
 * appended-sentinel-element, because `window_effects` here is one field of a
 * larger diagnostics object (fired/top_match_channel/candidate_count sit
 * alongside it), not a bare list — a marker mixed into the array would be
 * indistinguishable from a real (malformed) effect on parse.
 */
export function buildDeclexJson(telemetry: DeclexTelemetry, capEntries = DECLEX_JSON_ENTRY_CAP): string {
  const { window_effects, ...rest } = telemetry;
  if (window_effects.length <= capEntries) {
    return JSON.stringify({ ...rest, window_effects });
  }

  const droppedCount = window_effects.length - capEntries;
  return JSON.stringify({
    ...rest,
    window_effects: window_effects.slice(0, capEntries),
    _truncated: droppedCount,
  });
}
