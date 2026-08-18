// E1-LADDER — the scorer. Reads `e1-ladder-runs.jsonl`, writes `e1-ladder-verdict.json`.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-LADDER PRE-REGISTRATION (2026-08-17).
//
// Usage (run from packages/mast, never the repo root — FINDINGS.md §5):
//   node eval/e1-ladder-score.mjs
//
// Writes only `eval/results/e1-ladder-verdict.json`. It never touches another experiment's
// artifacts, and it never appends to any journal.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS_DIR, writeResult } from './e1-common.mjs';
import { median } from './e1-schedule.mjs';
import { olsFit, hc3SlopeSe, studentTQuantile, quadraticDeparturePct } from './e1-stats.mjs';
import {
  LADDER_TIERS, LADDER_TOTAL_RUNS, H1_EXPONENT_BAR, H2_MIN_SEPARATION, H3_MAX_LOCAL_SLOPE,
  GATE_L_SCAN_ARM_R, GATE_L_BAND,
} from './e1-ladder-schedule.mjs';

const log = (...a) => console.log(...a);

function readJournal(name) {
  const p = join(RESULTS_DIR, name);
  if (!existsSync(p)) throw new Error(`Missing journal: ${p}`);
  return readFileSync(p, 'utf-8').split('\n').filter((l) => l.trim() !== '').map((l, i) => {
    try { return JSON.parse(l); } catch { throw new Error(`${name} line ${i + 1} is unparseable.`); }
  });
}

/**
 * The scored run set: last write per key wins, a `void` removes the key.
 *
 * This is `e1-verify-score.mjs:29-36`'s selection rule, reproduced because that scorer does
 * the fold inline in `main()`. A plain `type === 'run'` filter is NOT equivalent — it admits
 * superseded duplicates and runs that were later voided, which is how `FINDINGS.md` §1 records
 * a naive filter returning 32 rows where `e1-fts-score.mjs` scores 30.
 */
function foldRuns(records, keyOf) {
  const done = new Map(), voids = new Map();
  for (const r of records) {
    const k = keyOf(r);
    if (r.type === 'run') { done.set(k, r); voids.delete(k); }
    else if (r.type === 'void') { voids.set(k, r); done.delete(k); }
  }
  return { runs: [...done.values()], voids: [...voids.values()] };
}

/**
 * The registered estimator: OLS of ln(y) on ln(x), HC3 slope SE, 95% t interval.
 *
 * Deliberately identical in arithmetic to `e1-unread-fit.mjs`'s private `fitLogLog` — it uses
 * the same three primitives from `e1-stats.mjs` in the same order. It is re-implemented rather
 * than imported because that function is module-private there, and exporting it would edit a
 * script that is the published source of this experiment's comparator. The duplication is
 * checked rather than trusted: `selfCheck()` below refuses to score unless this function
 * reproduces the committed pre-fix figure exactly.
 *
 * `ci_is_context_only` is carried verbatim from that script and means what it says. The rungs
 * are NESTED SUBSETS (T1 subset of T2 subset of ... subset of T9), so the points are not
 * independent draws, and no p-value or coverage claim is made from this interval.
 */
function fitLogLog(pts) {
  const bad = pts.filter((p) => !(p.y > 0) || !(p.x > 0));
  if (bad.length > 0) {
    return { degenerate: 'non_positive_values', n_total: pts.length, n_non_positive: bad.length };
  }
  const xs = pts.map((p) => Math.log(p.x));
  const ys = pts.map((p) => Math.log(p.y));
  const fit = olsFit(xs, ys);
  const se = hc3SlopeSe(fit, xs);
  const t = studentTQuantile(0.975, fit.n - 2);
  const ybar = ys.reduce((s, v) => s + v, 0) / ys.length;
  const ssTot = ys.reduce((s, v) => s + (v - ybar) ** 2, 0);
  const ssRes = fit.resid.reduce((s, r) => s + r * r, 0);
  return {
    b: fit.slope,
    se_hc3: se,
    r2: 1 - ssRes / ssTot,
    n: fit.n,
    df: fit.n - 2,
    ci_hc3: [fit.slope - t * se, fit.slope + t * se],
    ci_is_context_only: true,
  };
}

/** Per-rung medians plus both registered estimators over one series. */
function fitBoth(runs, rungOf, extract) {
  const byRung = new Map();
  for (const r of runs) {
    const k = rungOf(r);
    if (!byRung.has(k)) byRung.set(k, []);
    byRung.get(k).push(r);
  }
  const rungs = [...byRung.entries()]
    .map(([rung, rs]) => ({
      rung,
      chunks: rs[0].chunk_count,
      files: rs[0].file_count,
      n: rs.length,
      values: rs.map(extract),
      median_ms: median(rs.map(extract)),
    }))
    .sort((a, b) => a.chunks - b.chunks);

  return {
    all_runs: fitLogLog(runs.map((r) => ({ x: r.chunk_count, y: extract(r) }))),
    rung_medians: fitLogLog(rungs.map((r) => ({ x: r.chunks, y: r.median_ms }))),
    rungs,
  };
}

/** Adjacent-rung local slopes: d ln(edges) / d ln(chunks) between neighbours. */
function localSlopes(rungs) {
  const out = [];
  for (let i = 1; i < rungs.length; i++) {
    const a = rungs[i - 1], b = rungs[i];
    out.push({
      segment: `${a.rung}->${b.rung}`,
      slope: Math.log(b.median_ms / a.median_ms) / Math.log(b.chunks / a.chunks),
    });
  }
  return out;
}

/**
 * SELF-CHECK — refuse to score unless this file's estimator reproduces the comparator.
 *
 * H2 subtracts a number produced by a DIFFERENT script (`e1-unread-fit.mjs`) from a number
 * produced by this one. That subtraction is only meaningful if both were computed the same
 * way. Rather than assert it in prose, recompute the pre-fix fit here from the same journal
 * and require an exact match against the committed artifact.
 */
function selfCheck(verifyRuns) {
  const committedPath = join(RESULTS_DIR, 'e1-unread-fit.json');
  if (!existsSync(committedPath)) {
    throw new Error('e1-unread-fit.json is absent — H2 has no comparator and this run cannot be scored.');
  }
  const committed = JSON.parse(readFileSync(committedPath, 'utf-8'));
  const want = committed?.e1_verify?.phases?.edges;
  if (!want?.all_runs?.b) {
    throw new Error('e1-unread-fit.json has no e1_verify.phases.edges.all_runs.b — the comparator moved.');
  }
  // FINDINGS.md §1: e1-verify rows carry the rung as `corpus`, NOT `tier`. Grouping by `tier`
  // collapses all nine rungs into one bucket and returns T5's value looking ladder-wide.
  //
  // And the value is the TOP-LEVEL `phase_ms`, not `measurement.phase_ms`. On a run where
  // Gate 3 failed, `selectFitted` puts the fitted attempt at the top level and leaves the last
  // raw attempt under `measurement` — so `measurement` scores the wrong attempt on precisely
  // the runs the retake machinery exists to handle. E1-VERIFY has one such row (T3 rep 3,
  // fitted 240 ms vs raw 233 ms). It does not move T3's median, so the rung-median fit is
  // unaffected and only the 27-point fit shifts — which is how this self-check caught it.
  const got = fitBoth(verifyRuns, (r) => r.corpus, (r) => r.phase_ms.edges);
  const dAll = Math.abs(got.all_runs.b - want.all_runs.b);
  const dMed = Math.abs(got.rung_medians.b - want.rung_medians.b);
  const TOL = 1e-9;
  const ok = dAll < TOL && dMed < TOL;
  if (!ok) {
    throw new Error(
      'SELF-CHECK FAILED: this scorer does not reproduce e1-unread-fit.json.\n' +
      `  all_runs     committed ${want.all_runs.b}  here ${got.all_runs.b}  delta ${dAll}\n` +
      `  rung_medians committed ${want.rung_medians.b}  here ${got.rung_medians.b}  delta ${dMed}\n` +
      'H2 subtracts one from the other, so a mismatch makes the comparison meaningless.'
    );
  }
  return { ok, b_verify_all_runs: want.all_runs.b, b_verify_rung_medians: want.rung_medians.b, fit: got };
}

/**
 * Weighted least squares for the two-term model `edges_ms = a*E + b*E*F`, no intercept.
 *
 * DESCRIPTIVE ONLY — this adjudicates nothing. See the "Also computed" clause of the
 * registration. Its purpose is to retire three figures that `FINDINGS.md` §2.3 quotes from
 * prose while admitting no committed script computes them.
 *
 * @param {Array<{E:number,F:number,y:number}>} pts
 * @param {(y:number)=>number} weight 1 for OLS; 1/y^2 for relative-error weighting
 */
function twoTermFit(pts, weight) {
  let sEE = 0, sEEF = 0, sEEFF = 0, sEy = 0, sEFy = 0;
  for (const { E, F, y } of pts) {
    const w = weight(y);
    sEE += w * E * E;
    sEEF += w * E * E * F;
    sEEFF += w * E * E * F * F;
    sEy += w * E * y;
    sEFy += w * E * F * y;
  }
  const det = sEE * sEEFF - sEEF * sEEF;
  if (det === 0) return { degenerate: 'singular_normal_equations' };
  const a = (sEy * sEEFF - sEFy * sEEF) / det;
  const b = (sEE * sEFy - sEEF * sEy) / det;
  return { a, b, predict: (E, F) => a * E + b * E * F };
}

function main() {
  // -----------------------------------------------------------------------
  // Load
  // -----------------------------------------------------------------------
  // The self-check runs FIRST and depends only on committed artifacts, so the estimator can be
  // validated before any ladder run exists — a broken comparator should surface in seconds, not
  // after the schedule has been spent.
  const verifyFold = foldRuns(readJournal('e1-verify-runs.jsonl'), (r) => `${r.corpus}#r${r.rep}`);
  if (verifyFold.voids.length > 0) {
    throw new Error(`E1-VERIFY has ${verifyFold.voids.length} unresolved voids; the comparator is not fittable.`);
  }
  const verify = verifyFold.runs;
  const check = selfCheck(verify);
  log(`[E1-LADDER] self-check OK — estimator reproduces e1-unread-fit.json (b_verify = ${check.b_verify_all_runs.toFixed(6)})`);

  const journalPath = join(RESULTS_DIR, 'e1-ladder-runs.jsonl');
  if (!existsSync(journalPath)) {
    log('[E1-LADDER] no ladder journal yet — self-check only, nothing to score.');
    return;
  }
  const ladderFold = foldRuns(readJournal('e1-ladder-runs.jsonl'), (r) => `${r.corpus}#r${r.rep}`);
  const ladder = ladderFold.runs;
  const voids = ladderFold.voids;

  const scoreable = ladder.length === LADDER_TOTAL_RUNS && voids.length === 0;
  if (!scoreable) {
    log(`[E1-LADDER] NOT SCOREABLE: ${ladder.length}/${LADDER_TOTAL_RUNS} runs, ${voids.length} void`);
  }

  // -----------------------------------------------------------------------
  // The primary series
  // -----------------------------------------------------------------------
  const post = fitBoth(ladder, (r) => r.tier, (r) => r.phase_ms.edges);
  const pre = check.fit;
  const slopes = localSlopes(post.rungs);
  const preSlopes = localSlopes(pre.rungs);

  // -----------------------------------------------------------------------
  // H1 / H2 / H3 — none of which touches potential_call_count (FINDINGS.md §1.1)
  // -----------------------------------------------------------------------
  const bR = post.all_runs.b;
  const bV = check.b_verify_all_runs;
  const maxSlope = slopes.reduce((m, s) => (s.slope > m.slope ? s : m), slopes[0]);

  const h1 = {
    statement: 'post-fix edges exponent (all_runs, n=27) is at or below the bar — no residual worth naming',
    bar: H1_EXPONENT_BAR, observed: bR, fires: bR <= H1_EXPONENT_BAR,
    residual_if_refuted: bR > H1_EXPONENT_BAR ? bR - 1 : null,
  };
  const h2 = {
    statement: 'the pre/post separation reproduces — guards H1 against a harness or machine artifact',
    min_separation: H2_MIN_SEPARATION, b_verify: bV, b_ladder: bR,
    observed: bV - bR, fires: bV - bR >= H2_MIN_SEPARATION,
  };
  const h3 = {
    statement: 'no bend — the fix removes the knee rather than postponing it above T9',
    bar: H3_MAX_LOCAL_SLOPE, observed: maxSlope.slope, at_segment: maxSlope.segment,
    fires: maxSlope.slope <= H3_MAX_LOCAL_SLOPE,
    all_segments: slopes,
  };

  // -----------------------------------------------------------------------
  // Gate L — cross-experiment replication against E1-SCAN arm R. FINDING, not a blocker.
  // -----------------------------------------------------------------------
  const gateL = { band: GATE_L_BAND, rungs: [], findings: [] };
  for (const [rung, scanMs] of Object.entries(GATE_L_SCAN_ARM_R)) {
    const here = post.rungs.find((r) => r.rung === rung);
    if (!here) { gateL.findings.push(`${rung} absent from this ladder`); continue; }
    const dev = (here.median_ms - scanMs) / scanMs;
    gateL.rungs.push({ rung, e1_scan_arm_r_ms: scanMs, e1_ladder_ms: here.median_ms, deviation: dev });
    if (Math.abs(dev) > GATE_L_BAND) {
      gateL.findings.push(
        `${rung}: E1-LADDER ${here.median_ms} ms vs E1-SCAN arm R ${scanMs} ms — ${(dev * 100).toFixed(1)}%, outside +/-${GATE_L_BAND * 100}%`);
    }
  }
  gateL.ok = gateL.findings.length === 0;

  // -----------------------------------------------------------------------
  // Descriptive, adjudicating nothing (registration, "Also computed")
  // -----------------------------------------------------------------------
  // Top-level `phase_ms` throughout, for the fitted-attempt reason given in `selfCheck`.
  const prePts = verify.map((r) => ({
    E: r.edge_count ?? r.measurement.edge_count,
    F: r.file_count ?? r.measurement.file_count,
    y: r.phase_ms.edges,
  }));
  const vscodePath = join(RESULTS_DIR, 'vscode-build.json');
  const vscode = existsSync(vscodePath) ? JSON.parse(readFileSync(vscodePath, 'utf-8')) : null;

  const twoTerm = {};
  for (const [name, w] of [['unweighted', () => 1], ['relative', (y) => 1 / (y * y)]]) {
    const f = twoTermFit(prePts, w);
    if (f.degenerate) { twoTerm[name] = f; continue; }
    const byRung = new Map();
    for (const r of verify) {
      if (!byRung.has(r.corpus)) byRung.set(r.corpus, []);
      byRung.get(r.corpus).push(r);
    }
    const rungErr = [...byRung.entries()].map(([rung, rs]) => {
      const E = median(rs.map((r) => r.edge_count ?? r.measurement.edge_count));
      const F = rs[0].file_count ?? rs[0].measurement.file_count;
      const y = median(rs.map((r) => r.phase_ms.edges));
      return { rung, chunks: rs[0].chunk_count, actual_ms: y, predicted_ms: f.predict(E, F),
        error: (f.predict(E, F) - y) / y };
    }).sort((a, b) => a.chunks - b.chunks);

    twoTerm[name] = {
      a: f.a, b: f.b,
      per_rung: rungErr,
      T1_error: rungErr.find((r) => r.rung === 'T1')?.error ?? null,
      T9_error: rungErr.find((r) => r.rung === 'T9')?.error ?? null,
      vscode_out_of_sample: vscode ? (() => {
        const m = vscode.measured;
        const p = f.predict(m.edge_count, m.file_count);
        return { file_count: m.file_count, edge_count: m.edge_count, actual_ms: m.phase_ms.edges,
          predicted_ms: p, error: (p - m.phase_ms.edges) / m.phase_ms.edges };
      })() : null,
    };
  }

  // A curvature statistic that already exists in e1-stats.mjs. UNREGISTERED and descriptive —
  // reported for context, never as an adjudicator. H3's local slopes are the registered test.
  const curvature = {
    note: 'descriptive, unregistered — H3 is the registered bend test',
    post_fix_pct: quadraticDeparturePct(
      post.rungs.map((r) => Math.log(r.chunks)), post.rungs.map((r) => Math.log(r.median_ms))),
    pre_fix_pct: quadraticDeparturePct(
      pre.rungs.map((r) => Math.log(r.chunks)), pre.rungs.map((r) => Math.log(r.median_ms))),
  };

  // -----------------------------------------------------------------------
  // Verdict
  // -----------------------------------------------------------------------
  const verdict = {
    created: new Date().toISOString(),
    experiment: 'E1-LADDER',
    registration: 'IMPLEMENTATION_PLAN.md § E1-LADDER PRE-REGISTRATION (2026-08-17)',
    scoreable,
    n_runs: ladder.length, n_void: voids.length,
    self_check: { ok: check.ok, b_verify_all_runs: bV, b_verify_rung_medians: check.b_verify_rung_medians },
    post_fix: { all_runs: post.all_runs, rung_medians: post.rung_medians, rungs: post.rungs },
    pre_fix: { all_runs: pre.all_runs, rung_medians: pre.rung_medians, rungs: pre.rungs,
      source: 'e1-verify-runs.jsonl, keyed by `corpus` per FINDINGS.md §1' },
    local_slopes: { post_fix: slopes, pre_fix: preSlopes },
    hypotheses: { H1: h1, H2: h2, H3: h3 },
    gate_L: gateL,
    descriptive: {
      note: 'Adjudicates nothing. Retires the prose-only figures in FINDINGS.md §2.3.',
      two_term_model: twoTerm,
      curvature,
    },
  };
  writeResult('e1-ladder-verdict.json', verdict);

  // -----------------------------------------------------------------------
  // Report
  // -----------------------------------------------------------------------
  log('');
  log('  rung   chunks   files   pre-fix   post-fix   ratio');
  for (const r of post.rungs) {
    const p = pre.rungs.find((x) => x.rung === r.rung);
    log(`  ${r.rung.padEnd(5)} ${String(r.chunks).padStart(7)} ${String(r.files).padStart(7)}` +
        `${String(p ? p.median_ms : '—').padStart(10)}${String(r.median_ms).padStart(11)}` +
        `${(p ? (p.median_ms / r.median_ms).toFixed(3) : '—').padStart(8)}`);
  }
  log('');
  log(`  exponent  pre-fix  ${bV.toFixed(4)} (all_runs n=${pre.all_runs.n})   post-fix  ${bR.toFixed(4)} (all_runs n=${post.all_runs.n})`);
  log(`            rung medians: pre ${pre.rung_medians.b.toFixed(4)}   post ${post.rung_medians.b.toFixed(4)}`);
  log('');
  log('  local slopes (post-fix): ' + slopes.map((s) => `${s.segment} ${s.slope.toFixed(3)}`).join('  '));
  log('');
  for (const [name, h] of Object.entries(verdict.hypotheses)) {
    log(`  ${name}  ${h.fires ? 'FIRES  ' : 'REFUTED'}  observed ${h.observed.toFixed(4)}  ` +
        `(${name === 'H2' ? `>= ${H2_MIN_SEPARATION}` : `<= ${h.bar}`})`);
  }
  log('');
  log(`  Gate L: ${gateL.ok ? 'clean' : gateL.findings.join('; ')}`);
  for (const r of gateL.rungs) log(`    ${r.rung}  scan ${r.e1_scan_arm_r_ms} -> ladder ${r.e1_ladder_ms}  (${(r.deviation * 100).toFixed(1)}%)`);
  log('');
  log(`  scoreable: ${scoreable}`);
}

main();
