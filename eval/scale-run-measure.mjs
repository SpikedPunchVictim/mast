// Q1/SCALE — Step 4 scored-measurement driver. NEW file, not a modification
// of any committed instrument script. scale-rank-check.mjs exports
// `measureOne` specifically so "a later, explicitly-scored phase" (its own
// header's words) can import it and run the registered sweep; its CLI entry
// point refuses to run a scored sweep directly (guarded off during
// instrument construction). This file is that later phase.
//
// Registered sweep (IMPLEMENTATION_PLAN.md, Q1/SCALE PRE-REGISTRATION):
// 150 S-ident + 100 S-prose + 150 S-approx = 400 scored queries (probes
// excluded) x 4 tiers x 2 arms = 3,200 core searches at limit=200.
//
// query_id is NOT present in scale-queries.json (frozen, uneditable) — a
// stable id is constructed here as `${stratum}_${index}`, using the FROZEN
// array order, so it is deterministic and reproducible across runs without
// touching the committed query file.
//
// Void handling (Gate 3, F for H mode integrity): the registration says an
// H call not returning mode:"hybrid" "voids that tier's H measurement."
// Both granularities are recorded: every call's own mode_integrity_valid
// (per-call), AND a per-(tier,arm=H) void flag if ANY call in that
// tier's H arm failed integrity.
//
//   node eval/scale-run-measure.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { openDatabase } from '../dist/graph/db.js';
import { SqliteChunkStore } from '../dist/store/sqliteChunkStore.js';
import { LanceStore } from '../dist/store/lance.js';
import { HarnessEmbedder } from './harness-embedder.mjs';
import { MODEL_CACHE_DIR } from './paths.mjs';
import { measureOne, validateResultRow } from './scale-rank-check.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_RESULTS_DIR = join(__dirname, 'results');
const ROOT = join(homedir(), '.cache', 'mast-eval');
const MODEL = 'jinaai/jina-embeddings-v2-base-code';
const TIERS = ['T1', 'T2', 'T3', 'T4'];
const SCORED_STRATA = ['s_ident', 's_approx', 's_prose'];

function tierStateDir(tier) {
  return tier === 'T4' ? join(ROOT, 'vscode-state-full') : join(ROOT, `vscode-state-${tier.toLowerCase()}`);
}

const queries = JSON.parse(readFileSync(join(__dirname, 'scale-queries.json'), 'utf8'));

const allRows = [];
const voidTiers = []; // { tier, arm: 'H', bad_call_count }
const t0Total = Date.now();

for (const tier of TIERS) {
  const stateDir = tierStateDir(tier);
  console.log(`\n=== ${tier} (${stateDir}) ===`);
  const db = openDatabase(stateDir);
  const chunkStore = new SqliteChunkStore(db);
  const lance = await LanceStore.open(stateDir);
  const embedder = new HarnessEmbedder(MODEL, MODEL_CACHE_DIR, stateDir, 'fp32');
  await embedder.load();

  let tierRowCount = 0;
  let tierHBadCalls = 0;
  let tierHCalls = 0;
  const tierT0 = Date.now();

  for (const stratum of SCORED_STRATA) {
    const stratumQueries = queries.strata[stratum].queries;
    for (let i = 0; i < stratumQueries.length; i++) {
      const q = stratumQueries[i];
      const queryId = `${stratum}_${i}`;
      for (const arm of ['H', 'L']) {
        const result = await measureOne({ db, lance, chunkStore, embedder, target: q.target, query: q.query, arm });

        if (arm === 'H') {
          tierHCalls++;
          if (!result.mode_integrity.valid) tierHBadCalls++;
        }

        const row = {
          query_id: queryId,
          stratum,
          tier,
          arm,
          mode: result.mode,
          mode_integrity_valid: result.mode_integrity.valid,
          rank: result.rank,
          hit_case: result.hit_case,
          suppression_event: result.suppression_event,
          censored_rank: result.censored_rank,
          in_window_10: result.in_window_10,
          pre_dedup_rank: result.pre_dedup_rank,
        };
        validateResultRow(row);
        allRows.push(row);
        tierRowCount++;
      }
      if ((i + 1) % 25 === 0 || i === stratumQueries.length - 1) {
        const elapsed = (Date.now() - tierT0) / 1000;
        console.log(`[${tier}/${stratum}] ${i + 1}/${stratumQueries.length} queries done (${tierRowCount} rows so far, ${elapsed.toFixed(1)}s elapsed)`);
      }
    }
  }

  if (tierHBadCalls > 0) {
    voidTiers.push({ tier, arm: 'H', bad_call_count: tierHBadCalls, total_h_calls: tierHCalls });
  }

  console.log(`[${tier}] done: ${tierRowCount} rows, H mode-integrity bad calls=${tierHBadCalls}/${tierHCalls}, ${((Date.now() - tierT0) / 1000).toFixed(1)}s`);
  await db.destroy();
}

const totalElapsedSec = (Date.now() - t0Total) / 1000;
console.log(`\n=== SCORED MEASUREMENT DONE: ${allRows.length} rows in ${totalElapsedSec.toFixed(1)}s ===`);
console.log(`Void tiers (H mode-integrity failure present): ${JSON.stringify(voidTiers)}`);

mkdirSync(REPO_RESULTS_DIR, { recursive: true });

const rawFile = join(REPO_RESULTS_DIR, 'scale-measure-raw.json');
writeFileSync(rawFile, JSON.stringify({
  ran_at: new Date().toISOString(),
  model: MODEL,
  tiers: TIERS,
  strata: SCORED_STRATA,
  expected_rows: SCORED_STRATA.reduce((acc, s) => acc + queries.strata[s].queries.length, 0) * TIERS.length * 2,
  actual_rows: allRows.length,
  elapsed_sec: totalElapsedSec,
  void_tiers: voidTiers,
  rows: allRows,
}, null, 2));
console.log(`wrote ${rawFile}`);

// Per-tier x arm x stratum summary counts — quick sanity view alongside the raw rows.
const summary = {};
for (const tier of TIERS) {
  summary[tier] = {};
  for (const arm of ['H', 'L']) {
    summary[tier][arm] = {};
    for (const stratum of SCORED_STRATA) {
      const rows = allRows.filter((r) => r.tier === tier && r.arm === arm && r.stratum === stratum);
      summary[tier][arm][stratum] = {
        n: rows.length,
        in_window_10_count: rows.filter((r) => r.in_window_10).length,
        censored_count: rows.filter((r) => r.rank === null).length,
        suppression_event_count: rows.filter((r) => r.suppression_event).length,
        mode_integrity_bad_count: rows.filter((r) => !r.mode_integrity_valid).length,
      };
    }
  }
}
const summaryFile = join(REPO_RESULTS_DIR, 'scale-measure-summary.json');
writeFileSync(summaryFile, JSON.stringify({ ran_at: new Date().toISOString(), void_tiers: voidTiers, summary }, null, 2));
console.log(`wrote ${summaryFile}`);
