// E1 — score the completed ladder and write the verdict artifact.
//
// Registration: IMPLEMENTATION_PLAN.md § E1/E2 PRE-REGISTRATION, "Exactly one
// decision-bearing test per experiment" and Gate 1b.
//
// This file holds NO verdict machinery. The verdict comes from `scoreE1`, which was
// committed at 4b49bc1 before any scored run existed and is pinned by 56 known-answer
// cases. What lives here is the seam between the journal and that scorer — run selection
// and descriptive reporting — kept separate precisely so that reading the data cannot
// reach the rules.
//
// Usage (run from packages/mast, never the repo root — HANDOFF §7):
//   node eval/e1-report.mjs

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS_DIR, writeResult } from './e1-common.mjs';
import { TIERS, PANEL, REPS } from './e1-schedule.mjs';
import { scoreE1 } from './e1-score.mjs';
import { olsFit } from './e1-stats.mjs';

/**
 * Select the decision-bearing and supporting run sets from a journal.
 *
 * The registration fixes the fit's membership — "the 27 tier runs" — so a journal that
 * cannot supply exactly that is a defect, not an input. A resumed schedule appends, and
 * `attempt_start` records outnumber runs whenever Gate 3 retakes, so neither "every
 * record" nor "the last 42" is a safe selector.
 *
 * Panel records carry `tier: null` (they are not rungs). They are given `tier = corpus`
 * here because `scoreE1` clusters the wild bootstrap on `.tier`, and the panel's registered
 * cluster is the corpus. This is a relabelling for the supporting fit only; it can never
 * mix a panel corpus into the ladder, which is selected on `kind` above it.
 */
export function selectRuns(records) {
  const runs = records.filter((r) => r.type === 'run');

  const seen = new Set();
  for (const r of runs) {
    const key = `${r.corpus}#${r.rep}`;
    if (seen.has(key)) {
      throw new Error(
        `selectRuns: duplicate run record for ${key}. A resumed journal appends, so a ` +
        `duplicate would enter the fit twice and silently over-weight that repetition.`
      );
    }
    seen.add(key);
  }

  const tierRuns = runs.filter((r) => r.kind === 'tier');
  const panelRuns = runs.filter((r) => r.kind === 'panel').map((r) => ({ ...r, tier: r.corpus }));

  const tierNames = new Set(tierRuns.map((r) => r.tier));
  if (tierNames.size !== TIERS.length) {
    throw new Error(
      `selectRuns: expected ${TIERS.length} tiers, got ${tierNames.size} ` +
      `(${[...tierNames].sort().join(', ')}). Gate 1b's Sxx and both σ ceilings are ` +
      `derived from the 9-rung geometry; a short ladder is a different experiment.`
    );
  }

  for (const [label, set, expected] of [['tier', tierRuns, TIERS], ['panel', panelRuns, PANEL]]) {
    for (const corpus of expected) {
      const n = set.filter((r) => r.tier === corpus).length;
      if (n !== REPS) {
        throw new Error(`selectRuns: ${label} corpus ${corpus} has ${n} repetitions, expected ${REPS}.`);
      }
    }
  }

  for (const r of tierRuns) {
    if (typeof r.tier !== 'string') {
      throw new Error(`selectRuns: tier run ${r.corpus}#${r.rep} has no tier label; it cannot be clustered.`);
    }
  }

  return { tierRuns, panelRuns };
}

/**
 * The realized residual sd, at both levels Gate 1b published a ceiling for.
 *
 * DESCRIPTIVE ONLY — no branch of the verdict table reads it. It answers whether HOLDS was
 * arithmetically reachable on this data, which is the question Gate 1b's ceilings were
 * committed to make answerable after the fact.
 *
 * The two levels are different quantities and the distinction is the whole point:
 *
 *  - **cluster** — the sd of the 9 tier MEANS about the fitted line. This is the honest
 *    number (A3-MAT-1): adding repetitions drives down pure error while leaving systematic
 *    tier-level departure untouched, so this is what governs whether the design can
 *    resolve `b` at all. Ceiling `σ_tier < 0.28188`.
 *  - **run** — the sd of all 27 runs about the line, which HC3 over 27 points implicitly
 *    quotes. Ceiling `σ < 0.56055`.
 *
 * Neither is the WITHIN-tier spread of a corpus's three repetitions. Repetition spread
 * inflates the run level and — where it is symmetric about the tier mean — leaves the
 * cluster level untouched entirely. Comparing rep spread against the cluster ceiling
 * reports breaches the design never claimed to bound.
 */
export function realizedSigma(runs, c) {
  const adjusted = runs.map((r) => r.duration_ms - c);
  if (adjusted.some((v) => v <= 0)) {
    throw new Error(`realizedSigma: calibration constant c=${c}ms exceeds a run duration; ln is undefined.`);
  }

  const x = runs.map((r) => Math.log(r.chunk_count));
  const y = adjusted.map(Math.log);
  const runFit = olsFit(x, y);

  const means = new Map();
  for (let i = 0; i < runs.length; i++) {
    const m = means.get(runs[i].tier) ?? { x: x[i], ys: [] };
    m.ys.push(y[i]);
    means.set(runs[i].tier, m);
  }
  const cx = [...means.values()].map((m) => m.x);
  const cy = [...means.values()].map((m) => m.ys.reduce((s, v) => s + v, 0) / m.ys.length);
  const clusterFit = olsFit(cx, cy);

  const sd = (fit) => Math.sqrt(fit.resid.reduce((s, r) => s + r * r, 0) / (fit.n - 2));
  const rawFit = olsFit(x, runs.map((r) => Math.log(r.duration_ms)));

  return {
    run: { sigma: sd(runFit), b: runFit.slope, n: runFit.n, df: runFit.n - 2 },
    cluster: { sigma: sd(clusterFit), b: clusterFit.slope, n: clusterFit.n, df: clusterFit.n - 2 },
    sigma_uncorrected_for_c: sd(rawFit),
  };
}

/** Within-tier repetition spread — reported, but against no ceiling. See `realizedSigma`. */
function repetitionSpread(runs) {
  const byTier = new Map();
  for (const r of runs) byTier.set(r.tier, [...(byTier.get(r.tier) ?? []), Math.log(r.duration_ms)]);
  return [...byTier.entries()]
    .map(([tier, ys]) => {
      const mean = ys.reduce((s, v) => s + v, 0) / ys.length;
      const sd = Math.sqrt(ys.reduce((s, v) => s + (v - mean) ** 2, 0) / (ys.length - 1));
      return { tier, sd_ln: sd, ratio: Math.exp(Math.max(...ys) - Math.min(...ys)) };
    })
    .sort((a, b) => b.sd_ln - a.sd_ln);
}

function readJson(name) {
  return JSON.parse(readFileSync(join(RESULTS_DIR, name), 'utf8'));
}

function main() {
  const records = readFileSync(join(RESULTS_DIR, 'e1-runs.jsonl'), 'utf8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const calibration = readJson('e1-calibration.json');
  const gate1b = readJson('e1-tiers.json').gate_1b;
  const summary = readJson('e1-runs-summary.json');

  const c = calibration.c_ms;
  if (!Number.isFinite(c)) throw new Error(`e1-report: e1-calibration.json has no finite c_ms (got ${c}).`);

  const { tierRuns, panelRuns } = selectRuns(records);

  const ladder = scoreE1(tierRuns, { c });
  // Supporting only, and never carries a verdict — content confounds scale across
  // unrelated repos, which is the whole reason the decision-bearing axis is nested.
  const panel = scoreE1(panelRuns, { c });

  const sigma = realizedSigma(tierRuns, c);
  const reachability = {
    cluster: {
      realized: sigma.cluster.sigma, ceiling: gate1b.sigma_ceiling_cluster,
      within_ceiling: sigma.cluster.sigma < gate1b.sigma_ceiling_cluster,
    },
    run: {
      realized: sigma.run.sigma, ceiling: gate1b.sigma_ceiling_run,
      within_ceiling: sigma.run.sigma < gate1b.sigma_ceiling_run,
    },
    note:
      'Ceilings were derived at the projected b = 1.12 and are DESCRIPTIVE — no verdict ' +
      'branch reads them. They answer whether HOLDS was arithmetically reachable.',
  };

  const record = {
    created: new Date().toISOString(),
    calibration_c_ms: c,
    driver_findings: summary.findings,
    ladder,
    panel_supporting_only: panel,
    reachability,
    repetition_spread_descriptive: repetitionSpread(tierRuns),
  };

  const out = writeResult('e1-verdict.json', record);

  const ci = (f) => `[${f.ci_hc3[0].toFixed(4)}, ${f.ci_hc3[1].toFixed(4)}]`;
  const boot = (f) => `[${f.ci_boot[0].toFixed(4)}, ${f.ci_boot[1].toFixed(4)}]`;
  console.log(`[E1] c = ${c} ms   n = ${ladder.n_runs} runs over ${ladder.n_tiers} tiers`);
  console.log(`[E1] adjusted  b = ${ladder.adjusted.b.toFixed(4)}  HC3 ${ci(ladder.adjusted)}  boot ${boot(ladder.adjusted)}`);
  console.log(`[E1] raw       b = ${ladder.raw.b.toFixed(4)}  HC3 ${ci(ladder.raw)}  boot ${boot(ladder.raw)}`);
  console.log(`[E1] classes   ${JSON.stringify(ladder.classes)}`);
  console.log(`[E1] b_file    ${ladder.b_file?.toFixed(4)}`);
  console.log(`[E1] lack-of-fit  fires=${ladder.lack_of_fit.fires}  ${JSON.stringify(ladder.lack_of_fit)}`);
  console.log(`[E1] triggers  ${JSON.stringify(ladder.triggers)}`);
  console.log(`[E1] sigma     cluster ${sigma.cluster.sigma.toFixed(4)} (ceiling ${gate1b.sigma_ceiling_cluster.toFixed(4)})  ` +
    `run ${sigma.run.sigma.toFixed(4)} (ceiling ${gate1b.sigma_ceiling_run.toFixed(4)})`);
  console.log(`[E1] panel     b = ${panel.adjusted.b.toFixed(4)}  HC3 ${ci(panel.adjusted)}  (supporting only)`);
  console.log('');
  console.log(`[E1] VERDICT   ${ladder.verdict}`);
  console.log(`[E1] reasons   ${ladder.reasons.join(', ')}`);
  if (ladder.qualifiers?.length) console.log(`[E1] qualifiers ${ladder.qualifiers.join(', ')}`);
  console.log(`\nwrote ${out}`);
}

if (process.argv[1] && process.argv[1].endsWith('e1-report.mjs')) main();
