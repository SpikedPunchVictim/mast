# MAST — Session Log 2026-05-14

All times are local (PDT, UTC-7). Test run timestamps are taken directly from
vitest output. Work was performed in a single Claude Code session continuing
from a prior session that had completed Stages 1–7 and most of Stage 8.

---

## 13:36 — Stage 8 verification

Ran the full test suite to confirm the previous session's final edit was correct.
The last change before this session had rewritten the dynamic dimension detection
test in `src/mcp/__tests__/startup.test.ts` to avoid opening a second LanceDB
connection — a prior version caused a NAPI Rust panic (SIGABRT, exit code 134)
during process teardown because `@lancedb/lancedb` does not safely support two
`LanceStore` instances open simultaneously in the same process. The fix observed
the embedder's `dimension` getter through a wrapper object instead of opening a
second LanceDB connection for verification.

**Result:** 126 tests across 8 files, all passing.

---

## 13:36 — `runPhase1` renamed to `runIndex`

**Change:** `runPhase1` → `runIndex`, `Phase1Result` → `IndexResult`,
`Phase1Options` → `IndexOptions` across the entire package.

**Why:** The original `runPhase1` name was a scaffold artifact from when the
design described two "phases" (Phase 1 = parse, Phase 2 = embed). Phase 2 was
already renamed to `runEmbed` in a previous session. `runPhase1` was the only
remaining phase-numbered name, and it was inconsistent with the rest of the
API. `runIndex` aligns with the `mast index` CLI command and with the mental
model — it indexes the project; "phase 1" is an implementation detail, not a
meaningful name for callers.

**Files changed:**
- `src/indexer/index.ts` — function and interface definitions
- `src/mcp/server.ts`
- `src/mcp/tools/reindex.ts`
- `src/cli/index-cmd.ts`
- `src/cli/init.ts`
- `src/graph/__tests__/resolve-types.test.ts`
- `src/mcp/tools/__tests__/tools.test.ts`
- `src/mcp/__tests__/startup.test.ts`
- `src/search/__tests__/search.test.ts`
- `src/cli/__tests__/cli.test.ts`
- `src/indexer/__tests__/embed.test.ts`

**Result:** 126 tests, all passing.

---

## 13:37 — Stage 8 marked complete in IMPLEMENTATION_PLAN.md

Updated IMPLEMENTATION_PLAN.md to mark Stage 8 complete, ticking all four
success criteria. Added a note documenting the additional work done in Stage 8
beyond what the original plan described:

- `resolveTypeContext` — 3-priority type lookup (same file → named imports →
  global exported type fallback) implemented in `src/graph/queries.ts`
- Dynamic embedding dimension detection — `embedder.load()` probes with an
  empty string after model load to detect the actual dimension, rather than
  hardcoding 768. This allows swapping embedding models without code changes.
- `extractTypeNames` in `mast_signature` — extracts user-defined PascalCase
  type names from a signature and passes them to `resolveTypeContext`, so
  `type_context` in signature responses is populated automatically.

---

## 13:37–13:51 — Stage 9: Telemetry

### 13:37 — `src/telemetry/metrics.ts` — full implementation

The `recordToolCall` stub was replaced with a real implementation.

**Design decisions:**

`recordToolCall` writes two rows per call: one raw row to `metrics` (full
detail, used by `querySessionSummary` and `queryMetricsSummary`) and one upsert
to `metrics_daily` (the roll-up, used by `mast metrics` for historical
reporting). The upsert uses an incremental running average formula for
`avg_duration_ms`:

```sql
avg_duration_ms = (old_avg * old_n + new_val) / (old_n + 1)
```

**Tradeoff:** Storing both raw rows and a daily roll-up adds a second write per
call. The alternative was to compute aggregates on the fly from raw rows, but
that becomes expensive for sessions with thousands of calls. The daily roll-up
keeps `mast metrics` instantaneous regardless of call volume. The `--rollup`
command deletes raw rows older than N days (defaulting to 7) once they have
been absorbed into the daily table.

**Fire-and-forget pattern:** All tool handlers call `recordToolCall` with
`void ...catch(() => {})`. Metrics writes must never block a tool response or
surface DB errors to the caller. The `< 1ms` requirement is met because the
write is enqueued to the Node.js microtask queue and the caller returns
immediately.

**New exports from `metrics.ts`:**
- `recordToolCall(db, options)` — insert + upsert
- `queryMetricsSummary(db, sinceMs, toolName?)` — aggregate from raw rows
- `querySessionSummary(db, sessionId)` — session-scoped aggregate
- `rollupMetrics(db, keepDays)` — delete old raw rows
- `vacuumMetrics(db, keepDays)` — delete old daily roll-up rows

---

### 13:40 — `src/mcp/tools/efficiency.ts` — full implementation

The stub that always returned zeros was replaced with real aggregation logic.

`scope: "session"` calls `querySessionSummary` using `ctx.sessionId` (a UUID
assigned at server startup). `scope: "global"` calls `queryMetricsSummary`
with `sinceMs = 0` (all time) or `Date.now() - since_minutes * 60_000`.

The `counterfactual` field is generated as a human-readable narrative rather
than raw numbers: *"Would have cost ~14,200 tokens with naive full-file reads;
saved ~11,400 tokens (80.3%)."* This is intentional — the tool is designed to
be called by an AI assistant that will relay the summary to a user, and a
sentence is more useful than three numbers.

**Tradeoff:** `tokens_full_file_upper_bound` is 0 for most tool calls because
computing the true full-file cost requires re-reading source files and
tokenising them, which is expensive. The infrastructure is there (the column
exists in the schema), but populating it precisely is deferred. For now,
`efficiency_ratio` is only meaningful when `tokens_full_file_upper_bound > 0`.
The `mast_efficiency` response makes this visible by setting
`efficiency_ratio = 0` rather than a misleading value.

---

### 13:41 — All 7 read tools wired with `recordToolCall`

Added the fire-and-forget `recordToolCall` call to the return path of:
`mast_search`, `mast_exports`, `mast_project_skeleton`, `mast_signature`,
`mast_callers`, `mast_dependencies`, `mast_implementors`.

`mast_reindex`, `mast_status`, and `mast_efficiency` were intentionally
excluded — they are operational/meta tools, not code-navigation tools, and
recording their calls in metrics would inflate call counts without meaningful
efficiency data.

**Pattern used in every tool:**

```typescript
void recordToolCall(ctx.db, {
  toolName: 'mast_search', tokensReturned: tokens, tokensFullFileBound: 0,
  durationMs, sessionId: ctx.sessionId, status: 'ok',
}).catch(() => {});
return { content: [{ type: 'text', text: JSON.stringify(response) }] };
```

The `void` + `.catch(() => {})` combination satisfies `no-floating-promises`
(the rule requires that promises are handled, not necessarily awaited) while
ensuring that a metrics write failure cannot reject the surrounding async
function.

---

### 13:43 — `src/cli/metrics-cmd.ts` — new file

Implements the `mast metrics` CLI command.

**Time window parsing:** `--since` accepts `7d`, `24h`, `30m` (days, hours,
minutes). Using a string rather than a raw integer avoids ambiguity about the
unit and is more readable in shell history. The parser is a single regex rather
than a library dependency.

**Table printer:** A plain column-aligned text table rather than a box-drawing
or colour table. Reasoning: the output goes to a terminal that may be piped
to another process or read in a non-colour environment. Plain padding is always
safe; colour requires ANSI detection.

**`--rollup` and `--vacuum` flags:** These are explicit operations, not
automatic. Automatic cleanup would silently delete data the user may want to
inspect. Providing explicit flags means the user consciously chooses the
retention boundary. A common cron pattern would be:
`mast metrics --rollup --keep-days 7 && mast metrics --vacuum --keep-days 90`.

**TypeScript fix:** The initial destructuring `const [, n, unit] = match as [...]`
caused TS2352 under `exactOptionalPropertyTypes`. Fixed by using explicit index
access: `const n = match[1]!; const unit = match[2]!;`

---

### 13:47 — `src/telemetry/__tests__/metrics.test.ts` — new file, 15 tests

Test groups:
- `recordToolCall` — verifies the raw row is inserted correctly, the `mode`
  field is stored, the daily upsert accumulates calls, and separate tools get
  separate daily rows.
- `queryMetricsSummary` — verifies aggregation across rows, time-window
  exclusion (future `sinceMs` excludes all rows), and the zero-division guard
  for `efficiency_ratio`.
- `querySessionSummary` — verifies session isolation (two sessions, independent
  results) and empty result for unknown session.
- `rollupMetrics` — inserts a row 10 days in the past and a recent row; verifies
  only the old row is deleted.
- `vacuumMetrics` — inserts a 100-day-old daily row and today's row; verifies
  only the old row is deleted.
- `buildToolStats` — unit tests for the efficiency ratio formula and mode
  passthrough.

Each test uses `afterEach` to wipe `metrics` and `metrics_daily`, so tests are
fully isolated without needing separate databases.

---

### 13:48 — `mast_efficiency` tests added to `tools.test.ts` (3 tests)

Added to the existing 25-test MCP tools integration suite:
1. Session scope with empty session — verifies response shape and required fields.
2. Global scope after a `mast_search` call — verifies the response is valid.
   The test avoids asserting `calls_total > 0` because `recordToolCall` is
   fire-and-forget and may not have completed before the efficiency call runs.
   Shape correctness is the meaningful assertion here.
3. `since_minutes` restricts the global window — verifies `window_started_at`
   is within the expected range.

---

## 13:51 — Stage 9 complete, all tests pass

**Result:** 144 tests across 9 files, all passing. `tsc --noEmit` clean.

Total tests added this session: 18 (15 in `metrics.test.ts` + 3 in `tools.test.ts`).
Total tests in package: 144.

---

## 13:52 — IMPLEMENTATION_PLAN.md updated

Stage 9 marked complete. All stages (1–9) now complete.

---

## 14:00 — `README.md` created

`packages/mast/README.md` written from scratch. Sections:

- **Why MAST?** — the core argument: AST-level chunking returns exactly the
  declaration an assistant needs, not the file it lives in; this saves tokens
  and reduces noise.
- **Requirements** — includes a note on the automatic ~300 MB model download
  on first run, which is not surfaced anywhere else in the codebase.
- **Quick Start** — three commands to reach a working state.
- **CLI Reference** — all six commands with options and a *why* for each
  non-obvious option.
- **MCP Tool Reference** — all 10 tools with TypeScript input types, return
  shapes, and a *why* section explaining the query pattern each tool addresses.
- **Configuration** — full defaults table, `mast.config.json` example,
  `MAST_STATE_DIR` env var.
- **How It Works** — internal architecture covering Phase 1 (parse → chunk →
  sub-chunk → graph → FTS), Phase 2 (embedding, dynamic dimension, background
  worker), hybrid search (BM25 + RRF fusion), JIT staleness, startup ladder,
  concurrency model, and storage layout.
- **Token Efficiency** — how metrics are recorded and the incremental average
  SQL formula.

**Decision on depth:** The README explains the *why* for every non-obvious
design decision (FTS5 filter materialisation via `files` table, incremental
running average for daily rollup, fire-and-forget metrics writes, the startup
ladder timing, dynamic dimension detection) because these are the things a
developer would need to understand before touching the code. Pure "what" docs
can be read from the source; the README should answer "why this way and not
another way".

---

## 14:01 — Embedding model download question addressed

Added a note to the README Requirements section clarifying:
- The ~300 MB ONNX weights download automatically via `@huggingface/transformers`
  on first `mast index` or `mast serve` run.
- Outside Docker: cached to `~/.cache/huggingface/hub`.
- In Docker: `createEmbedder` hardcodes `/opt/transformers-cache` — bake the
  weights into the image layer to avoid a download on every container start.
- The server operates in `"lexical"` mode while the download/embedding is in
  progress; hybrid mode activates once the background embedder finishes.

---

## Summary of files changed or created today

| File | Status | Description |
|---|---|---|
| `src/indexer/index.ts` | Modified | `runPhase1` → `runIndex`, interfaces renamed |
| `src/mcp/server.ts` | Modified | `runPhase1` → `runIndex` |
| `src/mcp/tools/reindex.ts` | Modified | `runPhase1` → `runIndex` |
| `src/mcp/tools/efficiency.ts` | Modified | Full implementation (was stub) |
| `src/mcp/tools/search.ts` | Modified | Wired `recordToolCall` |
| `src/mcp/tools/exports.ts` | Modified | Wired `recordToolCall` |
| `src/mcp/tools/project-skeleton.ts` | Modified | Wired `recordToolCall` |
| `src/mcp/tools/signature.ts` | Modified | Wired `recordToolCall` |
| `src/mcp/tools/callers.ts` | Modified | Wired `recordToolCall` |
| `src/mcp/tools/dependencies.ts` | Modified | Wired `recordToolCall` |
| `src/mcp/tools/implementors.ts` | Modified | Wired `recordToolCall` |
| `src/mcp/tools/__tests__/tools.test.ts` | Modified | Added 3 `mast_efficiency` tests |
| `src/cli/index-cmd.ts` | Modified | `runPhase1` → `runIndex` |
| `src/cli/init.ts` | Modified | `runPhase1` → `runIndex` |
| `src/cli/index.ts` | Modified | Registered `metrics` command |
| `src/cli/metrics-cmd.ts` | Created | `mast metrics` CLI command |
| `src/cli/status.ts` | Modified | `runPhase1` → `runIndex` |
| `src/telemetry/metrics.ts` | Modified | Full implementation (was stub) |
| `src/telemetry/__tests__/metrics.test.ts` | Created | 15 tests for telemetry layer |
| `src/graph/__tests__/resolve-types.test.ts` | Modified | `runPhase1` → `runIndex` |
| `src/mcp/__tests__/startup.test.ts` | Modified | `runPhase1` → `runIndex` |
| `src/search/__tests__/search.test.ts` | Modified | `runPhase1` → `runIndex` |
| `src/cli/__tests__/cli.test.ts` | Modified | `runPhase1` → `runIndex` |
| `src/indexer/__tests__/embed.test.ts` | Modified | `runPhase1` → `runIndex` |
| `IMPLEMENTATION_PLAN.md` | Modified | Stages 8 and 9 marked complete |
| `README.md` | Created | Full package documentation |
| `.history/2026-05-14.md` | Created | This file |
