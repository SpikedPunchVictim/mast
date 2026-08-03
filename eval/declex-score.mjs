// Q1/DECLEX — scorer (IMPLEMENTATION_PLAN.md § "Q1/DECLEX ... PRE-
// REGISTRATION" + AMENDMENT 1, commit dd10796). BUILT AND UNIT-TESTED HERE;
// NOT run on real data by this session (hard rule: no verdict computed over
// the scored query set until a later, explicitly-scored phase).
//
// Reuses the parent Q1/SCALE scorer's validated numeric primitives VERBATIM
// (imported, not reimplemented): `wilcoxonSignedRankExact`, `bcaBootstrap`,
// `hodgesLehmannWithCI`, `log2CensoredRank`, `mulberry32`, `normalCDF`,
// `normalInvCDF`. None of that math is re-derived here.
//
// What THIS scorer adds beyond idfuse-score.mjs's shape (a different,
// AMENDED registration — grepped IMPLEMENTATION_PLAN.md:3616-3689; the two
// tables are NOT the same):
//   - A mandatory HARM gate (idfuse-score.mjs had none): per off-stratum
//     (S-approx, S-prose), a fire-rate floor (>= 10%) gates whether that
//     stratum is HARM-CLEAN-eligible at all (AMENDMENT 1, F-1's HARM-CLEAN /
//     HARM-NULL vocabulary) before its harm CI is even meaningful.
//   - A NEW bootstrap primitive, `bcaBootstrapByQuery` (below): the harm
//     contrast's resampling UNIT is the QUERY, carrying all of that query's
//     tier rows together (AMENDMENT 1, F-7(v)) — `bcaBootstrap` (imported)
//     resamples individual scalar values and would treat 4 correlated
//     per-tier rows as 4 independent observations, overstating precision up
//     to 4x. This file's own `mulberry32`/`normalCDF`/`normalInvCDF`-based
//     bootstrap is a block-bootstrap variant of the SAME BCa algorithm,
//     parameterized by query instead of by value.
//   - CLOSED-BUT-HARMFUL and HARMFUL-LEVER (on-stratum) verdict cells
//     (idfuse-score.mjs's table has neither — AMENDMENT 1, F-7(i)/(ii)).
//   - The F-9 narrative firewall: `scoreDeclex`'s return value separates a
//     `verdict`-bearing block computed EXCLUSIVELY from `query_set: 'fresh'`
//     rows from a `projection_provenance` block computed EXCLUSIVELY from
//     `query_set: 'original'` rows — the two are never combined into one
//     statistic anywhere in this file (grep for `query_set` below to verify).
//
// What is NOT reused from idfuse-score.mjs, and why: its `evaluateVerdict` /
// `VERDICTS` implement Q1/IDFUSE's OWN 5-row table with no harm gate at all —
// porting it here would silently omit the harm machinery this registration
// requires. `validateResultRow` is imported from declex-rank-check.mjs (the
// 5-arm, query_set-aware schema), not idfuse-rank-check.mjs's 5-arm-but-
// different-arms one.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  wilcoxonSignedRankExact, bcaBootstrap, hodgesLehmannWithCI, log2CensoredRank,
  mulberry32, normalCDF, normalInvCDF,
} from './scale-score.mjs';
import { validateResultRow } from './declex-rank-check.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_RESULTS_DIR = join(__dirname, 'results');

export const ALPHA = 0.05;
export const BOOTSTRAP_B = 10000;

/** The instrument's registered precision floor (IMPLEMENTATION_PLAN.md:
 * "Δ′ ns AND CI upper ≤ 5 pp" — same 5pp value as Q1/IDFUSE's own floor,
 * restated independently here so this file has no hidden coupling to a
 * sibling instrument's constant). */
export const PRECISION_FLOOR_PP = 0.05;

/** HARM-CLEAN's registered fire-rate floor (AMENDMENT 1, F-1: "≥ 1 candidate
 * on ≥ 10% of that stratum's queries"). Below this, a stratum is HARM-NULL
 * (unexposed) — the harm contrast could not fire and reports no information. */
export const HARM_FIRE_RATE_FLOOR = 0.10;

/**
 * F-R2's post-hoc, unregistered projection (quoted verbatim, HANDOFF_Q1.md
 * §2 item 5 / IMPLEMENTATION_PLAN.md:3449-3452): "SYMBOL-GATED declaration-
 * exact: T4 s_ident .9800, s_approx .8400 = L exactly, s_prose .8200 = L
 * exactly (zero harm)". Used ONLY inside `projection_provenance` (the F-9
 * firewall block) to compute the divergence delta against the ORIGINAL-400
 * re-score (AMENDMENT 1, F-4's role assignment: "the original-400 D re-score
 * is the DIRECT test of the F-R2 projection"). NEVER read by any
 * verdict-bearing code path in this file.
 */
export const F_R2_PROJECTION = Object.freeze({
  t4_s_ident_in_window_rate: 0.98,
  t4_s_approx_in_window_rate: 0.84, // "= L exactly"
  t4_s_prose_in_window_rate: 0.82, // "= L exactly"
});

const mean = (arr) => (arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length);

// ---------------------------------------------------------------------------
// Arm-generic pairing / D_loss / Delta' construction (same pattern as
// idfuse-score.mjs's own arm-generic helpers — Q1/DECLEX needs these
// parameterized by (L+D, H), (L+D, L), (H+D, H), (L+D+esc, H), unlike
// scale-score.mjs's hardcoded ('H','L')).
// ---------------------------------------------------------------------------

function pairByQueryArmTier(rows, stratum, tier, arm) {
  const map = new Map();
  for (const r of rows) {
    if (r.stratum !== stratum || r.tier !== tier || r.arm !== arm) continue;
    map.set(r.query_id, r);
  }
  return map;
}

/** D_loss(query, arm) = in_window@10(T1) - in_window@10(T4), F1 sign
 * convention: positive = degraded from T1 to T4. */
function computeDLoss(rows, stratum, arm) {
  const t1 = pairByQueryArmTier(rows, stratum, 'T1', arm);
  const t4 = pairByQueryArmTier(rows, stratum, 'T4', arm);
  const out = new Map();
  for (const [qid, r1] of t1) {
    const r4 = t4.get(qid);
    if (r4 === undefined) continue;
    out.set(qid, Number(r1.in_window_10) - Number(r4.in_window_10));
  }
  return out;
}

/** Delta'(query) = D_loss_armA(query) - D_loss_armB(query). Decision-bearing
 * use: armA='L+D', armB='H' ("Δ′ = D_loss_{L+D} − D_loss_H"). Positive =
 * armA degrades MORE than armB. */
function computeDeltaPrime(rows, stratum, armA, armB) {
  const dA = computeDLoss(rows, stratum, armA);
  const dB = computeDLoss(rows, stratum, armB);
  const queryIds = [...dA.keys()].filter((qid) => dB.has(qid));
  return queryIds.map((qid) => dA.get(qid) - dB.get(qid));
}

function computeDLog2Loss(rows, stratum, arm) {
  const t1 = pairByQueryArmTier(rows, stratum, 'T1', arm);
  const t4 = pairByQueryArmTier(rows, stratum, 'T4', arm);
  const out = new Map();
  for (const [qid, r1] of t1) {
    const r4 = t4.get(qid);
    if (r4 === undefined) continue;
    out.set(qid, log2CensoredRank(r4.rank) - log2CensoredRank(r1.rank));
  }
  return out;
}

function computeDeltaLog2(rows, stratum, armA, armB) {
  const dA = computeDLog2Loss(rows, stratum, armA);
  const dB = computeDLog2Loss(rows, stratum, armB);
  const queryIds = [...dA.keys()].filter((qid) => dB.has(qid));
  return queryIds.map((qid) => dA.get(qid) - dB.get(qid));
}

/** Efficacy precondition input: paired diff of RAW in_window@10 AT T4 ONLY
 * between L+D and L, S-ident. Positive = L+D better than L. */
function computeEfficacyDiffsAtT4(rows, stratum) {
  const d = pairByQueryArmTier(rows, stratum, 'T4', 'L+D');
  const l = pairByQueryArmTier(rows, stratum, 'T4', 'L');
  const queryIds = [...d.keys()].filter((qid) => l.has(qid));
  return queryIds.map((qid) => Number(d.get(qid).in_window_10) - Number(l.get(qid).in_window_10));
}

// ---------------------------------------------------------------------------
// Per-query block bootstrap (AMENDMENT 1, F-7(v)) — the harm contrast's
// resampling unit is the QUERY, carrying ALL of that query's tier-level
// diffs together, never resampling query×tier rows independently.
// ---------------------------------------------------------------------------

/**
 * Per-query grouped level diffs: for each query present in BOTH `armA` and
 * `armB` for `stratum`, the array of per-tier `in_window@10` diffs
 * (armA - armB) across whatever tiers both arms share for that query
 * (up to 4 — T1..T4). Building block for `bcaBootstrapByQuery` (the harm
 * contrast, "pooled across tiers") and for the per-tier descriptive
 * breakdown (a single-tier slice of the same data, "Per-tier cells reported
 * regardless of the pooled HARM-CLEAN/HARM-NULL outcome").
 */
export function perQueryTierDiffs(rows, stratum, armA, armB) {
  const aByQuery = new Map();
  const bByQuery = new Map();
  for (const r of rows) {
    if (r.stratum !== stratum) continue;
    if (r.arm === armA) {
      if (!aByQuery.has(r.query_id)) aByQuery.set(r.query_id, new Map());
      aByQuery.get(r.query_id).set(r.tier, r);
    } else if (r.arm === armB) {
      if (!bByQuery.has(r.query_id)) bByQuery.set(r.query_id, new Map());
      bByQuery.get(r.query_id).set(r.tier, r);
    }
  }
  const perQuery = [];
  for (const [qid, aTiers] of aByQuery) {
    const bTiers = bByQuery.get(qid);
    if (bTiers === undefined) continue;
    const diffs = [];
    for (const [tier, aRow] of aTiers) {
      const bRow = bTiers.get(tier);
      if (bRow === undefined) continue;
      diffs.push({ tier, diff: Number(aRow.in_window_10) - Number(bRow.in_window_10) });
    }
    if (diffs.length > 0) perQuery.push({ query_id: qid, diffs });
  }
  return perQuery;
}

/**
 * Seeded BCa bootstrap CI for `statFn(flatValues)`, resampling at the QUERY
 * level: each bootstrap replicate draws N queries WITH REPLACEMENT (N =
 * number of queries), then flattens the drawn queries' diff-arrays into one
 * pool and applies `statFn`. This is the same Efron & Tibshirani BCa
 * algorithm `bcaBootstrap` (scale-score.mjs) implements — bias correction z0
 * from the bootstrap distribution, acceleration `a` from query-level (not
 * row-level) jackknife — parameterized by the resampling UNIT instead of by
 * scalar value, so 4 correlated per-tier rows for one query are never
 * treated as 4 independent observations (AMENDMENT 1, F-7(v)).
 *
 * @param {Array<number[]>} perQueryValues - one array of values per query
 *   (e.g. up to 4 tier-level diffs); queries with 0 values must be excluded
 *   by the caller (empty arrays would silently contribute nothing and skew
 *   nothing, but are rejected here to keep N meaningful).
 * @param {(values: number[]) => number} statFn - operates on the FLATTENED pool.
 */
export function bcaBootstrapByQuery(perQueryValues, statFn, { B = BOOTSTRAP_B, seed = 1, alpha = ALPHA } = {}) {
  const n = perQueryValues.length;
  const flatten = (groups) => groups.flat();
  const thetaHat = n === 0 ? null : statFn(flatten(perQueryValues));
  if (n === 0) return { thetaHat: null, lo: null, hi: null, z0: null, a: null, B, seed, alpha, n_queries: 0 };

  const rng = mulberry32(seed);
  const boot = new Array(B);
  for (let b = 0; b < B; b++) {
    const resample = new Array(n);
    for (let k = 0; k < n; k++) resample[k] = perQueryValues[Math.floor(rng() * n)];
    boot[b] = statFn(flatten(resample));
  }
  boot.sort((x, y) => x - y);

  const propLess = boot.filter((v) => v < thetaHat).length / B;
  const clamped = propLess === 0 ? 1 / (2 * B) : propLess === 1 ? 1 - 1 / (2 * B) : propLess;
  const z0 = normalInvCDF(clamped);

  const loo = new Array(n);
  for (let i = 0; i < n; i++) {
    const without = perQueryValues.slice(0, i).concat(perQueryValues.slice(i + 1));
    loo[i] = statFn(flatten(without));
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

  return { thetaHat, lo: boot[idx(pLo)], hi: boot[idx(pHi)], z0, a, B, seed, alpha, n_queries: n };
}

// ---------------------------------------------------------------------------
// Fire-rate aggregates (AMENDMENT 1, F-1 — mandatory, reported regardless of
// which side of the HARM-CLEAN/HARM-NULL split a stratum lands on).
// ---------------------------------------------------------------------------

/** Fraction of (stratum, tier, arm) rows where D produced >= 1 candidate.
 * `null` if no rows exist for the cell (nothing to report). */
export function fireRate(rows, stratum, arm, tier = null) {
  const rs = rows.filter((r) => r.stratum === stratum && r.arm === arm && (tier === null || r.tier === tier) && r.d_diagnostic !== undefined);
  if (rs.length === 0) return null;
  return rs.filter((r) => r.d_diagnostic.fired).length / rs.length;
}

// ---------------------------------------------------------------------------
// HARM gate (mandatory, AMENDMENT 1 F-1 + the registration's own "Mandatory
// HARM gate" section) — per off-stratum, fire-rate floor first, THEN (if
// met) the per-query-unit bootstrap CI on the paired level diff (L+D - L),
// pooled across tiers.
// ---------------------------------------------------------------------------

export const HARM_STATES = Object.freeze({
  HARM_NULL: 'HARM_NULL', // fire-rate floor NOT met — unexposed, no CI to report
  HARM_CLEAN: 'HARM_CLEAN', // floor met, CI does not show significant harm
  HARM_FAIL: 'HARM_FAIL', // floor met, CI shows L+D significantly WORSE than L
});

function computeOffStratumHarm(rows, stratum, seed) {
  const pooledFireRate = fireRate(rows, stratum, 'L+D');
  if (pooledFireRate === null || pooledFireRate < HARM_FIRE_RATE_FLOOR) {
    return { state: HARM_STATES.HARM_NULL, fire_rate: pooledFireRate, ci: null, n_queries: 0 };
  }
  const perQuery = perQueryTierDiffs(rows, stratum, 'L+D', 'L');
  const perQueryDiffs = perQuery.map((p) => p.diffs.map((d) => d.diff));
  const bca = bcaBootstrapByQuery(perQueryDiffs, mean, { seed });
  const showsHarm = bca.hi !== null && bca.hi < 0; // CI excludes 0 in the negative (harmful) direction
  return {
    state: showsHarm ? HARM_STATES.HARM_FAIL : HARM_STATES.HARM_CLEAN,
    fire_rate: pooledFireRate,
    ci: { thetaHat: bca.thetaHat, lo: bca.lo, hi: bca.hi },
    n_queries: bca.n_queries,
  };
}

/** Per-tier descriptive slice of the same (L+D - L) level contrast — plain
 * per-value BCa (no cross-tier correlation WITHIN a single tier slice, since
 * each query contributes exactly one row per tier). Reported "regardless of
 * the pooled HARM-CLEAN/HARM-NULL outcome" (registration). */
function perTierLevelDiffCI(rows, stratum, armA, armB, tier, seed) {
  const d = pairByQueryArmTier(rows, stratum, tier, armA);
  const b = pairByQueryArmTier(rows, stratum, tier, armB);
  const queryIds = [...d.keys()].filter((qid) => b.has(qid));
  const diffs = queryIds.map((qid) => Number(d.get(qid).in_window_10) - Number(b.get(qid).in_window_10));
  const bca = bcaBootstrap(diffs, mean, { seed });
  return { n: diffs.length, theta_hat: bca.thetaHat, lo: bca.lo, hi: bca.hi };
}

// ---------------------------------------------------------------------------
// Decision table (AMENDED — AMENDMENT 1, F-7 cell fixes + precedence).
// ---------------------------------------------------------------------------

export const VERDICTS = Object.freeze({
  GAP_CLOSED_HARM_TESTED: 'DECLEX_GAP_CLOSED_HARM_TESTED',
  GAP_CLOSED_HARM_UNTESTED: 'DECLEX_GAP_CLOSED_HARM_UNTESTED',
  GAP_CLOSED_A_FORTIORI_HARM_TESTED: 'DECLEX_GAP_CLOSED_A_FORTIORI_HARM_TESTED',
  GAP_CLOSED_A_FORTIORI_HARM_UNTESTED: 'DECLEX_GAP_CLOSED_A_FORTIORI_HARM_UNTESTED',
  CLOSED_BUT_HARMFUL: 'DECLEX_CLOSED_BUT_HARMFUL',
  HARMFUL_LEVER_ON_STRATUM: 'DECLEX_HARMFUL_LEVER_ON_STRATUM',
  GAP_SURVIVES: 'DECLEX_GAP_SURVIVES',
  GAP_SURVIVES_MARGINAL: 'DECLEX_GAP_SURVIVES_MARGINAL_SUB_PRECISION_FLOOR',
  INERT_LEVER: 'DECLEX_INERT_LEVER',
  AMBIGUOUS: 'AMBIGUOUS',
});

/** Row-1/3-shaped closure test: Wilcoxon not significant (degenerate counts
 * as not significant) AND all-n BCa CI upper bound <= 5pp. */
function meetsPlainClosureCriteria(wilcoxon, bcaDeltaCI) {
  return (!wilcoxon.significant || wilcoxon.degenerate) && bcaDeltaCI.hi !== null && bcaDeltaCI.hi <= PRECISION_FLOOR_PP;
}

/** The base closure SHAPE on (wilcoxon, bcaDeltaCI) alone, before the harm
 * gate is folded in (registration's verdict-table rows, pre-harm-split). */
function baseClosureShape({ wilcoxon, bcaDeltaCI }) {
  if (meetsPlainClosureCriteria(wilcoxon, bcaDeltaCI)) return 'CLOSED';
  if (wilcoxon.significant && wilcoxon.direction === 'negative') return 'CLOSED_A_FORTIORI';
  if (wilcoxon.significant && wilcoxon.direction === 'positive' && bcaDeltaCI.hi !== null && bcaDeltaCI.hi > PRECISION_FLOOR_PP) return 'SURVIVES';
  if (wilcoxon.significant && wilcoxon.direction === 'positive' && bcaDeltaCI.hi !== null && bcaDeltaCI.hi <= PRECISION_FLOOR_PP) return 'SURVIVES_MARGINAL';
  return 'AMBIGUOUS_SHAPE';
}

/**
 * Registered decision-table evaluation for the DECISION-BEARING stratum
 * (S-ident), including the efficacy 2x2 precondition (evaluated FIRST, takes
 * precedence over every row below — AMENDMENT 1, F-7(iv)), the mandatory
 * HARM gate (AMENDMENT 1, F-1/F-7(i)), and the symmetric consistency
 * triggers (computed/reported on ALL paths; verdict-bearing only on
 * CLOSED/SURVIVES rows, per the registration's explicit statement).
 *
 * @param {object} input
 * @param {{lo:number|null, hi:number|null}} input.efficacyBcaCI - all-n BCa CI
 *   on mean(in_window@10_{L+D} - in_window@10_L) at T4, S-ident.
 * @param {ReturnType<typeof wilcoxonSignedRankExact>} input.wilcoxon - on
 *   Δ′ = D_loss_{L+D} - D_loss_H, S-ident.
 * @param {{lo:number|null, hi:number|null}} input.bcaDeltaCI
 * @param {{s_approx: ReturnType<typeof computeOffStratumHarm>, s_prose: ReturnType<typeof computeOffStratumHarm>}} input.offStratumHarm
 * @param {Array<{name:string, lo:number|null, hi:number|null}>} [input.supportingCIs]
 * @param {{lo:number|null, hi:number|null}|null} [input.deltaLog2CI]
 * @param {Array<{tier:string, arm:string, outsideEnvelope:boolean}>} [input.monotonicityFlags]
 */
export function evaluateVerdict({
  efficacyBcaCI, wilcoxon, bcaDeltaCI, offStratumHarm,
  supportingCIs = [], deltaLog2CI = null, monotonicityFlags = [],
}) {
  const reasoning = [];

  // --- Efficacy precondition (evaluated first, takes precedence over the
  // harm gate and the closure table — AMENDMENT 1, F-7(iv)). ---
  const efficacyPasses = efficacyBcaCI.lo !== null && efficacyBcaCI.lo > 0;
  const efficacyReverseSignificant = efficacyBcaCI.hi !== null && efficacyBcaCI.hi < 0;
  if (efficacyReverseSignificant) {
    reasoning.push(`Efficacy check: L+D vs L @ T4 all-n BCa CI excludes 0 in the REVERSE direction (ranker D significantly HURTS lexical, hi=${efficacyBcaCI.hi}).`);
  }

  const shape = baseClosureShape({ wilcoxon, bcaDeltaCI });
  const closedCriteriaMet = shape === 'CLOSED' || shape === 'CLOSED_A_FORTIORI';

  if (!efficacyPasses) {
    if (closedCriteriaMet) {
      reasoning.push(`Efficacy FAILS (ci=[${efficacyBcaCI.lo}, ${efficacyBcaCI.hi}]) but Δ′ independently meets the GAP CLOSED criteria (shape=${shape}) -> AMBIGUOUS per the registered collision-cell mapping; both contrasts reported in full.`);
      return { efficacy: { passes: false, reverse_significant: efficacyReverseSignificant, ci: efficacyBcaCI }, shape, verdict: VERDICTS.AMBIGUOUS, reasoning, escalated_to_ambiguous: false };
    }
    if (efficacyReverseSignificant) {
      reasoning.push('Efficacy reverse-significant (D hurts L on-stratum) AND Δ′ does not meet the GAP CLOSED criteria -> HARMFUL-LEVER (on-stratum) (AMENDMENT 1, F-7(ii) — a lever proven to hurt its own stratum, not merely inert).');
      return { efficacy: { passes: false, reverse_significant: true, ci: efficacyBcaCI }, shape, verdict: VERDICTS.HARMFUL_LEVER_ON_STRATUM, reasoning, escalated_to_ambiguous: false };
    }
    reasoning.push(`Efficacy FAILS (ci=[${efficacyBcaCI.lo}, ${efficacyBcaCI.hi}]) AND Δ′ does not meet the GAP CLOSED criteria -> INERT-LEVER.`);
    return { efficacy: { passes: false, reverse_significant: false, ci: efficacyBcaCI }, shape, verdict: VERDICTS.INERT_LEVER, reasoning, escalated_to_ambiguous: false };
  }

  reasoning.push(`Efficacy PASSES (lo=${efficacyBcaCI.lo}) -> Δ′ verdict table + HARM gate govern.`);

  // --- HARM gate (AMENDMENT 1, F-1) — evaluated once efficacy passes, takes
  // precedence over which CLOSED variant (or CLOSED-BUT-HARMFUL) is reached. ---
  const offStates = Object.values(offStratumHarm).map((s) => s.state);
  const anyHarmFail = offStates.includes(HARM_STATES.HARM_FAIL);
  const anyHarmClean = offStates.includes(HARM_STATES.HARM_CLEAN);
  const allHarmNull = offStates.every((s) => s === HARM_STATES.HARM_NULL);
  reasoning.push(`Off-stratum harm states: ${JSON.stringify(Object.fromEntries(Object.entries(offStratumHarm).map(([k, v]) => [k, v.state])))}.`);

  let verdict;
  if (closedCriteriaMet) {
    if (anyHarmFail) {
      reasoning.push('Closure criteria met but >= 1 stratum that reached the HARM-CLEAN fire-rate floor shows significant harm -> CLOSED-BUT-HARMFUL (AMENDMENT 1, F-7(i) — routed explicitly, never left to fall through to AMBIGUOUS).');
      verdict = VERDICTS.CLOSED_BUT_HARMFUL;
    } else if (anyHarmClean) {
      verdict = shape === 'CLOSED' ? VERDICTS.GAP_CLOSED_HARM_TESTED : VERDICTS.GAP_CLOSED_A_FORTIORI_HARM_TESTED;
      reasoning.push(`>= 1 off-stratum reached HARM-CLEAN (tested, non-trivial fire-rate, no significant harm) -> ${verdict} ("harm-tested" language applies).`);
    } else if (allHarmNull) {
      verdict = shape === 'CLOSED' ? VERDICTS.GAP_CLOSED_HARM_UNTESTED : VERDICTS.GAP_CLOSED_A_FORTIORI_HARM_UNTESTED;
      reasoning.push(`Both off-strata are HARM-NULL (unexposed, D never fired above the 10% floor) -> ${verdict} — harm UNTESTED at the primary construction.`);
    } else {
      // Defensive: with 2 off-strata and 3 possible states, every combination
      // is covered by the three branches above (anyHarmFail, anyHarmClean,
      // allHarmNull are jointly exhaustive over {HARM_NULL, HARM_CLEAN} once
      // HARM_FAIL is excluded) — this branch should be unreachable.
      throw new Error(`unreachable: off-stratum harm states ${JSON.stringify(offStates)} matched no branch`);
    }
  } else if (shape === 'SURVIVES') {
    verdict = VERDICTS.GAP_SURVIVES;
  } else if (shape === 'SURVIVES_MARGINAL') {
    verdict = VERDICTS.GAP_SURVIVES_MARGINAL;
  } else {
    verdict = VERDICTS.AMBIGUOUS;
  }

  // --- Symmetric consistency triggers (both directions) — computed/reported
  // on ALL paths reached here; VERDICT-BEARING only on CLOSED*/SURVIVES* rows
  // (registration: "triggers are computed and reported on ALL paths,
  // verdict-bearing only on CLOSED/SURVIVES rows"). CLOSED-BUT-HARMFUL is
  // already a non-shippable finding — a trigger cannot un-say that, so it is
  // reported but not escalation-eligible (documented judgment call, same
  // spirit as idfuse-score.mjs's INERT_LEVER exclusion). ---
  const isClosureVerdict = verdict === VERDICTS.GAP_CLOSED_HARM_TESTED || verdict === VERDICTS.GAP_CLOSED_HARM_UNTESTED
    || verdict === VERDICTS.GAP_CLOSED_A_FORTIORI_HARM_TESTED || verdict === VERDICTS.GAP_CLOSED_A_FORTIORI_HARM_UNTESTED;
  const isSurvivesVerdict = verdict === VERDICTS.GAP_SURVIVES || verdict === VERDICTS.GAP_SURVIVES_MARGINAL;
  const allSupportingCIs = deltaLog2CI !== null
    ? [...supportingCIs, { name: 'delta_log2_rank_co_metric', lo: deltaLog2CI.lo, hi: deltaLog2CI.hi }]
    : supportingCIs;

  let escalatedToAmbiguous = false;
  if (isClosureVerdict) {
    for (const s of allSupportingCIs) {
      if (s.lo !== null && s.lo > 0) {
        escalatedToAmbiguous = true;
        reasoning.push(`Consistency trigger (closure direction): supporting cell "${s.name}" all-n BCa CI excludes 0 showing L+D significantly WORSE than H (lo=${s.lo}) while the decision-bearing test closed.`);
      }
    }
  }
  if (isSurvivesVerdict) {
    for (const s of allSupportingCIs) {
      if (s.hi !== null && s.hi < 0) {
        escalatedToAmbiguous = true;
        reasoning.push(`Consistency trigger (survives direction): supporting cell "${s.name}" all-n BCa CI excludes 0 showing L+D significantly BETTER than H (hi=${s.hi}) while the decision-bearing test survived.`);
      }
    }
  }

  const outside = monotonicityFlags.filter((f) => f.outsideEnvelope);
  if (outside.length > 0) {
    reasoning.push(`Monotonicity flag (informational only, does not alone force AMBIGUOUS): ${outside.map((f) => `${f.tier}/${f.arm}`).join(', ')}.`);
  }

  if (escalatedToAmbiguous && (isClosureVerdict || isSurvivesVerdict)) {
    reasoning.push('Verdict escalated to AMBIGUOUS by a registered symmetric consistency trigger — report and escalate by increasing n, never by reinterpreting.');
    return { efficacy: { passes: true, reverse_significant: false, ci: efficacyBcaCI }, shape, verdict: VERDICTS.AMBIGUOUS, reasoning, escalated_to_ambiguous: true };
  }

  return { efficacy: { passes: true, reverse_significant: false, ci: efficacyBcaCI }, shape, verdict, reasoning, escalated_to_ambiguous: false };
}

// ---------------------------------------------------------------------------
// Escape-cap sweep (AMENDMENT 1, F-8 — descriptive, no verdict stakes).
// ---------------------------------------------------------------------------

/**
 * Groups L+D+esc rows by whatever `escape_cap` values are present in the
 * input (a later runner phase supplies these by running the sweep at
 * {5,20,50} and merging the outputs — this scorer only needs to be ABLE to
 * report whatever caps it is given, not to have run them). For each cap:
 * fire rate per (stratum, tier) and the aggregated lowercase-token
 * declaration-match-count distribution (registration: "the scorer publishes
 * the matched-count distribution for all lowercase tokens considered").
 */
export function computeEscapeCapSweep(rows) {
  const escRows = rows.filter((r) => r.arm === 'L+D+esc' && r.d_diagnostic !== undefined);
  const caps = [...new Set(escRows.map((r) => r.escape_cap).filter((c) => c !== undefined))].sort((a, b) => a - b);

  return caps.map((cap) => {
    const capRows = escRows.filter((r) => r.escape_cap === cap);
    const strataReport = {};
    for (const stratum of ['s_ident', 's_approx', 's_prose']) {
      strataReport[stratum] = { pooled_fire_rate: fireRate(capRows, stratum, 'L+D+esc') };
    }
    const matchCounts = [];
    for (const r of capRows) {
      const counts = r.d_diagnostic.lowercase_token_match_counts;
      if (counts === undefined) continue;
      for (const c of Object.values(counts)) matchCounts.push(c);
    }
    matchCounts.sort((a, b) => a - b);
    return { escape_cap: cap, n_rows: capRows.length, fire_rate_by_stratum: strataReport, lowercase_match_count_distribution: matchCounts };
  });
}

// ---------------------------------------------------------------------------
// Top-level scoring orchestration.
// ---------------------------------------------------------------------------

/**
 * Full scoring pass. `rows` may contain BOTH `query_set: 'fresh'` and
 * `query_set: 'original'` rows (both are validated and accepted); the
 * returned object's TOP-LEVEL fields (`efficacy`, `decision_bearing`,
 * `harm`, `supporting`, `verdict`, `escape_cap_sweep`, `descriptive_only`,
 * `off_stratum_level_report`) are computed EXCLUSIVELY from `fresh` rows —
 * the F-9 narrative firewall. `original`-set rows contribute ONLY to the
 * separate, distinctly-named `projection_provenance` block.
 */
export function scoreDeclex(rows) {
  for (const r of rows) validateResultRow(r);

  const freshRows = rows.filter((r) => r.query_set === 'fresh');
  const originalRows = rows.filter((r) => r.query_set === 'original');

  // --- Efficacy precondition (S-ident, T4, L+D vs L) ---
  const efficacyDiffs = computeEfficacyDiffsAtT4(freshRows, 's_ident');
  const efficacyWilcoxon = wilcoxonSignedRankExact(efficacyDiffs);
  const efficacyBca = bcaBootstrap(efficacyDiffs, mean, { seed: 3001 });

  // --- Decision-bearing Δ′ (S-ident, L+D vs H) ---
  const deltaPrime = computeDeltaPrime(freshRows, 's_ident', 'L+D', 'H');
  const wilcoxon = wilcoxonSignedRankExact(deltaPrime);
  const bca = bcaBootstrap(deltaPrime, mean, { seed: 3002 });
  const hl = hodgesLehmannWithCI(deltaPrime, { seed: 3006 });

  // --- Supporting strata Δ′ (consistency triggers) ---
  const supportingApprox = computeDeltaPrime(freshRows, 's_approx', 'L+D', 'H');
  const supportingProse = computeDeltaPrime(freshRows, 's_prose', 'L+D', 'H');
  const bcaApprox = bcaBootstrap(supportingApprox, mean, { seed: 3003 });
  const bcaProse = bcaBootstrap(supportingProse, mean, { seed: 3004 });

  const deltaLog2Values = computeDeltaLog2(freshRows, 's_ident', 'L+D', 'H');
  const bcaLog2 = bcaBootstrap(deltaLog2Values, mean, { seed: 3005 });

  // --- Mandatory HARM gate (S-approx, S-prose; L+D vs L, pooled across
  // tiers, per-query bootstrap unit) ---
  const offStratumHarm = {
    s_approx: computeOffStratumHarm(freshRows, 's_approx', 3101),
    s_prose: computeOffStratumHarm(freshRows, 's_prose', 3102),
  };

  // --- Mandatory per-stratum x tier fire-rate aggregates (AMENDMENT 1, F-1) ---
  const TIERS = ['T1', 'T2', 'T3', 'T4'];
  const fireRateAggregate = {};
  for (const stratum of ['s_ident', 's_approx', 's_prose']) {
    fireRateAggregate[stratum] = { pooled: fireRate(freshRows, stratum, 'L+D') };
    for (const tier of TIERS) fireRateAggregate[stratum][tier] = fireRate(freshRows, stratum, 'L+D', tier);
  }

  // --- S-ident level contrast (L+D - L), same per-query bootstrap unit,
  // descriptive/supporting only ("the same contrast is reported for S-ident,
  // level, not only D_loss"). ---
  const sIdentLevelPerQuery = perQueryTierDiffs(freshRows, 's_ident', 'L+D', 'L').map((p) => p.diffs.map((d) => d.diff));
  const sIdentLevelCI = bcaBootstrapByQuery(sIdentLevelPerQuery, mean, { seed: 3103 });
  const sIdentLevelPerTier = Object.fromEntries(TIERS.map((tier) => [tier, perTierLevelDiffCI(freshRows, 's_ident', 'L+D', 'L', tier, 3110)]));

  // --- Descriptive off-stratum L+D-vs-H LEVEL report (pooled + per-tier) ---
  const offStratumLevelReport = {};
  for (const stratum of ['s_approx', 's_prose']) {
    const perQuery = perQueryTierDiffs(freshRows, stratum, 'L+D', 'H').map((p) => p.diffs.map((d) => d.diff));
    offStratumLevelReport[stratum] = {
      pooled: bcaBootstrapByQuery(perQuery, mean, { seed: stratum === 's_approx' ? 3201 : 3202 }),
      per_tier: Object.fromEntries(TIERS.map((tier) => [tier, perTierLevelDiffCI(freshRows, stratum, 'L+D', 'H', tier, 3210)])),
    };
  }

  // --- Descriptive-only arms (H+D, L+D+esc) — same Delta'-vs-H construction
  // as the decision-bearing contrast, NEVER passed into evaluateVerdict. ---
  const descriptiveArm = (arm, seedBase) => {
    const deltas = computeDeltaPrime(freshRows, 's_ident', arm, 'H');
    const w = wilcoxonSignedRankExact(deltas);
    const b = bcaBootstrap(deltas, mean, { seed: seedBase });
    return { arm, n: deltas.length, wilcoxon: w, bca_delta_ci: { thetaHat: b.thetaHat, lo: b.lo, hi: b.hi } };
  };

  const verdictResult = evaluateVerdict({
    efficacyBcaCI: { lo: efficacyBca.lo, hi: efficacyBca.hi },
    wilcoxon, bcaDeltaCI: { lo: bca.lo, hi: bca.hi },
    offStratumHarm,
    supportingCIs: [
      { name: 's_approx', lo: bcaApprox.lo, hi: bcaApprox.hi },
      { name: 's_prose', lo: bcaProse.lo, hi: bcaProse.hi },
    ],
    deltaLog2CI: { lo: bcaLog2.lo, hi: bcaLog2.hi },
  });

  // --- Escape-cap sweep (descriptive; fresh-set rows only, for consistency
  // with the rest of the decision-adjacent reporting). ---
  const escapeCapSweep = computeEscapeCapSweep(freshRows);

  // --- F-9 firewall: projection_provenance, ORIGINAL-400 rows ONLY, kept
  // structurally separate from every field above. ---
  const projectionProvenance = computeProjectionProvenance(originalRows);

  return {
    query_set_counts: { fresh: freshRows.length, original: originalRows.length },
    efficacy: {
      n: efficacyDiffs.length, wilcoxon: efficacyWilcoxon,
      bca_ci: { thetaHat: efficacyBca.thetaHat, lo: efficacyBca.lo, hi: efficacyBca.hi },
    },
    decision_bearing: {
      stratum: 's_ident', n: deltaPrime.length,
      wilcoxon, hodges_lehmann_descriptive_only: hl,
      bca_delta_ci: { thetaHat: bca.thetaHat, lo: bca.lo, hi: bca.hi },
      level_contrast_l_plus_d_minus_l: {
        pooled: { theta_hat: sIdentLevelCI.thetaHat, lo: sIdentLevelCI.lo, hi: sIdentLevelCI.hi, n_queries: sIdentLevelCI.n_queries },
        per_tier: sIdentLevelPerTier,
      },
    },
    harm: {
      fire_rate_floor: HARM_FIRE_RATE_FLOOR,
      off_stratum: offStratumHarm,
      fire_rate_aggregate: fireRateAggregate,
    },
    supporting: {
      s_approx: { n: supportingApprox.length, bca_delta_ci: { thetaHat: bcaApprox.thetaHat, lo: bcaApprox.lo, hi: bcaApprox.hi } },
      s_prose: { n: supportingProse.length, bca_delta_ci: { thetaHat: bcaProse.thetaHat, lo: bcaProse.lo, hi: bcaProse.hi } },
      delta_log2_rank_co_metric: { n: deltaLog2Values.length, bca_ci: { lo: bcaLog2.lo, hi: bcaLog2.hi }, theta_hat: bcaLog2.thetaHat },
    },
    off_stratum_level_report_l_plus_d_minus_h: offStratumLevelReport,
    descriptive_only: {
      h_plus_d: descriptiveArm('H+D', 3011),
      l_plus_d_esc: descriptiveArm('L+D+esc', 3012),
    },
    escape_cap_sweep: escapeCapSweep,
    verdict: verdictResult,
    projection_provenance: projectionProvenance,
  };
}

/**
 * F-9 firewall block: computed EXCLUSIVELY from `query_set: 'original'` rows.
 * "The original-400 D re-score is the DIRECT test of the F-R2 projection ...
 * the RESULT must report the divergence delta between the two" (AMENDMENT 1,
 * F-4). This function is never called with fresh-set rows, and its output is
 * never read by `evaluateVerdict` or folded into any field above.
 */
function computeProjectionProvenance(originalRows) {
  const t4Rate = (stratum, arm) => {
    const rs = originalRows.filter((r) => r.stratum === stratum && r.tier === 'T4' && r.arm === arm);
    if (rs.length === 0) return null;
    return rs.filter((r) => r.in_window_10).length / rs.length;
  };

  const identLplusD = t4Rate('s_ident', 'L+D');
  const approxLplusD = t4Rate('s_approx', 'L+D');
  const proseLplusD = t4Rate('s_prose', 'L+D');
  const approxL = t4Rate('s_approx', 'L');
  const proseL = t4Rate('s_prose', 'L');

  return {
    NOTE: 'projection-provenance data (mined-from, non-evidentiary) — original-400 re-score, direct test of the F-R2 projection ONLY. Never cited in verdict prose (AMENDMENT 1, F-9).',
    n_original_rows: originalRows.length,
    f_r2_projection: F_R2_PROJECTION,
    original_400_t4_rates: {
      s_ident_l_plus_d: identLplusD,
      s_approx_l_plus_d: approxLplusD,
      s_prose_l_plus_d: proseLplusD,
      s_approx_l: approxL,
      s_prose_l: proseL,
    },
    divergence_delta: {
      s_ident: identLplusD === null ? null : identLplusD - F_R2_PROJECTION.t4_s_ident_in_window_rate,
      s_approx_vs_projection: approxLplusD === null ? null : approxLplusD - F_R2_PROJECTION.t4_s_approx_in_window_rate,
      s_prose_vs_projection: proseLplusD === null ? null : proseLplusD - F_R2_PROJECTION.t4_s_prose_in_window_rate,
      s_approx_vs_l_exactly: (approxLplusD === null || approxL === null) ? null : approxLplusD - approxL,
      s_prose_vs_l_exactly: (proseLplusD === null || proseL === null) ? null : proseLplusD - proseL,
    },
  };
}

/** Reads (and validates) the wrapper's results JSON, hashing it for
 * provenance. Same shape as idfuse-score.mjs's own parseResultsFile,
 * validated against declex-rank-check.mjs's schema. */
export function parseResultsFile(jsonText) {
  const parsed = JSON.parse(jsonText);
  const rows = Array.isArray(parsed) ? parsed : parsed.rows;
  if (!Array.isArray(rows)) throw new Error('results file must be an array or { rows: [...] }');
  rows.forEach(validateResultRow);
  return { rows, sha256: createHash('sha256').update(jsonText).digest('hex') };
}

// ---------------------------------------------------------------------------
// CLI (Gate G — this file HAS its own working entry point, unlike
// idfuse-score.mjs / scale-score.mjs, both of which shipped as pure modules
// with no `process.argv` handling and required a separate runner-authored
// driver (`idfuse-run-score.mjs`, `scale-run-score.mjs`) to be invoked at
// all. HANDOFF_Q1.md §5 logged that defect TWICE ("Treat this as a class,
// not a one-off — fix it before authoring any third scoring instrument.");
// this is that third instrument, so the CLI lives here directly, not in a
// yet-another-driver file.
//
//   node eval/declex-score.mjs --in eval/results/declex-measure-raw.json [--out eval/results/declex-score-output.json]
//   node eval/declex-score.mjs --help
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    }
  }
  return args;
}

function printUsage() {
  console.log('Usage:');
  console.log('  node eval/declex-score.mjs --in <path> [--out <path>]');
  console.log('    Scores a declex-rank-check.mjs measurement output file (default --in eval/results/declex-measure-raw.json,');
  console.log('    default --out eval/results/declex-score-output.json). Rows may mix query_set fresh/original; scoring is');
  console.log('    performed per scoreDeclex\'s F-9 firewall (verdict fields use fresh rows only; projection_provenance uses original rows only).');
  console.log('  node eval/declex-score.mjs --help');
}

function runCli(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const inFile = typeof args.in === 'string' ? args.in : join(REPO_RESULTS_DIR, 'declex-measure-raw.json');
  const outFile = typeof args.out === 'string' ? args.out : join(REPO_RESULTS_DIR, 'declex-score-output.json');

  const rawText = readFileSync(inFile, 'utf8');
  const { rows, sha256 } = parseResultsFile(rawText);
  const scored = scoreDeclex(rows);

  const report = {
    ran_at: new Date().toISOString(),
    source_raw_file: inFile,
    source_row_count: rows.length,
    source_sha256: sha256,
    ...scored,
  };

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(report, null, 2));

  console.log(JSON.stringify(report, null, 2));
  console.log(`\nwrote ${outFile}`);
  console.log(`\n=== VERDICT: ${scored.verdict.verdict} ===`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2));
}
