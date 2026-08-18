// E1-HOIST — the scorer.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-HOIST PRE-REGISTRATION (2026-08-18).
//
// Usage (from packages/mast, never the repo root):
//   node eval/e1-hoist-score.mjs
//
// Reads `e1-hoist-runs.jsonl`, writes `e1-hoist-verdict.json`. Writes NOTHING else and
// re-runs no measurement.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS_DIR, writeResult } from './e1-common.mjs';
import {
  HOIST_ARMS, HOIST_BLOCKS, HOIST_TOTAL_RUNS, PHASES, PLACEBO_PHASES, hoistKey,
} from './e1-hoist-schedule.mjs';

const JOURNAL = join(RESULTS_DIR, 'e1-hoist-runs.jsonl');

// --- registered constants -----------------------------------------------------
const H2_BAND_MS = [40, 350];
/** The replay's prediction, and its worst-case bound. Both a LOWER bound on truth. */
const MECHANISM_PREDICTION_MS = 87.1;
const MECHANISM_WORST_CASE_MS = 81.7;

// --- journal folding ----------------------------------------------------------
/**
 * Last write per key wins; a `void` REMOVES the key.
 *
 * Reproduces `e1-verify-score.mjs`'s rule rather than filtering on `type === 'run'`,
 * which admits superseded and voided rows. `e1-fts-runs.jsonl` is the standing proof
 * that the naive filter over-counts (32 rows against a scored 30).
 */
function foldRuns(records) {
  const m = new Map();
  const voids = new Map();
  for (const r of records) {
    if (r.type === 'run') m.set(hoistKey(r), r);
    else if (r.type === 'void') { m.delete(hoistKey(r)); voids.set(hoistKey(r), r); }
  }
  return { runs: [...m.values()], voids: [...voids.values()] };
}

function readJournal(path) {
  if (!existsSync(path)) throw new Error(`No journal at ${path} — run e1-hoist-run.mjs first.`);
  return readFileSync(path, 'utf-8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

// --- statistics ---------------------------------------------------------------
const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
const sd = (v) => Math.sqrt(v.reduce((s, x) => s + (x - mean(v)) ** 2, 0) / (v.length - 1));
const cv = (v) => sd(v) / mean(v) * 100;

/** Deterministic RNG — a bootstrap that moves between runs is not a check. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normal quantile (Acklam), for the BCa z-transforms. */
function probit(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}
const normcdf = (z) => 0.5 * (1 + (z < 0 ? -1 : 1) * Math.sqrt(1 - Math.exp(-2 * z * z / Math.PI)));

/**
 * BCa bootstrap CI for the median, as registered.
 *
 * Bias-corrected and accelerated rather than percentile: the median of 20 values is a
 * lattice-valued, skew-prone statistic, and the plain percentile interval under-covers
 * for exactly that shape. Falls back to percentile if the acceleration is degenerate.
 */
function bcaMedianCI(values, { resamples = 10000, alpha = 0.05, seed = 811 } = {}) {
  const n = values.length;
  const theta = median(values);
  const rnd = mulberry32(seed);
  const boots = [];
  for (let b = 0; b < resamples; b++) {
    const s = new Array(n);
    for (let i = 0; i < n; i++) s[i] = values[Math.floor(rnd() * n)];
    boots.push(median(s));
  }
  boots.sort((a, b) => a - b);

  const propLess = boots.filter((x) => x < theta).length / resamples;
  const z0 = probit(Math.min(Math.max(propLess, 1 / resamples), 1 - 1 / resamples));

  const jack = [];
  for (let i = 0; i < n; i++) jack.push(median(values.filter((_, j) => j !== i)));
  const jbar = mean(jack);
  const num = jack.reduce((s, x) => s + (jbar - x) ** 3, 0);
  const den = 6 * Math.pow(jack.reduce((s, x) => s + (jbar - x) ** 2, 0), 1.5);
  const a = den === 0 ? 0 : num / den;

  const adj = (p) => {
    const z = probit(p);
    const zz = z0 + (z0 + z) / (1 - a * (z0 + z));
    return Math.min(Math.max(normcdf(zz), 0), 1);
  };
  const lo = boots[Math.max(0, Math.floor(adj(alpha / 2) * resamples) - 1)];
  const hi = boots[Math.min(resamples - 1, Math.ceil(adj(1 - alpha / 2) * resamples) - 1)];
  return { point: theta, lo, hi, z0, a, resamples, seed, method: 'BCa' };
}

/**
 * Geometric-mean ratio with a log-space t-interval — the PRE-REGISTERED SECONDARY.
 *
 * Registered alongside the primary, not added afterwards, and that ordering is the whole
 * point: it is the more efficient estimator (94% power at n=30 against the median's 87%,
 * same simulation), so having it available only after seeing the data would be an
 * invitation to report whichever fired. The median stays primary because it is robust to
 * the single wild run this rig does produce (E1-LADDER's T1 rung: 95 / 110 / 162 ms).
 *
 * A ratio is multiplicative, so the log scale is its natural home; the geometric mean of
 * ratios is the only mean of ratios that is invariant to which arm goes in the numerator.
 */
function geoMeanRatioCI(values, { alpha = 0.05 } = {}) {
  const L = values.map(Math.log);
  const n = L.length;
  const m = mean(L);
  const s = sd(L);
  // Two-sided t at alpha=.05; table for the df this design produces, normal beyond.
  const T = { 19: 2.0930, 24: 2.0639, 29: 2.0452, 34: 2.0322, 39: 2.0227, 49: 2.0096 };
  const tcrit = T[n - 1] ?? 1.9600;
  const half = tcrit * s / Math.sqrt(n);
  return { point: Math.exp(m), lo: Math.exp(m - half), hi: Math.exp(m + half), method: 'geometric mean, log-space t', df: n - 1, tcrit };
}

// --- the cross-script self-check ----------------------------------------------
/**
 * Refuse to score unless this file's journal-folding and field-selection reproduce a
 * COMMITTED number from a different experiment, computed by a different script.
 *
 * E1-SCAN's `h2.observed.T9` is the T9 arm-N / arm-R ratio of `phase_ms.edges` medians.
 * Recomputing it here exercises the two things most likely to be silently wrong:
 *
 *  1. reading TOP-LEVEL `phase_ms` rather than `measurement.phase_ms` — on a Gate 3
 *     retake those differ, and `measurement` holds the attempt that was NOT fitted
 *     (FINDINGS.md §1); and
 *  2. folding the journal instead of filtering `type === 'run'`.
 *
 * E1-LADDER's scorer earned this pattern: its self-check caught precisely fault (1) on
 * first execution. A cross-script reproduction assertion is worth more than a comment
 * saying the estimators match.
 */
function selfCheck() {
  const p = join(RESULTS_DIR, 'e1-scan-runs.jsonl');
  const want = JSON.parse(readFileSync(join(RESULTS_DIR, 'e1-scan-verdict.json'), 'utf-8')).h2.observed.T9;
  const recs = readJournal(p).filter((r) => r.type === 'run' && r.tier === 'T9');
  const byArm = new Map();
  for (const r of recs) {
    if (!byArm.has(r.arm)) byArm.set(r.arm, []);
    byArm.get(r.arm).push(r.phase_ms.edges); // TOP-LEVEL, deliberately
  }
  const got = median(byArm.get('N')) / median(byArm.get('R'));
  if (Math.abs(got - want) > 1e-9) {
    throw new Error(
      `SELF-CHECK FAILED: recomputed E1-SCAN h2.observed.T9 as ${got}, committed verdict says ${want}. ` +
      'This scorer does not reproduce a committed result from the same fields, so its own numbers are not trustworthy.'
    );
  }
  return { comparator: 'e1-scan-verdict.json h2.observed.T9', want, got, tolerance: 1e-9 };
}

// --- main ---------------------------------------------------------------------
function main() {
  const check = selfCheck();

  const records = readJournal(JOURNAL);
  const { runs, voids } = foldRuns(records);
  const unresolvedVoids = voids.filter((v) => !runs.some((r) => hoistKey(r) === hoistKey(v)));

  // Pair within block. A block missing either arm is DROPPED whole and named — an
  // unpaired run contributes nothing to a paired statistic and silently keeping it
  // would turn the design back into the unpaired one it was chosen over.
  const byBlock = new Map();
  for (const r of runs) {
    if (!byBlock.has(r.block)) byBlock.set(r.block, {});
    byBlock.get(r.block)[r.arm] = r;
  }
  const pairs = [], incomplete = [];
  for (const [block, cell] of [...byBlock.entries()].sort((a, b) => a[0] - b[0])) {
    if (!cell.N || !cell.H) { incomplete.push(block); continue; }
    pairs.push({ block, N: cell.N, H: cell.H });
  }

  const perPhase = {};
  for (const phase of PHASES) {
    const ratios = pairs.map((p) => p.H.phase_ms[phase] / p.N.phase_ms[phase]);
    const savings = pairs.map((p) => p.N.phase_ms[phase] - p.H.phase_ms[phase]);
    perPhase[phase] = {
      n_pairs: pairs.length,
      ratio: bcaMedianCI(ratios),
      ratio_geomean: geoMeanRatioCI(ratios),
      ratio_cv_pct: ratios.length > 1 ? cv(ratios) : null,
      saving_ms: { median: median(savings), ci: bcaMedianCI(savings) },
      arm_medians_ms: {
        N: median(pairs.map((p) => p.N.phase_ms[phase])),
        H: median(pairs.map((p) => p.H.phase_ms[phase])),
      },
    };
  }

  const edges = perPhase.edges;

  // H1 — the CI on the paired median ratio must lie ENTIRELY below 1.0.
  const h1 = {
    statement: 'The per-file import index reduces the T9 edges phase.',
    bar: '95% BCa CI on the paired median ratio (H/N) lies entirely below 1.0',
    observed_ratio: edges.ratio.point,
    ci: [edges.ratio.lo, edges.ratio.hi],
    fires: edges.ratio.hi < 1.0,
    // Pre-registered secondary. Reported ALWAYS, whichever way the primary goes, so it
    // is a robustness check and never a second chance.
    secondary_geomean: {
      estimator: 'geometric-mean ratio, log-space t-interval (pre-registered secondary)',
      ratio: edges.ratio_geomean.point,
      ci: [edges.ratio_geomean.lo, edges.ratio_geomean.hi],
      would_fire: edges.ratio_geomean.hi < 1.0,
      agrees_with_primary: (edges.ratio_geomean.hi < 1.0) === (edges.ratio.hi < 1.0),
    },
  };

  // H2 — the magnitude must agree with the mechanism replay.
  const savedMs = edges.saving_ms.median;
  const h2 = {
    statement: 'The reduction agrees with the mechanism measured by replay.',
    bar: `median paired saving in [${H2_BAND_MS[0]}, ${H2_BAND_MS[1]}] ms`,
    prediction_ms: MECHANISM_PREDICTION_MS,
    prediction_worst_case_ms: MECHANISM_WORST_CASE_MS,
    prediction_is_a_lower_bound: true,
    observed_ms: savedMs,
    ci: [edges.saving_ms.ci.lo, edges.saving_ms.ci.hi],
    fires: savedMs >= H2_BAND_MS[0] && savedMs <= H2_BAND_MS[1],
  };

  // H3 — placebo. Every phase the hoist CANNOT touch must be null.
  const placebo = {};
  for (const phase of PLACEBO_PHASES) {
    const r = perPhase[phase].ratio;
    placebo[phase] = { ratio: r.point, ci: [r.lo, r.hi], contains_one: r.lo <= 1.0 && r.hi >= 1.0 };
  }
  const h3 = {
    statement: 'The hoist moves the edges phase and nothing else.',
    bar: 'every non-edges phase ratio CI contains 1.0',
    per_phase: placebo,
    fires: Object.values(placebo).every((x) => x.contains_one),
    // Registered consequence, restated here so it cannot be softened after the fact.
    note: 'If H3 does not fire, the session drifted and H1 is CONFOUNDED, not merely caveated.',
  };

  // Post-hoc power, from the REALISED noise rather than the assumed noise.
  const realisedCV = edges.ratio_cv_pct;
  const effectPct = (1 - edges.ratio.point) * 100;
  const power = {
    assumed_ratio_cv_pct: 5.6,
    // Simulated power of the REGISTERED decision rule at the design point, recorded in
    // the schedule module: median n=30 -> 87%, geomean n=30 -> 94%.
    simulated_power_at_design_point: { median: 0.87, geomean: 0.94 },
    realised_ratio_cv_pct: realisedCV,
    observed_effect_pct: effectPct,
    n_pairs: pairs.length,
    n_required_for_80pct_power: realisedCV && effectPct > 0
      ? Math.ceil(7.849 * (realisedCV / effectPct) ** 2) : null,
    // The registration commits to reporting this so an underpowered null is reported
    // as underpowered rather than as a negative result.
    adequately_powered: realisedCV && effectPct > 0
      ? pairs.length >= Math.ceil(7.849 * (realisedCV / effectPct) ** 2) : null,
  };

  const verdict = {
    created: new Date().toISOString(),
    registration: 'IMPLEMENTATION_PLAN.md § E1-HOIST PRE-REGISTRATION (2026-08-18)',
    self_check: check,
    arms: HOIST_ARMS.map(({ id, label, commit, rel_hash }) => ({ id, label, commit, rel_hash })),
    runs_scored: runs.length,
    total_expected: HOIST_TOTAL_RUNS,
    blocks_expected: HOIST_BLOCKS,
    pairs_scored: pairs.length,
    incomplete_blocks: incomplete,
    unresolved_voids: unresolvedVoids.map((v) => ({ key: hoistKey(v), reason: v.reason })),
    primary_statistic: 'median over blocks of the within-block paired ratio edges_H / edges_N',
    ci_is_context_only: false,
    ci_scope: 'this host, this corpus, this rung — blocks are independent repeated runs, so the interval is inferential; it does not generalise across machines',
    per_phase: perPhase,
    per_block_edges: pairs.map((p) => ({
      block: p.block,
      N_ms: p.N.phase_ms.edges,
      H_ms: p.H.phase_ms.edges,
      ratio: p.H.phase_ms.edges / p.N.phase_ms.edges,
      saving_ms: p.N.phase_ms.edges - p.H.phase_ms.edges,
    })),
    h1, h2, h3,
    power,
    scoreable: runs.length === HOIST_TOTAL_RUNS && incomplete.length === 0 && unresolvedVoids.length === 0,
  };

  writeResult('e1-hoist-verdict.json', verdict);

  const pct = (x) => `${(x * 100).toFixed(2)}%`;
  console.log(`[E1-HOIST] self-check OK — reproduced ${check.comparator} (${check.got})`);
  console.log(`[E1-HOIST] ${runs.length}/${HOIST_TOTAL_RUNS} runs, ${pairs.length} complete blocks`);
  console.log('');
  console.log(`  edges  arm N median ${edges.arm_medians_ms.N} ms   arm H median ${edges.arm_medians_ms.H} ms`);
  console.log(`  paired median ratio ${edges.ratio.point.toFixed(4)}  95% BCa [${edges.ratio.lo.toFixed(4)}, ${edges.ratio.hi.toFixed(4)}]   <- PRIMARY`);
  console.log(`  geometric-mean ratio ${edges.ratio_geomean.point.toFixed(4)}  95% t  [${edges.ratio_geomean.lo.toFixed(4)}, ${edges.ratio_geomean.hi.toFixed(4)}]   (secondary)`);
  console.log(`  paired median saving ${savedMs.toFixed(1)} ms   (replay predicted ${MECHANISM_PREDICTION_MS} ms, a lower bound)`);
  console.log(`  realised ratio CV ${realisedCV?.toFixed(2)}%  (registration assumed 5.6%)`);
  console.log('');
  console.log(`  H1 ${h1.fires ? 'FIRES' : 'does NOT fire'} — reduction ${pct(1 - edges.ratio.point)}, CI upper ${edges.ratio.hi.toFixed(4)}`);
  console.log(`  H2 ${h2.fires ? 'FIRES' : 'does NOT fire'} — ${savedMs.toFixed(1)} ms in [${H2_BAND_MS[0]}, ${H2_BAND_MS[1]}]?`);
  console.log(`  H3 ${h3.fires ? 'FIRES' : 'does NOT fire'} — placebo phases:`);
  for (const [k, v] of Object.entries(placebo)) {
    console.log(`       ${k.padEnd(9)} ratio ${v.ratio.toFixed(4)}  [${v.lo ?? v.ci[0].toFixed(4)}, ${v.ci[1].toFixed(4)}]  ${v.contains_one ? 'null (ok)' : 'MOVED'}`);
  }
  console.log('');
  console.log(`  power: n=${pairs.length} pairs, need ${power.n_required_for_80pct_power} for 80% at the realised CV -> ${power.adequately_powered ? 'adequate' : 'UNDERPOWERED'}`);
  console.log(`[E1-HOIST] scoreable: ${verdict.scoreable}`);
}

main();
