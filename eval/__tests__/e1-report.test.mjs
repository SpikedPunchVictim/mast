// Gate 7, extended to the reporting seam.
//
// `scoreE1` is pinned by e1-score.test.mjs, but it can only score what it is handed. The
// two things standing between the journal and the scorer are (a) selecting exactly the 27
// tier runs the registration names as decision-bearing, and (b) the realized-sigma
// arithmetic reported against Gate 1b's committed ceilings. Both are new logic, and both
// are the kind that fails silently: a fit over 26 runs, or a sigma computed at the wrong
// level, produces a number that looks like a measurement.
//
// Case (7) exists because the investigator got this wrong in prose before writing it in
// code — comparing WITHIN-tier repetition spread against a BETWEEN-tier residual ceiling
// and reporting three corpora as breaching it. They are different quantities.

import { describe, it, expect } from 'vitest';
import { selectRuns, realizedSigma } from '../e1-report.mjs';

const CHUNKS = [3679, 5332, 7761, 11278, 16529, 23854, 34691, 50299, 73359];

/** A journal-shaped run record. */
function rec(corpus, rep, kind, chunks, durationMs) {
  return {
    type: 'run', corpus, rep, kind,
    tier: kind === 'tier' ? corpus : null,
    chunk_count: chunks, duration_ms: durationMs,
    file_count: Math.round(chunks / 5.6), db_bytes: chunks * 900, parse_errors: 0,
  };
}

/** 27 tier runs from an exact power law, plus optional per-rep perturbation in ln space. */
function ladder({ a = 1, b = 1, c = 0, perturb = () => 0 } = {}) {
  const out = [];
  CHUNKS.forEach((n, i) => {
    for (let rep = 1; rep <= 3; rep++) {
      const ln = Math.log(a) + b * Math.log(n) + perturb(i, rep);
      out.push(rec(`T${i + 1}`, rep, 'tier', n, Math.exp(ln) + c));
    }
  });
  return out;
}

function panel() {
  const out = [];
  ['P1', 'P2', 'P3', 'P4', 'nest'].forEach((corpus, i) => {
    for (let rep = 1; rep <= 3; rep++) out.push(rec(corpus, rep, 'panel', 5000 * (i + 1), 4000 * (i + 1)));
  });
  return out;
}

describe('selectRuns', () => {
  it('returns the 27 tier runs and the 15 panel runs', () => {
    const { tierRuns, panelRuns } = selectRuns([...ladder(), ...panel()]);

    expect(tierRuns).toHaveLength(27);
    expect(panelRuns).toHaveLength(15);
  });

  it('ignores attempt_start records, which outnumber runs on a retaken schedule', () => {
    const noise = [{ type: 'attempt_start', corpus: 'T2', rep: 1, attempt: 2 }];

    const { tierRuns } = selectRuns([...noise, ...ladder(), ...panel(), ...noise]);

    expect(tierRuns).toHaveLength(27);
  });

  it('clusters panel runs on their corpus, since panel records carry a null tier', () => {
    const { panelRuns } = selectRuns([...ladder(), ...panel()]);

    expect(new Set(panelRuns.map((r) => r.tier))).toEqual(new Set(['P1', 'P2', 'P3', 'P4', 'nest']));
  });

  it('throws on a duplicate (corpus, rep), which a resumed journal can append', () => {
    const runs = ladder();

    expect(() => selectRuns([...runs, runs[0]])).toThrow(/duplicate/i);
  });

  it('throws when a corpus does not have exactly 3 repetitions', () => {
    const runs = ladder().filter((r) => !(r.corpus === 'T4' && r.rep === 2));

    expect(() => selectRuns([...runs, ...panel()])).toThrow(/T4/);
  });

  it('throws when the tier count is not the registered 9', () => {
    const runs = ladder().filter((r) => r.corpus !== 'T9');

    expect(() => selectRuns([...runs, ...panel()])).toThrow(/9 tiers/);
  });
});

describe('realizedSigma', () => {
  it('reports ~zero residual sd at both levels for an exact power law', () => {
    const s = realizedSigma(ladder({ b: 1.12 }), 0);

    expect(s.run.sigma).toBeCloseTo(0, 10);
    expect(s.cluster.sigma).toBeCloseTo(0, 10);
  });

  it('separates within-tier spread from between-tier departure', () => {
    // Reps scattered symmetrically about each tier's mean: the tier MEANS still sit on the
    // line, so the cluster-level sigma — the one Gate 1b's honest ceiling governs — is ~0
    // while the run-level sigma is large. Comparing rep spread against the cluster ceiling
    // conflates these and reports a breach that the design never claimed to bound.
    const spread = (i, rep) => [-0.4, 0, 0.4][rep - 1];

    const s = realizedSigma(ladder({ b: 1.12, perturb: spread }), 0);

    expect(s.cluster.sigma).toBeCloseTo(0, 10);
    expect(s.run.sigma).toBeGreaterThan(0.3);
  });

  it('subtracts the calibration constant before taking logs', () => {
    const withC = realizedSigma(ladder({ b: 1.12, c: 500 }), 500);

    expect(withC.sigma_uncorrected_for_c).not.toBeCloseTo(withC.run.sigma, 6);
    expect(withC.run.sigma).toBeCloseTo(0, 10);
  });

  it('throws when c exceeds a run duration, rather than taking the log of a negative', () => {
    expect(() => realizedSigma(ladder({ b: 1 }), 1e12)).toThrow(/calibration/i);
  });

  it('reports the slope alongside the sd, so the ceiling is read at the realized b', () => {
    const s = realizedSigma(ladder({ b: 1.12 }), 0);

    expect(s.cluster.b).toBeCloseTo(1.12, 8);
  });
});
