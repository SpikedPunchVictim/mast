// E1-FTS — the scorer. Every registered threshold lives here and nowhere else.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-FTS PRE-REGISTRATION (2026-08-14),
// as amended by AMENDMENT 1 (same day, pre-run: four spans became six).
//
// Unlike E1-AB, this instrument DOES report an interval. That is the point of
// the five-rung ladder: E1-AB's own results review named "a three-rung slope is
// determined by three points, with no residual freedom and no honest interval"
// as a weakness, and this design answers it. The interval is still context and
// not a bar — every registered condition is read off the HC3 point estimate,
// for E1-PHASE's reason: permitting "the CI touches 1.6" makes every condition
// negotiable after the data arrive.
//
// Run from `packages/mast`, never the repo root.

import { median } from './e1-schedule.mjs';
import { fitSeries } from './e1-phase-score.mjs';
import { FTS_TIERS, FTS_BLOCKS } from './e1-fts-schedule.mjs';

// ---------------------------------------------------------------------------
// Registered constants. Changing any of these changes the experiment.
// ---------------------------------------------------------------------------

/**
 * `b_fts_del >= 1.6`: the delete span itself grows super-linearly.
 *
 * The decomposition condition, and the one NULL is keyed to. The static model
 * predicts ~2.0 (`ln(N*F ratio)/ln(chunk ratio) = 6.035/2.993`); 1.6 sits well
 * below that and well above E1's 1.35 linearity bar, so it can fail without the
 * model being merely slightly off.
 */
export const B_FTS_DEL_FLOOR = 1.6;

/** `fts_del/write >= 0.50` at T9: the delete span is at least half the write phase. */
export const FTS_DEL_SHARE_FLOOR = 0.50;

/** `write_A/write_G >= 2` at T9: removing the deletes at least halves the write phase. */
export const WRITE_RATIO_FLOOR = 2;

/**
 * E1's own pre-registered, immutable super-linearity threshold.
 *
 * Reused deliberately rather than inventing a bar for this experiment, exactly
 * as E1-AB reused it: below it, write is not super-linear *by this program's
 * standing definition*, which is a claim the program has already committed to
 * and cannot renegotiate here.
 */
export const E1_SUPERLINEAR_THRESHOLD = 1.35;

/**
 * The instrument-validity tolerance. ADJUDICATES NOTHING — see {@link validityCheck}.
 */
export const VALIDITY_TOLERANCE = 0.15;

/** Reported as a finding, never a gate — the spread of the three block ratios. */
export const RATIO_SPREAD_FINDING = 0.15;

// ---------------------------------------------------------------------------

/** Runs for one arm, in schedule order. */
const armRuns = (runs, arm) => runs.filter((r) => r.arm === arm);

/**
 * The primary estimator: arm A over arm G, taken INSIDE each block, then medianed.
 *
 * Never median-of-A over median-of-G. Drift between blocks cancels in the first
 * form and does not in the second, and blocks are contiguous precisely so that
 * cancellation is available.
 *
 * A block missing either arm is DROPPED and named, never paired across blocks —
 * a cross-block pairing would reintroduce the drift the design exists to remove.
 *
 * @param {object[]} runs every run
 * @param {string} tier the rung to read
 * @param {(run: object) => number} extract the quantity to compare
 */
export function withinBlockRatios(runs, tier, extract) {
  const perBlock = [];
  const dropped = [];
  for (let block = 1; block <= FTS_BLOCKS; block++) {
    const cell = runs.filter((r) => r.tier === tier && r.block === block);
    const a = cell.find((r) => r.arm === 'A');
    const g = cell.find((r) => r.arm === 'G');
    if (a === undefined || g === undefined) {
      dropped.push(block);
      continue;
    }
    const denom = extract(g);
    if (!(denom > 0)) {
      dropped.push(block);
      continue;
    }
    perBlock.push(extract(a) / denom);
  }
  const med = perBlock.length > 0 ? median(perBlock) : null;
  return {
    per_block: perBlock,
    median: med,
    // Reported rather than smoothed away: with three blocks a median hides two
    // of the three numbers, and the spread is what says whether that is safe.
    spread: med !== null && med !== 0
      ? (Math.max(...perBlock) - Math.min(...perBlock)) / med
      : null,
    blocks_dropped: dropped,
  };
}

/**
 * A span's share of the write phase at one rung, under BOTH readings.
 *
 * The registration names the condition "`fts_del/write >= 0.50` at T9" without
 * saying which reading it means. Both are computed and both are reported; the
 * one that ADJUDICATES is `median_run` — the share of the rung's median run —
 * following E1-PHASE's H1 precedent. Fixed here, in code, before any data
 * exists, rather than chosen once the two disagree.
 *
 * @param {object[]} runs every run (arm A only — arm G's `fts_del` is zero by construction)
 * @param {string} tier
 * @param {string} span one of WRITE_SPANS
 */
export function rungShares(runs, tier, span) {
  const cell = runs.filter((r) => r.tier === tier);
  if (cell.length === 0) {
    return { median_run: null, median_of_shares: null, n: 0 };
  }

  // The run whose write phase IS the median — not an average of runs.
  //
  // Selected by RANK rather than by matching the median value. `median` of an
  // even sample averages the two middle values, which equals no run's write
  // phase, so an equality match falls through — and the fallback this replaced
  // (`?? cell[0]`) then silently returned the FIRST run, which is neither the
  // median nor adjacent to it. Unexercised at n=3, armed the moment a block is
  // dropped and a rung has two runs. Found by the adversarial results review.
  const ordered = [...cell].sort((p, q) => p.phase_ms.write - q.phase_ms.write);
  const medianRun = ordered[Math.floor((ordered.length - 1) / 2)];

  const shares = cell
    .filter((r) => r.phase_ms.write > 0)
    .map((r) => r.write_spans[span] / r.phase_ms.write);

  return {
    median_run: medianRun.phase_ms.write > 0
      ? medianRun.write_spans[span] / medianRun.phase_ms.write
      : null,
    median_of_shares: shares.length > 0 ? median(shares) : null,
    n: cell.length,
  };
}

/**
 * The instrument grading itself: two independent measurements of the same
 * quantity must agree.
 *
 * `write_A - write_G` is what removing the deletes actually bought, measured by
 * the intervention. `fts_del_A` is what the timer says those deletes cost,
 * measured directly. They are the same quantity by two routes.
 *
 * **This adjudicates nothing**, and the returned object says so. Disagreement
 * condemns the instrument, not the hypothesis — a scorer that let an instrument
 * check decide an outcome would be grading the experiment on whether its own
 * timers agreed.
 */
export function validityCheck({ writeA, writeG, ftsDelA }) {
  if (!(ftsDelA > 0)) {
    return {
      ok: false,
      reason: 'fts_del_not_positive',
      relative_error: null,
      adjudicates: false,
    };
  }
  const relativeError = Math.abs((writeA - writeG) - ftsDelA) / ftsDelA;
  return {
    ok: relativeError <= VALIDITY_TOLERANCE,
    reason: relativeError <= VALIDITY_TOLERANCE ? null : 'measurements_disagree',
    intervention_delta_ms: writeA - writeG,
    direct_span_ms: ftsDelA,
    relative_error: relativeError,
    tolerance: VALIDITY_TOLERANCE,
    adjudicates: false,
  };
}

/**
 * The registered outcome ladder.
 *
 * Order is load-bearing:
 *
 * 1. **VOID** first. A missing or degenerate exponent must never fall through
 *    to a numeric comparison — `null < 1.6` is `true` in JavaScript, so a
 *    broken fit would otherwise return NULL, the outcome most flattering to a
 *    broken instrument.
 * 2. **NULL** second, keyed to `b_fts_del` ALONE. It means the static model is
 *    wrong about in-build behaviour, which is a publishable finding rather than
 *    a failed experiment.
 * 3. **MECHANISM_IDENTIFIED** iff all four conditions hold.
 * 4. **PARTIAL** otherwise — a FIRST-CLASS outcome, registered in advance so it
 *    cannot be reported as a disappointment or as a null. `chunks` carries a
 *    TEXT primary key whose autoindex is a plausible second super-linear term;
 *    if it is real, removing the delete-scan reduces the exponent without
 *    flattening it, and that is a result.
 */
export function adjudicate({ b_fts_del, b_rest, b_write_g, share_fts_del_t9, write_ratio_t9 }) {
  const values = { b_fts_del, b_rest, b_write_g, share_fts_del_t9, write_ratio_t9 };
  const missing = Object.entries(values)
    .filter(([, v]) => typeof v !== 'number' || !Number.isFinite(v))
    .map(([k]) => k);
  if (missing.length > 0) {
    return { outcome: 'VOID', reason: `unreadable_${missing.join('_')}`, conditions: [] };
  }

  const conditions = [
    { id: 'b_fts_del', label: 'the delete span grows super-linearly',
      value: b_fts_del, threshold: B_FTS_DEL_FLOOR, met: b_fts_del >= B_FTS_DEL_FLOOR },
    { id: 'share_fts_del_t9', label: 'the delete span is at least half of T9\'s write phase',
      value: share_fts_del_t9, threshold: FTS_DEL_SHARE_FLOOR,
      met: share_fts_del_t9 >= FTS_DEL_SHARE_FLOOR },
    { id: 'write_ratio_t9', label: 'removing the deletes at least halves T9\'s write phase',
      value: write_ratio_t9, threshold: WRITE_RATIO_FLOOR,
      met: write_ratio_t9 >= WRITE_RATIO_FLOOR },
    { id: 'b_write_g', label: 'arm G\'s write phase is linear by E1\'s own bar',
      value: b_write_g, threshold: E1_SUPERLINEAR_THRESHOLD,
      met: b_write_g <= E1_SUPERLINEAR_THRESHOLD },
    // BLOCKING, per AMENDMENT 2 — see the note below. The registration's
    // MECHANISM_IDENTIFIED clause says "all four", and its PARTIAL clause says
    // "(1-2) hold but b_rest > 1.35"; those disagree about the case where all
    // four hold AND rest is super-linear. The explicit clause governs.
    { id: 'b_rest', label: 'no second super-linear term survives in rest',
      value: b_rest, threshold: E1_SUPERLINEAR_THRESHOLD,
      met: b_rest <= E1_SUPERLINEAR_THRESHOLD },
  ];

  if (b_fts_del < B_FTS_DEL_FLOOR) {
    return { outcome: 'NULL', reason: 'b_fts_del_below_floor', conditions };
  }

  if (conditions.every((c) => c.met)) {
    return { outcome: 'MECHANISM_IDENTIFIED', reason: null, conditions };
  }
  return {
    outcome: 'PARTIAL',
    reason: `unmet_${conditions.filter((c) => !c.met).map((c) => c.id).join('_')}`,
    conditions,
  };
}

/**
 * Every exponent this experiment fits, per arm.
 *
 * `fitSeries` is IMPORTED from E1-PHASE's scorer rather than reimplemented —
 * it fits `ln(series_ms)` on `ln(chunk_count)` with an HC3 interval, and using
 * the identical estimator is what makes `b_write(G)` comparable to E1's
 * immutable 1.35 threshold at all. Each arm has 15 runs, the same shape
 * E1-PHASE fitted.
 */
export function fitExponents(runs) {
  const a = armRuns(runs, 'A');
  const g = armRuns(runs, 'G');
  return {
    b_fts_del: fitSeries(a, (r) => r.write_spans.fts_del),
    b_fts_ins: fitSeries(a, (r) => r.write_spans.fts_ins),
    b_commit: fitSeries(a, (r) => r.write_spans.commit),
    b_rest: fitSeries(a, (r) => r.write_spans.rest),
    b_write_a: fitSeries(a, (r) => r.phase_ms.write),
    b_write_g: fitSeries(g, (r) => r.phase_ms.write),
  };
}

/** The tiers this scorer expects to find, re-exported so the report cannot drift from it. */
export { FTS_TIERS };

/**
 * Every registered statistic, assembled.
 *
 * The adjudicating inputs are named explicitly in `verdict_inputs` rather than
 * left to be reconstructed from the tables — the registration fixed which
 * reading adjudicates (AMENDMENT 2), and a reader must be able to see the five
 * numbers that decided the outcome without re-deriving them.
 */
export function scoreFts(runs) {
  const armA = runs.filter((r) => r.arm === 'A');
  const exponents = fitExponents(runs);

  const shares = {};
  const ratios = {};
  for (const tier of FTS_TIERS) {
    shares[tier] = Object.fromEntries(
      ['fts_del', 'fts_ins', 'commit', 'rest', 'txn', 'lock']
        .map((span) => [span, rungShares(armA, tier, span)]),
    );
    ratios[tier] = withinBlockRatios(runs, tier, (r) => r.phase_ms.write);
  }

  // At T7 and T9 only, as registered — the rungs where the delete span is large
  // enough that the two measurements can meaningfully disagree.
  const validity = {};
  for (const tier of ['T7', 'T9']) {
    const a = runs.filter((r) => r.tier === tier && r.arm === 'A');
    const g = runs.filter((r) => r.tier === tier && r.arm === 'G');
    validity[tier] = a.length > 0 && g.length > 0
      ? validityCheck({
          writeA: median(a.map((r) => r.phase_ms.write)),
          writeG: median(g.map((r) => r.phase_ms.write)),
          ftsDelA: median(a.map((r) => r.write_spans.fts_del)),
        })
      : { ok: false, reason: 'rung_incomplete', adjudicates: false };
  }

  const verdictInputs = {
    b_fts_del: exponents.b_fts_del.b ?? null,
    b_rest: exponents.b_rest.b ?? null,
    b_write_g: exponents.b_write_g.b ?? null,
    // AMENDMENT 2: the median RUN's own share adjudicates, not the median of shares.
    share_fts_del_t9: shares.T9.fts_del.median_run,
    write_ratio_t9: ratios.T9.median,
  };

  return {
    exponents,
    shares,
    write_ratio: ratios,
    // A FINDING, never a gate — see `spilloverRows`. Reported because the first
    // schedule left this effect visible in the spans and unnamed.
    spillover: spilloverRows(runs),
    instrument_validity: validity,
    verdict_inputs: verdictInputs,
    verdict: adjudicate(verdictInputs),
  };
}

/** The five spans that are not the delete span. */
export const NON_DELETE_SPANS = ['fts_ins', 'commit', 'rest', 'txn', 'lock'];

/**
 * The eviction cost the delete-scans impose on everything ELSE in the write phase.
 *
 * The adversarial results review's finding 2. Arm G is faster at non-delete work
 * too — at T9 its non-delete spans are 7,858 ms lower than arm A's, with `rest`
 * alone +70%. So `write_A - write_G` is the directly-timed delete span PLUS a
 * secondary effect: the scans evict pages that the inserts, the commit and the
 * ordinary-table writes then have to fault back in, which is exactly what
 * E1-AB's cache dose-response predicts. The effect was visible in the spans of
 * the first schedule and went unreported.
 *
 * **A FINDING, never a gate, and it does not threaten the intervention result.**
 * The spillover is a causal CONSEQUENCE of the deletes, so it belongs inside
 * what removing them buys — `write_A/write_G` stays the honest measure. What it
 * costs is the decomposition's precision: `fts_del` UNDER-states the deletes'
 * full cost rather than over-stating it, which is the safe direction.
 *
 * Measured within a block and then medianed, for the estimator's usual reason.
 * A negative value is reported rather than clamped: it would mean arm G was
 * slower at non-delete work, which the eviction story does not predict, and
 * suppressing it would hide a contradiction.
 */
export function spilloverRows(runs) {
  const nonDelete = (r) => NON_DELETE_SPANS.reduce((t, k) => t + (r.write_spans[k] ?? 0), 0);

  return FTS_TIERS.map((tier) => {
    const perBlock = [];
    const perSpan = Object.fromEntries(NON_DELETE_SPANS.map((k) => [k, []]));
    const deltas = [];

    for (let block = 1; block <= FTS_BLOCKS; block++) {
      const cell = runs.filter((r) => r.tier === tier && r.block === block);
      const a = cell.find((r) => r.arm === 'A');
      const g = cell.find((r) => r.arm === 'G');
      if (a === undefined || g === undefined) continue;
      perBlock.push(nonDelete(a) - nonDelete(g));
      deltas.push(a.phase_ms.write - g.phase_ms.write);
      for (const k of NON_DELETE_SPANS) {
        perSpan[k].push((a.write_spans[k] ?? 0) - (g.write_spans[k] ?? 0));
      }
    }

    if (perBlock.length === 0) {
      return {
        tier, per_block: [], spillover_ms: null, share_of_delta: null,
        by_span: Object.fromEntries(NON_DELETE_SPANS.map((k) => [k, null])),
        adjudicates: false,
      };
    }

    const spillover = median(perBlock);
    const delta = median(deltas);
    return {
      tier,
      per_block: perBlock,
      spillover_ms: spillover,
      share_of_delta: delta !== 0 ? spillover / delta : null,
      by_span: Object.fromEntries(NON_DELETE_SPANS.map((k) => [k, median(perSpan[k])])),
      adjudicates: false,
    };
  });
}
