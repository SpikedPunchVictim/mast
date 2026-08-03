// Q1/SCALE — Step 5 scoring driver. NEW file, not a modification of any
// committed instrument script. scale-score.mjs is a pure module (scoreStratum,
// evaluateVerdict, bcaBootstrap, etc.) with NO CLI entry point at all — by
// design, per its header: "NOT run on real data by this session." This file
// is the orchestration that reads eval/results/scale-measure-raw.json (written
// by scale-run-measure.mjs) and applies the registered decision procedure,
// using ONLY the committed scorer's exported functions (no re-derivation of
// scoring logic here).
//
// Delta-log2(rank) co-metric (F3, supporting-only, never dispositive): the
// registration names this metric but scale-score.mjs does not export an
// aggregate helper for it (only the per-value `log2CensoredRank`). Built here
// with the SAME sign convention as D_loss/Delta (F1): per query, per arm,
// D_log2_loss = log2CensoredRank(rank@T4) - log2CensoredRank(rank@T1)
// (positive = rank got worse, i.e. numerically larger, from T1 to T4);
// Delta_log2(query) = D_log2_loss_L - D_log2_loss_H (positive = lexical rank
// degrades more than hybrid, mirroring the primary Delta's direction). Its
// all-n seeded BCa CI is computed with the SAME `bcaBootstrap` used for the
// primary Delta CI, fed into `evaluateVerdict`'s registered consistency
// trigger 2 exactly as documented in the function's own JSDoc.
//
//   node eval/scale-run-score.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scoreStratum, bcaBootstrap, log2CensoredRank, trivialDischargeCheck,
  evaluateVerdict, VERDICTS, T4_CEILING_FRACTION,
} from './scale-score.mjs';
import { validateResultRow } from './scale-rank-check.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_RESULTS_DIR = join(__dirname, 'results');

const rawPath = join(REPO_RESULTS_DIR, 'scale-measure-raw.json');
const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
const rows = raw.rows;
rows.forEach(validateResultRow);

const STRATA = ['s_ident', 's_approx', 's_prose'];
const TIERS = ['T1', 'T2', 'T3', 'T4'];
const mean = (arr) => (arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length);

// ---------------------------------------------------------------------------
// Decision-bearing + supporting strata via the committed scorer
// ---------------------------------------------------------------------------

const strataResults = {};
for (const s of STRATA) strataResults[s] = scoreStratum(rows, s);

// ---------------------------------------------------------------------------
// Delta-log2(rank) co-metric (S-ident, per header note above)
// ---------------------------------------------------------------------------

function pairByQuery(rowsIn, stratum, tier, arm) {
  const map = new Map();
  for (const r of rowsIn) {
    if (r.stratum !== stratum || r.tier !== tier || r.arm !== arm) continue;
    map.set(r.query_id, r);
  }
  return map;
}

function computeDLog2Loss(rowsIn, stratum, arm) {
  const t1 = pairByQuery(rowsIn, stratum, 'T1', arm);
  const t4 = pairByQuery(rowsIn, stratum, 'T4', arm);
  const out = new Map();
  for (const [qid, r1] of t1) {
    const r4 = t4.get(qid);
    if (r4 === undefined) continue;
    out.set(qid, log2CensoredRank(r4.rank) - log2CensoredRank(r1.rank));
  }
  return out;
}

const dLog2LossH = computeDLog2Loss(rows, 's_ident', 'H');
const dLog2LossL = computeDLog2Loss(rows, 's_ident', 'L');
const log2QueryIds = [...dLog2LossH.keys()].filter((qid) => dLog2LossL.has(qid));
const deltaLog2Values = log2QueryIds.map((qid) => dLog2LossL.get(qid) - dLog2LossH.get(qid));
const deltaLog2Bca = bcaBootstrap(deltaLog2Values, mean, { seed: 1002 });
const deltaLog2CI = { lo: deltaLog2Bca.lo, hi: deltaLog2Bca.hi };

// ---------------------------------------------------------------------------
// T4-ceiling trivial discharge, per stratum (F3) — decision-bearing (S-ident)
// feeds evaluateVerdict; other strata reported for completeness.
// ---------------------------------------------------------------------------

function t4CeilingCheck(stratum) {
  const hT4 = rows.filter((r) => r.stratum === stratum && r.tier === 'T4' && r.arm === 'H');
  const lT4 = rows.filter((r) => r.stratum === stratum && r.tier === 'T4' && r.arm === 'L');
  const n = hT4.length; // == lT4.length by construction (same query set both arms)
  const hCount = hT4.filter((r) => r.in_window_10).length;
  const lCount = lT4.filter((r) => r.in_window_10).length;
  const threshold = Math.ceil(T4_CEILING_FRACTION * n);
  return {
    stratum, n, h_in_window_count: hCount, l_in_window_count: lCount,
    threshold, triggers: trivialDischargeCheck(hCount, lCount, n),
  };
}

const t4CeilingByStratum = {};
for (const s of STRATA) t4CeilingByStratum[s] = t4CeilingCheck(s);

// ---------------------------------------------------------------------------
// Consistency trigger 1 inputs — supporting strata all-n BCa CIs
// ---------------------------------------------------------------------------

const supportingCIs = [
  { name: 's_prose', lo: strataResults.s_prose.bca_delta_ci.lo, hi: strataResults.s_prose.bca_delta_ci.hi },
  { name: 's_approx', lo: strataResults.s_approx.bca_delta_ci.lo, hi: strataResults.s_approx.bca_delta_ci.hi },
];

// ---------------------------------------------------------------------------
// Consistency trigger 3 — monotonicity. Per-tier mean in_window_10 (S-ident,
// H and L) with a normal-approx 95% CI on the proportion; flagged if the tier
// mean falls outside the [T1,T4] envelope by more than its own CI half-width.
// Reported/discussed only — never alone forces AMBIGUOUS, per the
// registration and per evaluateVerdict's own handling.
// ---------------------------------------------------------------------------

function tierMeanInWindow(stratum, tier, arm) {
  const rs = rows.filter((r) => r.stratum === stratum && r.tier === tier && r.arm === arm);
  const n = rs.length;
  const p = mean(rs.map((r) => Number(r.in_window_10)));
  const se = n > 0 ? Math.sqrt((p * (1 - p)) / n) : null;
  return { n, p, se };
}

const monotonicityFlags = [];
const doseResponse = {};
for (const arm of ['H', 'L']) {
  doseResponse[arm] = {};
  const t1 = tierMeanInWindow('s_ident', 'T1', arm);
  const t4 = tierMeanInWindow('s_ident', 'T4', arm);
  const lo = Math.min(t1.p, t4.p);
  const hi = Math.max(t1.p, t4.p);
  for (const tier of TIERS) {
    const m = tierMeanInWindow('s_ident', tier, arm);
    doseResponse[arm][tier] = m;
    if (tier === 'T1' || tier === 'T4') continue;
    const ciHalfWidth = m.se !== null ? 1.96 * m.se : 0;
    const outsideEnvelope = m.p < lo - ciHalfWidth || m.p > hi + ciHalfWidth;
    if (outsideEnvelope) monotonicityFlags.push({ tier, arm, outsideEnvelope: true, mean: m.p, envelope: [lo, hi] });
  }
}

// ---------------------------------------------------------------------------
// Zero / censoring / suppression counts per arm x tier x stratum
// ---------------------------------------------------------------------------

const perCellCounts = {};
for (const s of STRATA) {
  perCellCounts[s] = {};
  for (const tier of TIERS) {
    perCellCounts[s][tier] = {};
    for (const arm of ['H', 'L']) {
      const rs = rows.filter((r) => r.stratum === s && r.tier === tier && r.arm === arm);
      perCellCounts[s][tier][arm] = {
        n: rs.length,
        censored_count: rs.filter((r) => r.rank === null).length,
        suppression_event_count: rs.filter((r) => r.suppression_event).length,
        mode_integrity_bad_count: rs.filter((r) => !r.mode_integrity_valid).length,
        in_window_10_count: rs.filter((r) => r.in_window_10).length,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Verdict — registered logic only, via the committed evaluateVerdict
// ---------------------------------------------------------------------------

const verdictResult = evaluateVerdict({
  wilcoxon: strataResults.s_ident.wilcoxon,
  bcaDeltaCI: strataResults.s_ident.bca_delta_ci,
  trivialDischarge: t4CeilingByStratum.s_ident.triggers,
  supportingCIs,
  deltaLog2CI,
  monotonicityFlags,
});

// ---------------------------------------------------------------------------
// Assemble + write
// ---------------------------------------------------------------------------

const report = {
  ran_at: new Date().toISOString(),
  source_raw_file: rawPath,
  source_row_count: rows.length,
  decision_bearing: {
    stratum: 's_ident',
    n: strataResults.s_ident.n,
    zero_count: strataResults.s_ident.zero_count,
    wilcoxon: strataResults.s_ident.wilcoxon,
    hodges_lehmann_descriptive_only: strataResults.s_ident.hodges_lehmann,
    bca_delta_ci_all_n: strataResults.s_ident.bca_delta_ci,
  },
  supporting: {
    s_approx: {
      n: strataResults.s_approx.n,
      zero_count: strataResults.s_approx.zero_count,
      wilcoxon: strataResults.s_approx.wilcoxon,
      hodges_lehmann_descriptive_only: strataResults.s_approx.hodges_lehmann,
      bca_delta_ci_all_n: strataResults.s_approx.bca_delta_ci,
    },
    s_prose: {
      n: strataResults.s_prose.n,
      zero_count: strataResults.s_prose.zero_count,
      wilcoxon: strataResults.s_prose.wilcoxon,
      hodges_lehmann_descriptive_only: strataResults.s_prose.hodges_lehmann,
      bca_delta_ci_all_n: strataResults.s_prose.bca_delta_ci,
    },
    delta_log2_rank_co_metric: {
      n: deltaLog2Values.length,
      bca_ci_all_n: deltaLog2CI,
      theta_hat: deltaLog2Bca.thetaHat,
    },
    dose_response_in_window_10_by_tier: doseResponse,
  },
  t4_ceiling_trivial_discharge: t4CeilingByStratum,
  consistency_triggers: {
    trigger_1_supporting_ci_excludes_zero: supportingCIs.filter((s) => s.lo !== null && s.lo > 0),
    trigger_2_delta_log2_ci_excludes_zero: deltaLog2CI.lo !== null && deltaLog2CI.lo > 0,
    trigger_3_monotonicity_flags: monotonicityFlags,
  },
  per_cell_counts: perCellCounts,
  verdict: {
    row: verdictResult.row,
    verdict: verdictResult.verdict,
    reasoning: verdictResult.reasoning,
    escalated_to_ambiguous: verdictResult.escalatedToAmbiguous,
  },
};

mkdirSync(REPO_RESULTS_DIR, { recursive: true });
const outFile = join(REPO_RESULTS_DIR, 'scale-score-output.json');
writeFileSync(outFile, JSON.stringify(report, null, 2));

console.log(JSON.stringify(report, null, 2));
console.log(`\nwrote ${outFile}`);
console.log(`\n=== VERDICT: ${verdictResult.verdict} (row ${verdictResult.row}) ===`);
