#!/usr/bin/env node
// Stage 2.1 spike — read-only telemetry aggregation for IMPLEMENTATION_PLAN_VEXP.md
// Feature 2 / Stage 2.1. Throwaway; imports `better-sqlite3` (already a mast
// dependency) directly against real `.mast/graph.db` files, opened with
// `readonly: true`. Never touches production code.
//
// v2 (2026-07-15, same day): extended with Pool B — the kluster-workbench
// build-session stores (/Users/spikedpunchvictim/projects/kluster-workbench/apps,
// .fold/.mast state dirs from real agent builds: a0-*, align-*, echo-*,
// study-intake-*, ecommerce, file-vault). Same mast source (global `mast`
// binary npm-links to packages/mast/dist), so the schema ground truth below
// still applies. Pool A (kluster repo) results are preserved for provenance.
//
// Schema ground truth: packages/mast/src/telemetry/metrics.ts +
// MAST_SPEC.md §14.3. The `metrics` table has NO columns for tool arguments,
// query text, or result symbols/files — only:
//   id, tool_name, call_timestamp, tokens_returned,
//   tokens_full_file_upper_bound, duration_ms, mode, session_id, status
// This means the chain can only be established as a LOOSE sequential
// definition (same session_id, tool_name ordering by call_timestamp) — the
// "on a symbol/file the search returned" tightening is NOT derivable from
// this data. That is reported as a hard schema limitation, not worked around.

import Database from 'better-sqlite3';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const POOLS = [
  {
    name: 'A (kluster repo)',
    kind: 'mixed interactive + SDD per-task ephemeral',
    // Any dir literally named `.mast` anywhere in the kluster repo.
    findCmd: `find "/Users/spikedpunchvictim/projects/kluster" -iname ".mast" -not -path "*/node_modules/*" -type d`,
  },
  {
    name: 'B (kluster-workbench builds)',
    kind: 'automated SDD/fold build pipeline sessions',
    // Workbench apps use .fold/.mast; the coordinator's shape.
    findCmd: `find "/Users/spikedpunchvictim/projects/kluster-workbench/apps" -maxdepth 4 -path "*/.mast/graph.db" | xargs -n1 dirname`,
  },
];

function loadPoolStores(pool) {
  const dirs = execSync(pool.findCmd, { maxBuffer: 1024 * 1024 * 16 })
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean);

  const stores = [];
  for (const dir of dirs) {
    const dbPath = path.join(dir, 'graph.db');
    let db;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch {
      continue;
    }
    let rows;
    let dailyRowCount = 0;
    try {
      rows = db
        .prepare(
          `SELECT id, tool_name, call_timestamp, tokens_returned,
                  tokens_full_file_upper_bound, duration_ms, mode, session_id, status
           FROM metrics ORDER BY session_id, call_timestamp`,
        )
        .all();
      dailyRowCount = db.prepare(`SELECT COUNT(*) AS n FROM metrics_daily`).get().n;
    } catch {
      rows = [];
    } finally {
      db.close();
    }
    if (rows.length > 0) {
      stores.push({ dir, dbPath, rowCount: rows.length, dailyRowCount, rows });
    }
  }
  return stores;
}

// ---------------------------------------------------------------------------
// Shared statistics helpers
// ---------------------------------------------------------------------------

function median(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
function percentile(nums, p) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[idx];
}

const CHAIN_TARGETS = new Set(['mast_signature', 'mast_exports']);

// ---------------------------------------------------------------------------
// Per-pool analysis. Sessions keyed by `${dir}::${session_id}` — session ids
// are only unique within a store; the store-qualified key removes the
// cross-store uuid-collision assumption at zero cost.
// ---------------------------------------------------------------------------

function analyze(stores) {
  const inventory = stores.map((s) => {
    const sessions = new Set(s.rows.map((r) => r.session_id));
    const tools = {};
    for (const r of s.rows) tools[r.tool_name] = (tools[r.tool_name] ?? 0) + 1;
    const timestamps = s.rows.map((r) => r.call_timestamp);
    return {
      dir: s.dir,
      rowCount: s.rowCount,
      metricsDailyRowCount: s.dailyRowCount,
      sessionCount: sessions.size,
      toolCounts: tools,
      nonzeroFullFileBoundRows: s.rows.filter((r) => r.tokens_full_file_upper_bound !== 0).length,
      minDate: new Date(Math.min(...timestamps) * 1000).toISOString(),
      maxDate: new Date(Math.max(...timestamps) * 1000).toISOString(),
    };
  });

  const allSessions = new Map();
  for (const s of stores) {
    for (const r of s.rows) {
      const key = `${s.dir}::${r.session_id}`;
      if (!allSessions.has(key)) allSessions.set(key, []);
      allSessions.get(key).push(r);
    }
  }

  const totalRows = [...allSessions.values()].reduce((a, r) => a + r.length, 0);
  const totalSessions = allSessions.size;
  const toolCounts = {};
  for (const rows of allSessions.values()) {
    for (const r of rows) toolCounts[r.tool_name] = (toolCounts[r.tool_name] ?? 0) + 1;
  }

  // Question 1 — loose sequential chain (upper bound on the true chain rate;
  // see schema limitation header comment).
  const chainResults = [];
  for (const [key, rowsUnsorted] of allSessions) {
    const rows = [...rowsUnsorted].sort((a, b) => a.call_timestamp - b.call_timestamp);
    const chains = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].tool_name !== 'mast_search') continue;
      for (let j = i + 1; j < rows.length; j++) {
        if (CHAIN_TARGETS.has(rows[j].tool_name)) {
          chains.push({
            searchRow: rows[i],
            followRow: rows[j],
            gapCalls: j - i,
            gapSeconds: rows[j].call_timestamp - rows[i].call_timestamp,
            tokenCost: rows[i].tokens_returned + rows[j].tokens_returned,
          });
          break; // count the first qualifying follow-on per search call
        }
      }
    }
    chainResults.push({ key, rowCount: rows.length, chainCount: chains.length, chains });
  }

  const sessionsWithChain = chainResults.filter((c) => c.chainCount > 0);
  const chainSessionRate = totalSessions > 0 ? sessionsWithChain.length / totalSessions : null;
  const eligibleSessions = chainResults.filter((c) => c.rowCount >= 2);
  const chainRateAmongEligible =
    eligibleSessions.length > 0 ? sessionsWithChain.length / eligibleSessions.length : null;

  const allChains = chainResults.flatMap((c) => c.chains);
  const chainsPerSessionDist = chainResults.map((c) => c.chainCount);
  const chainTokenCosts = allChains.map((c) => c.tokenCost);

  const perStoreBreakdown = stores.map((s) => {
    const sessionsInStore = new Set(s.rows.map((r) => r.session_id));
    const storeChainSessions = [...sessionsInStore].filter((sid) => {
      const c = chainResults.find((cr) => cr.key === `${s.dir}::${sid}`);
      return c && c.chainCount > 0;
    });
    return {
      dir: s.dir,
      sessionCount: sessionsInStore.size,
      sessionsWithChain: storeChainSessions.length,
      ratePct: sessionsInStore.size > 0
        ? Number(((storeChainSessions.length / sessionsInStore.size) * 100).toFixed(2))
        : null,
    };
  });

  // Question 2 — bounded estimate. Full reconstruction is NOT possible (no
  // query text / result identity persisted), so per plan §Stage 2.1 fallback:
  // capsuleTokens = min(budget, chainTotal) — an UPPER BOUND. Honesty caveat
  // (load-bearing): when chainTotal > budget the "saving" is an artifact of
  // budget truncation, not evidence of deduplication; when chainTotal <=
  // budget the bound correctly reports 0%, the only side with real meaning.
  function boundedCapsuleEstimate(budget) {
    const perChain = allChains.map((c) => {
      const capsuleTokens = Math.min(budget, c.tokenCost);
      const savingPct = c.tokenCost > 0 ? (1 - capsuleTokens / c.tokenCost) * 100 : 0;
      return { chainTotal: c.tokenCost, capsuleTokens, savingPct, truncated: c.tokenCost > budget };
    });
    const savings = perChain.map((p) => p.savingPct);
    return {
      budget,
      chainsConsidered: perChain.length,
      chainsRequiringTruncation: perChain.filter((p) => p.truncated).length,
      medianSavingPct: median(savings) === null ? null : Number(median(savings).toFixed(1)),
      note: 'Saving % is meaningful ONLY for chains where chainTotal <= budget (0% — no truncation). Where chainTotal > budget, the reported saving is an artifact of the budget cutting off content, not genuine deduplication.',
    };
  }

  return {
    inventory,
    aggregate: {
      storesWithData: stores.length,
      totalRows,
      totalSessions,
      toolCounts,
      // Explicit counts requested for the mast_path reserve-trigger question:
      mastCallersCalls: toolCounts['mast_callers'] ?? 0,
      mastDependenciesCalls: toolCounts['mast_dependencies'] ?? 0,
      mastSignatureCalls: toolCounts['mast_signature'] ?? 0,
      mastExportsCalls: toolCounts['mast_exports'] ?? 0,
      rowsWithNonzeroFullFileBound: inventory.reduce((a, i) => a + i.nonzeroFullFileBoundRows, 0),
    },
    question1: {
      definition:
        'loose upper bound: mast_search followed later in same session by mast_signature or mast_exports',
      sessionsWithChain: sessionsWithChain.length,
      totalSessions,
      chainSessionRatePct:
        chainSessionRate === null ? null : Number((chainSessionRate * 100).toFixed(2)),
      eligibleSessions: eligibleSessions.length,
      chainRateAmongEligiblePct:
        chainRateAmongEligible === null ? null : Number((chainRateAmongEligible * 100).toFixed(2)),
      chainsPerSessionDistribution: {
        min: chainsPerSessionDist.length ? Math.min(...chainsPerSessionDist) : null,
        median: median(chainsPerSessionDist),
        max: chainsPerSessionDist.length ? Math.max(...chainsPerSessionDist) : null,
      },
      totalChainsFound: allChains.length,
      chainTokenCost: {
        medianTokens: median(chainTokenCosts),
        p90Tokens: percentile(chainTokenCosts, 90),
        note: 'sum of tokens_returned for the search call + the follow-on call; approximate tokenizer counts, ratios are the robust number (§14.5)',
      },
      chainDetails: allChains.map((c) => ({
        session: c.searchRow.session_id,
        followTool: c.followRow.tool_name,
        gapCalls: c.gapCalls,
        gapSeconds: Number(c.gapSeconds.toFixed(3)),
        searchTokens: c.searchRow.tokens_returned,
        followTokens: c.followRow.tokens_returned,
        totalTokens: c.tokenCost,
      })),
      perStoreBreakdown,
      mechanicalGate:
        chainSessionRate === null
          ? 'INDETERMINATE — no sessions'
          : chainSessionRate < 0.1
            ? 'DEMOTE (<10% of sessions)'
            : 'gate passes on the LOOSE upper bound only; tight (result-linked) rate not derivable from this schema — INDETERMINATE for promotion; missing instrumentation: tool arguments / result file-or-symbol identifiers on the metrics row',
    },
    question2: {
      applicable: allChains.length > 0,
      reconstructionPossible: false,
      reconstructionBlockedBy:
        'metrics table has no query text and no result file/symbol identity — cannot verify whether the two calls in a chain returned overlapping content, which is the mechanism a capsule saves tokens through',
      boundedEstimateAssumption:
        'capsuleTokens = min(token_budget, chainTotalTokens) — an upper bound per plan §Stage 2.1 fallback, not a measurement of real savings',
      budget2000: allChains.length > 0 ? boundedCapsuleEstimate(2000) : undefined,
      budget4000: allChains.length > 0 ? boundedCapsuleEstimate(4000) : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Run all pools + combined
// ---------------------------------------------------------------------------

const poolStores = POOLS.map((p) => ({ pool: p, stores: loadPoolStores(p) }));
const combinedStores = poolStores.flatMap((ps) => ps.stores);

const results = {
  generatedAt: new Date().toISOString(),
  tokenizerLabel:
    '@anthropic-ai/tokenizer (claude-2 era, approximate for current models)',
  schemaCapability: {
    columnsPersisted: [
      'id', 'tool_name', 'call_timestamp', 'tokens_returned',
      'tokens_full_file_upper_bound', 'duration_ms', 'mode', 'session_id', 'status',
    ],
    canEstablish: [
      'which tools were called, in what order, within a session (via session_id + call_timestamp)',
      'token counts returned per call (approximate, see tokenizer label)',
      'call duration and status',
    ],
    cannotEstablish: [
      'tool arguments (query text, symbol name, file path passed to the call)',
      'result identity (which files/symbols a mast_search response actually returned)',
      'whether a later mast_signature/mast_exports call targeted a symbol the prior mast_search returned',
    ],
    consequence:
      'The chain can only be measured as a LOOSE sequential upper bound (mast_search followed by mast_signature/mast_exports later in the same session_id, regardless of argument overlap). The tightened "on a symbol/file the search returned" version is not derivable from any currently-persisted column.',
  },
  pools: poolStores.map((ps) => ({
    pool: ps.pool.name,
    kind: ps.pool.kind,
    ...analyze(ps.stores),
  })),
  combined: analyze(combinedStores),
};

writeFileSync(
  path.join(path.dirname(new URL(import.meta.url).pathname), 'results.json'),
  JSON.stringify(results, null, 2),
);

// Console summary (full detail lives in results.json)
for (const p of results.pools) {
  console.log(`\n=== Pool ${p.pool} ===`);
  console.log(`stores=${p.aggregate.storesWithData} rows=${p.aggregate.totalRows} sessions=${p.aggregate.totalSessions}`);
  console.log(`toolCounts=${JSON.stringify(p.aggregate.toolCounts)}`);
  console.log(`chain: ${p.question1.sessionsWithChain}/${p.question1.totalSessions} = ${p.question1.chainSessionRatePct}% (eligible-only ${p.question1.chainRateAmongEligiblePct}%)`);
  console.log(`chains found: ${p.question1.totalChainsFound}, median chain tokens: ${p.question1.chainTokenCost.medianTokens}, p90: ${p.question1.chainTokenCost.p90Tokens}`);
  console.log(`Q2: 2k=${JSON.stringify(p.question2.budget2000 ?? null)} 4k=${JSON.stringify(p.question2.budget4000 ?? null)}`);
  console.log(`gate: ${p.question1.mechanicalGate}`);
}
console.log(`\n=== Combined ===`);
const c = results.combined;
console.log(`stores=${c.aggregate.storesWithData} rows=${c.aggregate.totalRows} sessions=${c.aggregate.totalSessions}`);
console.log(`chain: ${c.question1.sessionsWithChain}/${c.question1.totalSessions} = ${c.question1.chainSessionRatePct}% (eligible-only ${c.question1.chainRateAmongEligiblePct}%)`);
console.log(`gate: ${c.question1.mechanicalGate}`);
console.log(`callers=${c.aggregate.mastCallersCalls} deps=${c.aggregate.mastDependenciesCalls} signature=${c.aggregate.mastSignatureCalls} exports=${c.aggregate.mastExportsCalls}`);
console.log(`rows with nonzero tokens_full_file_upper_bound: ${c.aggregate.rowsWithNonzeroFullFileBound} of ${c.aggregate.totalRows}`);
