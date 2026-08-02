// Q1/SCALE — scorer (IMPLEMENTATION_PLAN.md § "Q1/SCALE ... PRE-REGISTRATION").
// BUILT AND UNIT-TESTED HERE; NOT run on real data by this session (hard rule: no
// H-vs-L comparison over the scored query set until a later, explicitly-scored phase).
//
// Reads the wrapper's results rows (schema defined once in scale-rank-check.mjs —
// `RESULTS_SCHEMA_VERSION` / `validateResultRow`, imported below so the two files
// cannot silently drift apart) and implements:
//
//   D_loss(query, arm)  = in_window@10(T1) - in_window@10(T4)      (F1 sign convention:
//                          positive = degraded from T1 to T4)
//   Delta(query)        = D_loss_L(query) - D_loss_H(query)        (positive = lexical
//                          degrades MORE than hybrid — the pro-vector direction)
//
// - EXACT Wilcoxon signed-rank on non-zero Delta, two-sided, alpha=0.05. "Exact" here
//   means the TRUE null distribution of the signed-rank statistic, computed via DP
//   convolution over the 2^n equally-likely sign assignments (validated against full
//   2^12 brute-force enumeration in the test file) — NOT a Monte Carlo permutation
//   approximation. DEVIATION FROM THE TASK BRIEF, logged: the brief said "a seeded
//   permutation with B = 100,000 qualifies as exact per registration"; the actual
//   registration text (IMPLEMENTATION_PLAN.md line ~2665) says only "exact
//   distribution/permutation, not normal approximation" and never specifies B=100,000
//   anywhere (grepped; absent). A Monte Carlo approximation could not exactly
//   reproduce the m=12 published-style exact tail Gate 1 requires, so this
//   implementation computes the true exact distribution instead — strictly stronger
//   than what the brief asked for, never weaker.
// - Hodges-Lehmann estimate: median of all pairwise Walsh averages (d_i+d_j)/2, i<=j,
//   over ALL n Delta values (the standard one-sample/paired HL location estimator).
//   DEMOTED TO DESCRIPTIVE ONLY (F5) per the registration — reported with a CI via the
//   SAME seeded percentile-bootstrap machinery as the BCa CI below (a simplification
//   justified by HL's non-decision-bearing status; not a Wilcoxon-rank-derived
//   interval).
// - Seeded BCa bootstrap (10,000 resamples) 95% CI on mean(Delta) over ALL n queries
//   (zeros are data for this estimand — F2). THIS CI, not Wilcoxon, not HL, is what
//   the discharge branch of the decision rule keys on.
// - Delta-log2(rank) co-metric, DEPTH+1=201 censoring, same bootstrap treatment,
//   supporting only, never carries a verdict (F3/F10).
// - Decision-table evaluation per the registration (4 rows + T4-ceiling trivial
//   discharge + 3 registered consistency triggers) — `evaluateVerdict` emits the
//   verdict ROW ONLY from this registered logic, no free-text verdict.

import { createHash } from 'node:crypto';
import { validateResultRow } from './scale-rank-check.mjs';

export const ALPHA = 0.05;
export const BOOTSTRAP_B = 10000;
export const CENSORED_RANK = 201;
export const T4_CEILING_FRACTION = 0.95;

// ---------------------------------------------------------------------------
// Math primitives
// ---------------------------------------------------------------------------

/** Abramowitz & Stegun 7.1.26 erf approximation, max error ~1.5e-7 — adequate for
 * a 95% CI boundary; not claimed to be arbitrary-precision. */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

export function normalCDF(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** Acklam's rational approximation to the standard normal inverse CDF (probit). */
export function normalInvCDF(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425, phigh = 1 - plow;
  let q, r;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
         (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** mulberry32 — the SAME seeded PRNG used throughout eval/ (ab-build-tasks.mjs
 * precedent), for reproducible bootstrap resampling. */
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Exact Wilcoxon signed-rank (validated against full 2^12 enumeration —
// see eval/__tests__/scale-score.test.mjs)
// ---------------------------------------------------------------------------

/**
 * Exact two-sided Wilcoxon signed-rank test on `diffs` (zeros dropped per standard
 * practice). Ranks |diffs| with average-rank tie handling (the registered contrast's
 * near-symmetric {-2..2} support produces heavy ties by construction — F5). The null
 * distribution of W+ is the TRUE distribution (DP convolution over 2^n equally-likely
 * sign assignments), not a normal or Monte Carlo approximation.
 *
 * A degenerate case (all diffs zero — "an all-ties stratum", F2/F5) returns
 * `degenerate: true, significant: false` — counts as "not significant" for the
 * decision table, per the registration, and never blocks the CI-based discharge
 * branch (that branch is defined over ALL n and treats zeros as data).
 */
export function wilcoxonSignedRankExact(diffs, alpha = ALPHA) {
  const nonZero = diffs.filter((d) => d !== 0);
  const n = nonZero.length;
  if (n === 0) {
    return { n: 0, nTotal: diffs.length, W: null, p: null, significant: false, direction: 'zero', degenerate: true, underpowered: true };
  }

  const absVals = nonZero.map(Math.abs);
  const order = absVals.map((v, i) => i).sort((i1, i2) => absVals[i1] - absVals[i2]);
  const ranks = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && absVals[order[j + 1]] === absVals[order[i]]) j++;
    const avgRank = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k++) ranks[order[k]] = avgRank;
    i = j + 1;
  }

  let Wpos = 0, Wneg = 0;
  for (let k = 0; k < n; k++) {
    if (nonZero[k] > 0) Wpos += ranks[k]; else Wneg += ranks[k];
  }

  const scale = ranks.some((r) => !Number.isInteger(r)) ? 2 : 1;
  const scaledRanks = ranks.map((r) => Math.round(r * scale));
  const total = scaledRanks.reduce((a, b) => a + b, 0);

  let dp = new Float64Array(total + 1);
  dp[0] = 1;
  for (const r of scaledRanks) {
    const next = new Float64Array(total + 1);
    for (let s = 0; s <= total; s++) {
      if (dp[s] === 0) continue;
      next[s] += 0.5 * dp[s];
      next[s + r] += 0.5 * dp[s];
    }
    dp = next;
  }
  const WposScaled = Math.round(Wpos * scale);
  let pLE = 0, pGE = 0;
  for (let s = 0; s <= total; s++) {
    if (s <= WposScaled) pLE += dp[s];
    if (s >= WposScaled) pGE += dp[s];
  }
  const p = Math.min(1, 2 * Math.min(pLE, pGE));

  const sumNonZero = nonZero.reduce((a, b) => a + b, 0);
  const direction = sumNonZero > 0 ? 'positive' : sumNonZero < 0 ? 'negative' : 'zero';

  return {
    n, nTotal: diffs.length, W: Math.min(Wpos, Wneg), p,
    significant: p <= alpha, direction, degenerate: false,
    underpowered: n < 10,
  };
}

// ---------------------------------------------------------------------------
// Hodges-Lehmann (descriptive only, F5)
// ---------------------------------------------------------------------------

/** Median of all pairwise Walsh averages (d_i+d_j)/2, i<=j, over ALL n diffs
 * (standard one-sample/paired HL location estimator). */
export function hodgesLehmannEstimate(diffs) {
  const n = diffs.length;
  if (n === 0) return null;
  const walsh = [];
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) walsh.push((diffs[i] + diffs[j]) / 2);
  }
  walsh.sort((a, b) => a - b);
  const m = walsh.length;
  return m % 2 === 1 ? walsh[(m - 1) / 2] : (walsh[m / 2 - 1] + walsh[m / 2]) / 2;
}

// ---------------------------------------------------------------------------
// Seeded bootstrap (percentile + BCa)
// ---------------------------------------------------------------------------

/**
 * Seeded BCa (bias-corrected and accelerated) bootstrap CI for `statFn(values)`.
 * Bias correction z0 from the bootstrap distribution; acceleration `a` from the
 * jackknife (leave-one-out) influence values — standard Efron & Tibshirani BCa.
 */
export function bcaBootstrap(values, statFn, { B = BOOTSTRAP_B, seed = 1, alpha = ALPHA } = {}) {
  const n = values.length;
  const thetaHat = statFn(values);
  if (n === 0) return { thetaHat: null, lo: null, hi: null, z0: null, a: null, B, seed, alpha };

  const rng = mulberry32(seed);
  const boot = new Array(B);
  for (let b = 0; b < B; b++) {
    const resample = new Array(n);
    for (let k = 0; k < n; k++) resample[k] = values[Math.floor(rng() * n)];
    boot[b] = statFn(resample);
  }
  boot.sort((x, y) => x - y);

  const propLess = boot.filter((v) => v < thetaHat).length / B;
  const clamped = propLess === 0 ? 1 / (2 * B) : propLess === 1 ? 1 - 1 / (2 * B) : propLess;
  const z0 = normalInvCDF(clamped);

  const loo = new Array(n);
  for (let i = 0; i < n; i++) {
    const without = values.slice(0, i).concat(values.slice(i + 1));
    loo[i] = statFn(without);
  }
  const looMean = loo.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const d = looMean - loo[i];
    num += d ** 3;
    den += d ** 2;
  }
  const a = den === 0 ? 0 : num / (6 * Math.pow(den, 1.5));

  const zLo = normalInvCDF(alpha / 2);
  const zHi = normalInvCDF(1 - alpha / 2);
  const adj = (z) => normalCDF(z0 + (z0 + z) / (1 - a * (z0 + z)));
  const pLo = adj(zLo), pHi = adj(zHi);
  const idx = (p) => Math.min(B - 1, Math.max(0, Math.round(p * (B - 1))));

  return { thetaHat, lo: boot[idx(pLo)], hi: boot[idx(pHi)], z0, a, B, seed, alpha };
}

const mean = (arr) => (arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length);

/** HL's CI, computed via the SAME bootstrap machinery as the BCa CI but as a plain
 * percentile interval (HL is descriptive-only — F5 — a simpler interval is a stated,
 * deliberate simplification, not a Wilcoxon-rank-derived interval). */
export function hodgesLehmannWithCI(diffs, { B = BOOTSTRAP_B, seed = 2, alpha = ALPHA } = {}) {
  const estimate = hodgesLehmannEstimate(diffs);
  if (diffs.length === 0) return { estimate: null, ci: [null, null] };
  const rng = mulberry32(seed);
  const n = diffs.length;
  const boot = new Array(B);
  for (let b = 0; b < B; b++) {
    const resample = new Array(n);
    for (let k = 0; k < n; k++) resample[k] = diffs[Math.floor(rng() * n)];
    boot[b] = hodgesLehmannEstimate(resample);
  }
  boot.sort((x, y) => x - y);
  const loIdx = Math.max(0, Math.round((alpha / 2) * (B - 1)));
  const hiIdx = Math.min(B - 1, Math.round((1 - alpha / 2) * (B - 1)));
  return { estimate, ci: [boot[loIdx], boot[hiIdx]] };
}

// ---------------------------------------------------------------------------
// Censoring / co-metric
// ---------------------------------------------------------------------------

/** log2 of the censored rank (DEPTH+1=201 floor on degradation, F3). */
export function log2CensoredRank(rank) {
  return Math.log2(rank === null ? CENSORED_RANK : rank);
}

// ---------------------------------------------------------------------------
// Trivial discharge on T4 ceiling (F3 — replaces the deleted anti-ceiling gate)
// ---------------------------------------------------------------------------

/**
 * T4 in_window@10 >= 95% in BOTH arms for a stratum -> trivially discharged for
 * that stratum (no membership loss materialized at full scale). Integer trigger:
 * ceil(0.95 * n) — 143/150, 95/100, matching the registered examples exactly.
 */
export function trivialDischargeCheck(countInWindowH_T4, countInWindowL_T4, n) {
  if (n === 0) return false;
  const threshold = Math.ceil(T4_CEILING_FRACTION * n);
  return countInWindowH_T4 >= threshold && countInWindowL_T4 >= threshold;
}

// ---------------------------------------------------------------------------
// Decision table (registered) — emits the verdict ROW ONLY, no free-text verdict.
// ---------------------------------------------------------------------------

export const VERDICTS = Object.freeze({
  CONFIRMED: 'SCALE_CAVEAT_CONFIRMED',
  DISCHARGED: 'SCALE_CAVEAT_DISCHARGED',
  DISCHARGED_TRIVIAL: 'SCALE_CAVEAT_DISCHARGED_TRIVIAL',
  DISCHARGED_A_FORTIORI: 'SCALE_CAVEAT_DISCHARGED_A_FORTIORI',
  AMBIGUOUS: 'AMBIGUOUS',
});

/**
 * Registered decision-table evaluation for the DECISION-BEARING stratum (S-ident).
 *
 * Precedence (matches the registration's own ordering):
 *   1. T4-ceiling trivial discharge (F3) — short-circuits the table entirely for
 *      this stratum when both arms are already at ceiling at full scale.
 *   2. The 4-row table on (wilcoxon, bcaDeltaCI).
 *   3. The 3 registered consistency triggers (F10) — triggers 1 and 2 can escalate
 *      a DISCHARGED verdict to AMBIGUOUS; trigger 3 (monotonicity) is reported but
 *      never alone forces AMBIGUOUS.
 *
 * @param {object} input
 * @param {ReturnType<typeof wilcoxonSignedRankExact>} input.wilcoxon
 * @param {{lo:number|null, hi:number|null}} input.bcaDeltaCI - all-n BCa CI on mean(Delta) for S-ident
 * @param {boolean} input.trivialDischarge - T4-ceiling check for S-ident
 * @param {Array<{name:string, lo:number|null, hi:number|null}>} input.supportingCIs - S-prose/S-approx all-n BCa CIs
 * @param {{lo:number|null, hi:number|null}|null} input.deltaLog2CI
 * @param {Array<{tier:string, outsideEnvelope:boolean}>} [input.monotonicityFlags]
 */
export function evaluateVerdict({ wilcoxon, bcaDeltaCI, trivialDischarge, supportingCIs = [], deltaLog2CI = null, monotonicityFlags = [] }) {
  const reasoning = [];

  if (trivialDischarge) {
    reasoning.push('T4 in_window@10 >= 95% in both arms for the decision-bearing stratum — trivially discharged (F3), no membership loss materialized at full scale.');
    return { row: 'trivial_discharge', verdict: VERDICTS.DISCHARGED_TRIVIAL, reasoning, escalatedToAmbiguous: false };
  }

  let row, verdict;
  if (wilcoxon.significant && wilcoxon.direction === 'positive') {
    row = 1; verdict = VERDICTS.CONFIRMED;
    reasoning.push(`Wilcoxon significant (p=${wilcoxon.p}) with Delta direction positive (lexical degrading more).`);
  } else if (wilcoxon.significant && wilcoxon.direction === 'negative') {
    row = 3; verdict = VERDICTS.DISCHARGED_A_FORTIORI;
    reasoning.push(`Wilcoxon significant (p=${wilcoxon.p}) in the REVERSE direction (hybrid degrades more) — discharged a fortiori, descriptive fusion-at-scale finding.`);
  } else if ((!wilcoxon.significant || wilcoxon.degenerate) && bcaDeltaCI.hi !== null && bcaDeltaCI.hi <= 0.10) {
    row = 2; verdict = VERDICTS.DISCHARGED;
    reasoning.push(`Wilcoxon not significant (or degenerate) AND all-n BCa CI upper bound on Delta (${bcaDeltaCI.hi}) <= 10 percentage points (0.10).`);
  } else {
    row = 4; verdict = VERDICTS.AMBIGUOUS;
    reasoning.push('Neither the CONFIRMED nor the DISCHARGED condition is met.');
  }

  let escalatedToAmbiguous = false;

  // Consistency trigger 1: a supporting stratum's own all-n BCa CI excludes 0 in the
  // lexical-degrading direction (lo > 0) while the decision-bearing test discharges.
  if (verdict === VERDICTS.DISCHARGED) {
    for (const s of supportingCIs) {
      if (s.lo !== null && s.lo > 0) {
        escalatedToAmbiguous = true;
        reasoning.push(`Consistency trigger 1: supporting stratum "${s.name}" all-n BCa CI excludes 0 in the lexical-degrading direction (lo=${s.lo}) while the decision-bearing test discharged.`);
      }
    }
  }

  // Consistency trigger 2: Delta-log2(rank) co-metric CI excludes 0 in the
  // lexical-degrading direction -> forces AMBIGUOUS (never dispositive otherwise).
  if (deltaLog2CI !== null && deltaLog2CI.lo !== null && deltaLog2CI.lo > 0) {
    escalatedToAmbiguous = true;
    reasoning.push(`Consistency trigger 2: Delta-log2(rank) co-metric BCa CI excludes 0 in the lexical-degrading direction (lo=${deltaLog2CI.lo}).`);
  }

  // Consistency trigger 3: monotonicity — flagged/discussed, never alone forces AMBIGUOUS.
  const outside = monotonicityFlags.filter((f) => f.outsideEnvelope);
  if (outside.length > 0) {
    reasoning.push(`Monotonicity flag (informational only, does not alone force AMBIGUOUS): tiers outside [T1,T4] envelope by more than their own 95% CI: ${outside.map((f) => f.tier).join(', ')}.`);
  }

  if (escalatedToAmbiguous) {
    reasoning.push('Verdict escalated to AMBIGUOUS by a registered consistency trigger (F10) — report and escalate by increasing n, never by reinterpreting.');
    return { row, verdict: VERDICTS.AMBIGUOUS, reasoning, escalatedToAmbiguous: true };
  }

  return { row, verdict, reasoning, escalatedToAmbiguous: false };
}

// ---------------------------------------------------------------------------
// Top-level scoring orchestration — reads the wrapper's results rows.
// NOT invoked on real data by this session.
// ---------------------------------------------------------------------------

/**
 * Group validated result rows into per-query { H: {...}, L: {...} } pairs for a
 * given stratum and tier pair (e.g. T1 vs T4 for D_loss).
 */
function pairByQuery(rows, stratum, tier, arm) {
  const map = new Map();
  for (const r of rows) {
    if (r.stratum !== stratum || r.tier !== tier || r.arm !== arm) continue;
    map.set(r.query_id, r);
  }
  return map;
}

/** D_loss(query, arm) = in_window@10(T1) - in_window@10(T4), per F1. */
function computeDLoss(rows, stratum, arm) {
  const t1 = pairByQuery(rows, stratum, 'T1', arm);
  const t4 = pairByQuery(rows, stratum, 'T4', arm);
  const out = new Map();
  for (const [qid, r1] of t1) {
    const r4 = t4.get(qid);
    if (r4 === undefined) continue;
    out.set(qid, Number(r1.in_window_10) - Number(r4.in_window_10));
  }
  return out;
}

/**
 * Full scoring pass for one stratum's rows (all rows already validated with
 * `validateResultRow`). Returns D_loss maps, Delta array, Wilcoxon, HL, BCa CI.
 */
export function scoreStratum(rows, stratum) {
  for (const r of rows) validateResultRow(r);
  const dLossH = computeDLoss(rows, stratum, 'H');
  const dLossL = computeDLoss(rows, stratum, 'L');

  const queryIds = [...dLossH.keys()].filter((qid) => dLossL.has(qid));
  const deltas = queryIds.map((qid) => dLossL.get(qid) - dLossH.get(qid));

  const wilcoxon = wilcoxonSignedRankExact(deltas);
  const hl = hodgesLehmannWithCI(deltas);
  const bca = bcaBootstrap(deltas, mean, { seed: 1001 });

  const zeroCount = deltas.filter((d) => d === 0).length;

  return {
    stratum, n: deltas.length, zero_count: zeroCount,
    deltas, wilcoxon, hodges_lehmann: hl,
    bca_delta_ci: { thetaHat: bca.thetaHat, lo: bca.lo, hi: bca.hi },
  };
}

/** Reads (and validates) the wrapper's results JSON, hashing it for provenance. */
export function parseResultsFile(jsonText) {
  const parsed = JSON.parse(jsonText);
  const rows = Array.isArray(parsed) ? parsed : parsed.rows;
  if (!Array.isArray(rows)) throw new Error('results file must be an array or { rows: [...] }');
  rows.forEach(validateResultRow);
  return { rows, sha256: createHash('sha256').update(jsonText).digest('hex') };
}
