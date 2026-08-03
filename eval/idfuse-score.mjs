// Q1/IDFUSE — scorer (IMPLEMENTATION_PLAN.md § "Q1/IDFUSE ... PRE-REGISTRATION
// + AMENDMENT 1", commit bed7d48). BUILT AND UNIT-TESTED HERE; NOT run on real
// data by this session (hard rule: no verdict computed over the scored query
// set until a later, explicitly-scored phase).
//
// Reuses the parent Q1/SCALE scorer's validated statistics VERBATIM (imported,
// not reimplemented): `wilcoxonSignedRankExact` (exact DP-convolution
// signed-rank test, validated against full 2^12 brute-force enumeration),
// `bcaBootstrap` (seeded BCa bootstrap), `hodgesLehmannWithCI` (descriptive),
// `log2CensoredRank` (the Δlog2 co-metric's per-value primitive). None of
// that math is re-derived here — see scale-score.mjs's own header for why it
// is trustworthy (Gate 1's registered-but-never-implemented-Wilcoxon defect,
// HANDOFF_Q1.md §5, does not repeat).
//
// What is NOT reused from scale-score.mjs, and why:
// - `scoreStratum` hardcodes the pair `('H','L')` internally (its own
//   `computeDLoss` calls are literal `computeDLoss(rows, stratum, 'H')` /
//   `('L')`) — Q1/IDFUSE needs D_loss/Delta' for the arm pair (L+I, H) on the
//   decision-bearing stratum, PLUS the same construction for two supporting
//   strata, PLUS a same-tier (not cross-tier) paired diff for the efficacy
//   precondition (L+I vs L @ T4 only) — none of which fit the parent's fixed
//   two-arm shape. Reimplemented here as arm-generic helpers.
// - `evaluateVerdict` / `VERDICTS` / `trivialDischargeCheck` implement
//   Q1/SCALE's OWN decision table, which is A DIFFERENT REGISTRATION: it has
//   4 rows + a T4-ceiling trivial-discharge shortcut. Q1/IDFUSE's amended
//   registration (IMPLEMENTATION_PLAN.md:3152-3227) has NO trivial-discharge
//   mechanism at all (grepped the registered text; absent) and a DIFFERENT,
//   5-row verdict table gated by an efficacy 2x2 precondition the parent
//   never had. Porting the parent's trivialDischargeCheck into this scorer
//   would silently add an unregistered escape hatch — not done.
// - `validateResultRow` / `parseResultsFile` (scale-rank-check.mjs /
//   scale-score.mjs) hardcode `arm ∈ ['H','L']`. idfuse-rank-check.mjs's OWN
//   `validateResultRow` (5-arm) is used here instead.

import { createHash } from 'node:crypto';
import {
  wilcoxonSignedRankExact, bcaBootstrap, hodgesLehmannWithCI, log2CensoredRank,
} from './scale-score.mjs';
import { validateResultRow } from './idfuse-rank-check.mjs';

export const ALPHA = 0.05;
export const BOOTSTRAP_B = 10000;

/**
 * The instrument's own precision floor at the registered stratum size (n=150,
 * realized p_nz ≈ 0.107): 5 percentage points (IMPLEMENTATION_PLAN.md:3191-3194).
 * NOT the parent Q1/SCALE's 10pp floor — a different, tighter registered
 * threshold for a different track. If the F6 escalation to n=300 is
 * triggered, the registration recalculates this to ≈3.7pp (procedural, not
 * automated here — see this file's header discussion in the delivery report).
 */
export const PRECISION_FLOOR_PP = 0.05;

const mean = (arr) => (arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length);

// ---------------------------------------------------------------------------
// Arm-generic pairing / D_loss / Delta' construction — Q1/IDFUSE needs these
// parameterized by arbitrary arm pairs (L+I vs H, L+I vs L, H+I vs H, ...),
// unlike scale-score.mjs's hardcoded ('H','L').
// ---------------------------------------------------------------------------

function pairByQueryArmTier(rows, stratum, tier, arm) {
  const map = new Map();
  for (const r of rows) {
    if (r.stratum !== stratum || r.tier !== tier || r.arm !== arm) continue;
    map.set(r.query_id, r);
  }
  return map;
}

/** D_loss(query, arm) = in_window@10(T1) - in_window@10(T4), same F1 sign
 * convention as Q1/SCALE: positive = degraded from T1 to T4. */
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

/** Delta'(query) = D_loss_armA(query) - D_loss_armB(query), paired by
 * query_id present in both arms. Decision-bearing use: armA='L+I', armB='H'
 * (registration: "Delta' = D_loss_{L+I} - D_loss_H"). Positive = armA
 * degrades MORE than armB. */
function computeDeltaPrime(rows, stratum, armA, armB) {
  const dA = computeDLoss(rows, stratum, armA);
  const dB = computeDLoss(rows, stratum, armB);
  const queryIds = [...dA.keys()].filter((qid) => dB.has(qid));
  return queryIds.map((qid) => dA.get(qid) - dB.get(qid));
}

/** Delta-log2(rank) co-metric (supporting only, never dispositive — mirrors
 * scale-run-score.mjs's own construction, generalized to arbitrary arms). */
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

/**
 * Efficacy precondition input: paired diff of RAW in_window@10 AT T4 ONLY
 * (not a T1-T4 D_loss) between L+I and L, S-ident — "Ranker I must actually
 * do something — L+I vs L at T4 on S-ident must show improvement"
 * (IMPLEMENTATION_PLAN.md:3159-3161). Positive = L+I better than L.
 */
function computeEfficacyDiffsAtT4(rows, stratum) {
  const li = pairByQueryArmTier(rows, stratum, 'T4', 'L+I');
  const l = pairByQueryArmTier(rows, stratum, 'T4', 'L');
  const queryIds = [...li.keys()].filter((qid) => l.has(qid));
  return queryIds.map((qid) => Number(li.get(qid).in_window_10) - Number(l.get(qid).in_window_10));
}

// ---------------------------------------------------------------------------
// Decision table (registered, AMENDED) — emits the verdict ROW ONLY, no
// free-text verdict, same discipline as scale-score.mjs's evaluateVerdict.
// ---------------------------------------------------------------------------

export const VERDICTS = Object.freeze({
  GAP_CLOSED: 'IDFUSE_GAP_CLOSED',
  GAP_CLOSED_A_FORTIORI: 'IDFUSE_GAP_CLOSED_A_FORTIORI',
  GAP_SURVIVES: 'IDFUSE_GAP_SURVIVES',
  GAP_SURVIVES_MARGINAL: 'IDFUSE_GAP_SURVIVES_MARGINAL_SUB_PRECISION_FLOOR',
  AMBIGUOUS: 'AMBIGUOUS',
  INERT_LEVER: 'IDFUSE_INERT_LEVER',
});

/** Row-1-shaped closure test: Wilcoxon not significant (degenerate counts as
 * not significant, AMENDMENT 1 F5b) AND all-n BCa CI upper bound <= 5pp. */
function meetsPlainClosureCriteria(wilcoxon, bcaDeltaCI) {
  return (!wilcoxon.significant || wilcoxon.degenerate) && bcaDeltaCI.hi !== null && bcaDeltaCI.hi <= PRECISION_FLOOR_PP;
}

/**
 * The base 5-row table on (wilcoxon, bcaDeltaCI) alone, BEFORE the efficacy
 * gate. Row order matches the registration's own table
 * (IMPLEMENTATION_PLAN.md:3181-3189):
 *   1. not significant (or degenerate) AND CI upper <= 5pp -> GAP CLOSED
 *   2. significant, REVERSE direction (L+I degrades LESS) -> GAP CLOSED, a fortiori
 *   3. significant, L+I degrades MORE, CI upper > 5pp -> GAP SURVIVES
 *   4. significant, L+I degrades MORE, CI upper <= 5pp -> GAP SURVIVES (marginal)
 *   5. anything else -> AMBIGUOUS
 */
function baseVerdictRow({ wilcoxon, bcaDeltaCI }) {
  if (meetsPlainClosureCriteria(wilcoxon, bcaDeltaCI)) {
    return { row: 1, verdict: VERDICTS.GAP_CLOSED };
  }
  if (wilcoxon.significant && wilcoxon.direction === 'negative') {
    return { row: 2, verdict: VERDICTS.GAP_CLOSED_A_FORTIORI };
  }
  if (wilcoxon.significant && wilcoxon.direction === 'positive' && bcaDeltaCI.hi !== null && bcaDeltaCI.hi > PRECISION_FLOOR_PP) {
    return { row: 3, verdict: VERDICTS.GAP_SURVIVES };
  }
  if (wilcoxon.significant && wilcoxon.direction === 'positive' && bcaDeltaCI.hi !== null && bcaDeltaCI.hi <= PRECISION_FLOOR_PP) {
    return { row: 4, verdict: VERDICTS.GAP_SURVIVES_MARGINAL };
  }
  return { row: 5, verdict: VERDICTS.AMBIGUOUS };
}

/**
 * Registered decision-table evaluation for the DECISION-BEARING stratum
 * (S-ident), including the efficacy 2x2 precondition (AMENDMENT 1, F2) and
 * the symmetric (both-directions) consistency triggers.
 *
 * @param {object} input
 * @param {{lo:number|null, hi:number|null}} input.efficacyBcaCI - all-n BCa CI
 *   on mean(in_window@10_{L+I} - in_window@10_L) at T4, S-ident.
 * @param {ReturnType<typeof wilcoxonSignedRankExact>} input.wilcoxon - on
 *   Delta' = D_loss_{L+I} - D_loss_H, S-ident (the decision-bearing test).
 * @param {{lo:number|null, hi:number|null}} input.bcaDeltaCI - all-n BCa CI on
 *   mean(Delta') for S-ident.
 * @param {Array<{name:string, lo:number|null, hi:number|null}>} [input.supportingCIs] -
 *   S-approx/S-prose Delta'_{L+I,H} all-n BCa CIs.
 * @param {{lo:number|null, hi:number|null}|null} [input.deltaLog2CI] - Delta'
 *   on the log2(censored rank) co-metric, S-ident.
 * @param {Array<{tier:string, arm:string, outsideEnvelope:boolean}>} [input.monotonicityFlags]
 */
export function evaluateVerdict({
  efficacyBcaCI, wilcoxon, bcaDeltaCI,
  supportingCIs = [], deltaLog2CI = null, monotonicityFlags = [],
}) {
  const reasoning = [];

  // --- Efficacy precondition (evaluated first, per the registration) ---
  const efficacyPasses = efficacyBcaCI.lo !== null && efficacyBcaCI.lo > 0;
  const efficacyReverseSignificant = efficacyBcaCI.hi !== null && efficacyBcaCI.hi < 0;
  if (efficacyReverseSignificant) {
    reasoning.push(`Efficacy check: L+I vs L @ T4 all-n BCa CI excludes 0 in the REVERSE direction (ranker I significantly HURTS lexical, hi=${efficacyBcaCI.hi}) — not a registered outcome; treated as efficacy FAIL for gating purposes, reported explicitly rather than silently folded in.`);
  }

  const base = baseVerdictRow({ wilcoxon, bcaDeltaCI });

  // "Meets the GAP CLOSED criteria" for the 2x2 gate (AMENDMENT 1, F2):
  // JUDGMENT CALL, flagged in the delivery report — the registration's own
  // worked example (F2) discusses only the plain row-1 criteria colliding
  // with an efficacy failure. Whether the a-fortiori row should ALSO count
  // is not stated explicitly. Treated here as YES: a-fortiori is a strictly
  // STRONGER closure than row 1, and treating it as "does not meet" would
  // route an efficacy-fail + a-fortiori collision to INERT-LEVER — i.e.
  // relabel a positive fusion finding as "the lever failed," the exact
  // false-INERT-LEVER failure mode F1/F2 were registered to prevent.
  const closedCriteriaMet = base.verdict === VERDICTS.GAP_CLOSED || base.verdict === VERDICTS.GAP_CLOSED_A_FORTIORI;

  if (!efficacyPasses) {
    if (closedCriteriaMet) {
      reasoning.push(`Efficacy FAILS (all-n BCa CI on L+I vs L @ T4 includes 0, ci=[${efficacyBcaCI.lo}, ${efficacyBcaCI.hi}]) but Delta' independently meets the GAP CLOSED criteria (base row ${base.row}) -> AMBIGUOUS per the registered collision-cell mapping (AMENDMENT 1, F2); both contrasts reported in full.`);
      return {
        efficacy: { passes: false, reverse_significant: efficacyReverseSignificant, ci: efficacyBcaCI },
        base_row: base.row, verdict: VERDICTS.AMBIGUOUS, reasoning, escalated_to_ambiguous: false,
      };
    }
    reasoning.push(`Efficacy FAILS (all-n BCa CI on L+I vs L @ T4 includes 0, ci=[${efficacyBcaCI.lo}, ${efficacyBcaCI.hi}]) AND Delta' does not meet the GAP CLOSED criteria (base row ${base.row}) -> INERT-LEVER: the gap trivially "survives" but the substantive finding is that ranker I failed as a candidate mechanism.`);
    return {
      efficacy: { passes: false, reverse_significant: efficacyReverseSignificant, ci: efficacyBcaCI },
      base_row: base.row, verdict: VERDICTS.INERT_LEVER, reasoning, escalated_to_ambiguous: false,
    };
  }

  reasoning.push(`Efficacy PASSES (all-n BCa CI on L+I vs L @ T4 excludes 0 in the improving direction, lo=${efficacyBcaCI.lo}) -> Delta' verdict table governs (efficacy is verdict-relevant ONLY as this gate, per the registration).`);
  reasoning.push({
    1: `Delta' not significant (or degenerate) AND all-n BCa CI upper bound (${bcaDeltaCI.hi}) <= ${PRECISION_FLOOR_PP} (5pp).`,
    2: `Delta' significant (p=${wilcoxon.p}) in the REVERSE direction (L+I degrades LESS than H) -> a fortiori.`,
    3: `Delta' significant (p=${wilcoxon.p}), L+I degrading more, all-n BCa CI upper bound (${bcaDeltaCI.hi}) > ${PRECISION_FLOOR_PP} (5pp).`,
    4: `Delta' significant (p=${wilcoxon.p}), L+I degrading more, all-n BCa CI upper bound (${bcaDeltaCI.hi}) <= ${PRECISION_FLOOR_PP} (5pp) -> marginal, sub-precision-floor.`,
    5: 'Neither the GAP CLOSED nor the GAP SURVIVES condition is met.',
  }[base.row]);

  let verdict = base.verdict;
  let escalatedToAmbiguous = false;

  // --- Symmetric consistency triggers (BOTH directions — the Q1/SCALE F-R3
  // lesson, explicitly registered both ways here unlike the parent's single-
  // direction trigger 1). Supporting cells: S-approx, S-prose, Δlog2 co-metric.
  const isClosureVerdict = verdict === VERDICTS.GAP_CLOSED || verdict === VERDICTS.GAP_CLOSED_A_FORTIORI;
  const isSurvivesVerdict = verdict === VERDICTS.GAP_SURVIVES || verdict === VERDICTS.GAP_SURVIVES_MARGINAL;
  const allSupportingCIs = deltaLog2CI !== null
    ? [...supportingCIs, { name: 'delta_log2_rank_co_metric', lo: deltaLog2CI.lo, hi: deltaLog2CI.hi }]
    : supportingCIs;

  if (isClosureVerdict) {
    for (const s of allSupportingCIs) {
      if (s.lo !== null && s.lo > 0) {
        escalatedToAmbiguous = true;
        reasoning.push(`Consistency trigger (closure direction, requirement 1): supporting cell "${s.name}" all-n BCa CI excludes 0 showing L+I significantly WORSE than H (lo=${s.lo}) while the decision-bearing test closed.`);
      }
    }
  }
  if (isSurvivesVerdict) {
    for (const s of allSupportingCIs) {
      if (s.hi !== null && s.hi < 0) {
        escalatedToAmbiguous = true;
        reasoning.push(`Consistency trigger (survives direction, requirement 2): supporting cell "${s.name}" all-n BCa CI excludes 0 showing L+I significantly BETTER than H (hi=${s.hi}) while the decision-bearing test survived.`);
      }
    }
  }

  // Trigger 3 (monotonicity) — reported, never alone forces AMBIGUOUS.
  const outside = monotonicityFlags.filter((f) => f.outsideEnvelope);
  if (outside.length > 0) {
    reasoning.push(`Monotonicity flag (informational only, does not alone force AMBIGUOUS): ${outside.map((f) => `${f.tier}/${f.arm}`).join(', ')}.`);
  }

  if (escalatedToAmbiguous) {
    reasoning.push('Verdict escalated to AMBIGUOUS by a registered symmetric consistency trigger — report and escalate by increasing n (pre-registered n=300 escalation, AMENDMENT 1 F6), never by reinterpreting.');
    return {
      efficacy: { passes: true, reverse_significant: efficacyReverseSignificant, ci: efficacyBcaCI },
      base_row: base.row, verdict: VERDICTS.AMBIGUOUS, reasoning, escalated_to_ambiguous: true,
    };
  }

  return {
    efficacy: { passes: true, reverse_significant: efficacyReverseSignificant, ci: efficacyBcaCI },
    base_row: base.row, verdict, reasoning, escalated_to_ambiguous: false,
  };
}

// ---------------------------------------------------------------------------
// Top-level scoring orchestration — reads the wrapper's results rows.
// NOT invoked on real data by this session.
// ---------------------------------------------------------------------------

/**
 * Full scoring pass: efficacy precondition, decision-bearing Delta'
 * (L+I vs H, S-ident), supporting strata (S-approx, S-prose), the Δlog2
 * co-metric, the registered verdict, and DESCRIPTIVE-ONLY reporting for
 * H+I and L+Isym (excluded from all verdict logic, per the registration).
 */
export function scoreIdfuse(rows) {
  for (const r of rows) validateResultRow(r);

  const efficacyDiffs = computeEfficacyDiffsAtT4(rows, 's_ident');
  const efficacyWilcoxon = wilcoxonSignedRankExact(efficacyDiffs);
  const efficacyBca = bcaBootstrap(efficacyDiffs, mean, { seed: 2001 });

  const deltaPrime = computeDeltaPrime(rows, 's_ident', 'L+I', 'H');
  const wilcoxon = wilcoxonSignedRankExact(deltaPrime);
  const bca = bcaBootstrap(deltaPrime, mean, { seed: 2002 });
  const hl = hodgesLehmannWithCI(deltaPrime, { seed: 2006 });

  const supportingApprox = computeDeltaPrime(rows, 's_approx', 'L+I', 'H');
  const supportingProse = computeDeltaPrime(rows, 's_prose', 'L+I', 'H');
  const bcaApprox = bcaBootstrap(supportingApprox, mean, { seed: 2003 });
  const bcaProse = bcaBootstrap(supportingProse, mean, { seed: 2004 });

  const deltaLog2Values = computeDeltaLog2(rows, 's_ident', 'L+I', 'H');
  const bcaLog2 = bcaBootstrap(deltaLog2Values, mean, { seed: 2005 });

  const supportingCIs = [
    { name: 's_approx', lo: bcaApprox.lo, hi: bcaApprox.hi },
    { name: 's_prose', lo: bcaProse.lo, hi: bcaProse.hi },
  ];
  const deltaLog2CI = { lo: bcaLog2.lo, hi: bcaLog2.hi };

  const verdictResult = evaluateVerdict({
    efficacyBcaCI: { lo: efficacyBca.lo, hi: efficacyBca.hi },
    wilcoxon, bcaDeltaCI: { lo: bca.lo, hi: bca.hi },
    supportingCIs, deltaLog2CI,
  });

  // H+I, L+Isym — DESCRIPTIVE ONLY, same Delta'-vs-H construction, NEVER
  // passed into evaluateVerdict (registration: "barred from bearing the
  // close/survive verdict", "never verdict-bearing, same status as H+I").
  const descriptiveArm = (arm) => {
    const deltas = computeDeltaPrime(rows, 's_ident', arm, 'H');
    const w = wilcoxonSignedRankExact(deltas);
    const b = bcaBootstrap(deltas, mean, { seed: 2010 + (arm === 'H+I' ? 0 : 1) });
    return { arm, n: deltas.length, wilcoxon: w, bca_delta_ci: { thetaHat: b.thetaHat, lo: b.lo, hi: b.hi } };
  };

  return {
    efficacy: {
      n: efficacyDiffs.length, wilcoxon: efficacyWilcoxon,
      bca_ci: { thetaHat: efficacyBca.thetaHat, lo: efficacyBca.lo, hi: efficacyBca.hi },
    },
    decision_bearing: {
      stratum: 's_ident', n: deltaPrime.length,
      wilcoxon, hodges_lehmann_descriptive_only: hl,
      bca_delta_ci: { thetaHat: bca.thetaHat, lo: bca.lo, hi: bca.hi },
    },
    supporting: {
      s_approx: { n: supportingApprox.length, bca_delta_ci: { thetaHat: bcaApprox.thetaHat, lo: bcaApprox.lo, hi: bcaApprox.hi } },
      s_prose: { n: supportingProse.length, bca_delta_ci: { thetaHat: bcaProse.thetaHat, lo: bcaProse.lo, hi: bcaProse.hi } },
      delta_log2_rank_co_metric: { n: deltaLog2Values.length, bca_ci: deltaLog2CI, theta_hat: bcaLog2.thetaHat },
    },
    descriptive_only: {
      h_plus_i: descriptiveArm('H+I'),
      l_plus_isym: descriptiveArm('L+Isym'),
    },
    verdict: verdictResult,
  };
}

/** Reads (and validates) the wrapper's results JSON, hashing it for
 * provenance. Adapted from scale-score.mjs's parseResultsFile: the same
 * shape and hashing, but validated against idfuse-rank-check.mjs's 5-arm
 * validateResultRow rather than the parent's 2-arm one. */
export function parseResultsFile(jsonText) {
  const parsed = JSON.parse(jsonText);
  const rows = Array.isArray(parsed) ? parsed : parsed.rows;
  if (!Array.isArray(rows)) throw new Error('results file must be an array or { rows: [...] }');
  rows.forEach(validateResultRow);
  return { rows, sha256: createHash('sha256').update(jsonText).digest('hex') };
}
