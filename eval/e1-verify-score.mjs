// E1-VERIFY — score the re-run ladder with E1's OWN committed scorer.
//
// Required by IMPLEMENTATION_PLAN.md § E1-FTS RESULT: the FTS delete guard is
// accepted only against "the committed scorer and the immutable 1.35
// threshold". So this file computes nothing. It maps the verify journal onto
// the shape `scoreE1` expects and calls it — the fit, the HC3 interval, the
// cluster bootstrap, the lack-of-fit test, the five triggers and the verdict
// rule all come from `e1-score.mjs` untouched.
//
// Writing a new scorer here, however faithful, would be marking my own homework
// with a ruler I had just made.
//
// Run from `packages/mast`, never the repo root.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS_DIR, writeResult } from './e1-common.mjs';
import { scoreE1, THRESHOLD } from './e1-score.mjs';
import { TIERS, REPS } from './e1-schedule.mjs';

const JOURNAL = join(RESULTS_DIR, 'e1-verify-runs.jsonl');
const CALIBRATION = join(RESULTS_DIR, 'e1-verify-calibration.json');

function main() {
  if (!existsSync(JOURNAL)) throw new Error(`No journal at ${JOURNAL} — run eval/e1-verify-run.mjs first.`);
  const records = readFileSync(JOURNAL, 'utf-8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

  const done = new Map();
  const voids = new Map();
  for (const r of records) {
    const k = `${r.corpus}#r${r.rep}`;
    if (r.type === 'run') { done.set(k, r); voids.delete(k); }
    else if (r.type === 'void') { voids.set(k, r); done.delete(k); }
  }

  const expected = TIERS.length * REPS;
  if (done.size !== expected || voids.size > 0) {
    throw new Error(
      `E1-VERIFY is not scoreable: ${done.size}/${expected} runs, ${voids.size} unresolved void. ` +
      `E1's scorer refuses an incomplete ladder (trigger 2) and so does this.`);
  }

  // `scoreE1` keys clusters on `tier`; the verify journal calls it `corpus`.
  // Renamed here rather than in the journal, so the raw record keeps the
  // driver's own vocabulary and the mapping stays visible at the seam.
  const runs = [...done.values()].map((r) => ({ ...r, tier: r.corpus }));

  const calibration = JSON.parse(readFileSync(CALIBRATION, 'utf-8'));
  const scored = scoreE1(runs, { c: calibration.c_ms });

  const record = {
    created: new Date().toISOString(),
    what_this_is:
      'E1\'s 9-rung ladder re-run against the FTS delete guard (graph/populate.ts) and scored ' +
      'by E1\'s own committed scorer at the immutable ' + THRESHOLD + ' threshold. Required by ' +
      'IMPLEMENTATION_PLAN.md § E1-FTS RESULT before the guard is accepted.',
    scope:
      'LADDER ONLY. E1\'s 5-corpus PANEL is out of scope — the registration names the ladder, ' +
      'and E1 records the panel as panel_supporting_only. No claim is made about it.',
    not_comparable:
      'Absolute timings are NOT comparable to E1\'s original ladder: different binary, and c is ' +
      're-measured here for that reason. The EXPONENT is what is compared.',
    calibration_c_ms: calibration.c_ms,
    runs: runs.length,
    ...scored,
  };
  const out = writeResult('e1-verify-verdict.json', record);

  const f = (x, d = 4) => (typeof x === 'number' ? x.toFixed(d) : String(x));
  console.log('');
  console.log(`  runs            ${runs.length}  (9 rungs x ${REPS} reps, ladder only)`);
  console.log(`  calibration c   ${calibration.c_ms} ms`);
  console.log('');
  for (const which of ['adjusted', 'raw']) {
    const fit = scored[which];
    if (fit === undefined) continue;
    console.log(`  ${which.padEnd(9)} b = ${f(fit.b)}   hc3 [${f(fit.ci_hc3?.[0], 3)}, ${f(fit.ci_hc3?.[1], 3)}]` +
      `   boot [${f(fit.ci_boot?.[0], 3)}, ${f(fit.ci_boot?.[1], 3)}]`);
  }
  console.log('');
  console.log(`  threshold       ${THRESHOLD}  (E1's immutable bar, unchanged)`);
  console.log(`[E1-VERIFY] VERDICT  ${scored.verdict}`);
  for (const r of scored.reasons ?? []) console.log(`[E1-VERIFY] reason: ${r}`);
  // `scoreE1` returns triggers as an OBJECT keyed t3/t4/t5, not an array — trigger 1
  // (lack of fit) and trigger 2 (unadjudicated voids) are surfaced separately, the
  // latter by throwing before the fit is ever computed.
  for (const [id, t] of Object.entries(scored.triggers ?? {})) {
    console.log(`[E1-VERIFY] ${id} ${t.fires ? 'FIRES' : 'quiet'}`);
  }
  const lof = scored.lack_of_fit;
  console.log(`[E1-VERIFY] lack-of-fit ${lof?.fires ? 'FIRES' : 'quiet'}  ` +
    `F=${f(lof?.F, 3)} p=${f(lof?.p, 3)} departure=${f(lof?.departurePct, 2)}%`);
  for (const q of scored.qualifiers ?? []) console.log(`[E1-VERIFY] qualifier: ${q}`);
  console.log(`\nwrote ${out}`);
}

main();
