// E1-AB — the journal seam: fold the journal, select the scored runs, print.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-AB PRE-REGISTRATION (2026-08-13),
// as amended by AMENDMENT 1.
//
// This file holds NO decision machinery. Every threshold lives in
// `e1-ab-score.mjs` and was committed before any run existed. What lives here is
// the seam between the journal and that scorer, kept separate for the reason
// E1's R5 finding made concrete: a reporting seam written after the data exists
// has discretion, and the only defence is that it cannot reach the rules.
//
// `foldJournal` lives HERE rather than inside the driver on purpose. E1-PHASE's
// equivalent was a private function in `e1-phase-run.mjs`, which is exactly why
// its VOID-queue defect (RR6) survived review unexercised: nothing could test
// it. It is exported and tested here.
//
// Usage (run from packages/mast, never the repo root):
//   node eval/e1-ab-report.mjs

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS_DIR, writeResult } from './e1-common.mjs';
import { AB_ARMS, AB_BLOCKS, AB_TOTAL_RUNS } from './e1-ab-schedule.mjs';
import { scoreAb } from './e1-ab-score.mjs';

/** A cell's identity: arm x rung x block. */
export const abKey = (r) => `${r.arm}#${r.tier}#b${r.block}`;

/** A block-pair's identity — what a control run is shared across. */
export const pairKey = (r) => `${r.tier}#b${r.block}`;

/**
 * Fold an append-only journal into current state.
 *
 * Two behaviours the E1-PHASE driver got wrong or never needed:
 *
 * 1. **The VOID queue dequeues** (RR6). A cell that VOIDed and was later re-run
 *    clean has its void RESOLVED rather than left in the map forever. E1-PHASE's
 *    version left it, which pinned `scoreable` false permanently once anything
 *    had ever voided — unexercised there because nothing voided, and Gate A
 *    makes a void genuinely plausible here.
 * 2. **Later records win** for a given cell. That is not laxity: AMENDMENT 1 A6
 *    requires a VOIDed cell to be re-run TOGETHER WITH a fresh control run of
 *    the same rung, because the primary estimator is a within-block ratio and a
 *    control measured hours earlier no longer cancels drift. The re-paired
 *    control is a second `run` record for a key that already has one, and it is
 *    meant to supersede it.
 */
export function foldJournal(records) {
  const done = new Map();
  const voids = new Map();
  const resolvedVoids = [];
  const superseded = [];

  for (const rec of records) {
    if (rec.type === 'run') {
      const k = abKey(rec);
      if (done.has(k)) superseded.push({ key: k, at: rec.at });
      done.set(k, rec);
      const v = voids.get(k);
      if (v !== undefined) {
        voids.delete(k);
        resolvedVoids.push({ key: k, void_reason: v.reason, resolved_at: rec.at });
      }
    } else if (rec.type === 'void') {
      voids.set(abKey(rec), rec);
      done.delete(abKey(rec));
    }
  }
  return { done, voids, resolved_voids: resolvedVoids, superseded };
}

/**
 * The runs that enter the score.
 *
 * An UNRESOLVED void on a **control** run poisons its whole `(tier, block)`
 * pair-set: every other arm in that block would otherwise be divided by a
 * control from a different point in time, which is precisely the drift the
 * within-block estimator exists to cancel. Those runs are excluded here rather
 * than silently divided, and `armRatio` then reports the block as dropped.
 */
export function selectAbRuns(records) {
  const { done, voids, resolved_voids, superseded } = foldJournal(records);

  const poisoned = new Set();
  for (const v of voids.values()) if (v.arm === 'A') poisoned.add(pairKey(v));

  const runs = [...done.values()].filter((r) => !poisoned.has(pairKey(r)));
  return {
    runs, voids, resolved_voids, superseded,
    poisoned_pairs: [...poisoned],
    complete: done.size === AB_TOTAL_RUNS,
    // The registered blockers: an unresolved VOID, or a missing cell. A Gate 3
    // finding is logged and retained (A4-MAT-6) and is NOT a blocker.
    scoreable: done.size === AB_TOTAL_RUNS && voids.size === 0,
  };
}

/**
 * What still has to run — including AMENDMENT 1 A6's re-pairing.
 *
 * A cell that VOIDed is obviously pending. The subtlety is the OTHER half: the
 * primary estimator is a within-block ratio, so a cell re-run hours after its
 * block no longer cancels drift against the control that block already has. A6
 * therefore requires the control of that `(tier, block)` to be re-run *with* it.
 *
 * **This re-runs the whole `(tier, block)` group, which is stricter than A6's
 * literal text, and the reason is a gap A6 left.** A6 says the repaired pair
 * "replaces the block's ratio" — but the control is SHARED by every arm in that
 * block, so superseding it silently re-pairs the untouched arms against a
 * control measured at a different time, reintroducing for them exactly the drift
 * the repair was meant to remove. Re-running the group keeps every ratio in the
 * block a temporally adjacent pair, which is the property A6 was protecting. It
 * costs one extra T9 run per repair (~9 minutes) and is recorded as AMENDMENT 2.
 *
 * The control is emitted FIRST so the pair is measured in the order and
 * adjacency the estimator assumes.
 *
 * Lives here, not in the driver, for RR6's reason: driver-private logic is what
 * nothing can test.
 */
export function planPending(schedule, { done, voids }) {
  const repairPairs = new Set();
  for (const v of voids.values()) repairPairs.add(pairKey(v));

  const groups = new Map();
  for (const cell of schedule) {
    const missing = !done.has(abKey(cell));
    const repair = repairPairs.has(pairKey(cell));
    if (!missing && !repair) continue;
    const k = pairKey(cell);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ ...cell, reason: missing ? 'not_run' : 'repair_pair' });
  }

  const out = [];
  for (const cells of groups.values()) {
    out.push(...cells.filter((c) => c.arm === 'A'), ...cells.filter((c) => c.arm !== 'A'));
  }
  return out;
}

/** Gate P2, strengthened: EVERY run at a rung must agree, across arms and blocks. */
export function gateP2(runs) {
  const byTier = new Map();
  for (const r of runs) {
    if (!byTier.has(r.tier)) byTier.set(r.tier, []);
    byTier.get(r.tier).push(r);
  }
  const rows = [];
  for (const [tier, rs] of byTier) {
    const counts = [...new Set(rs.map((r) => r.chunk_count))];
    const expected = AB_ARMS.filter((a) => a.rungs.includes(tier)).length * AB_BLOCKS;
    rows.push({
      tier, runs: rs.length, expected, chunk_counts: counts, identical: counts.length === 1,
    });
  }
  return rows;
}

function main() {
  const records = readFileSync(join(RESULTS_DIR, 'e1-ab-runs.jsonl'), 'utf8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const summary = JSON.parse(readFileSync(join(RESULTS_DIR, 'e1-ab-runs-summary.json'), 'utf8'));

  const sel = selectAbRuns(records);
  const p2 = gateP2(sel.runs);
  const scored = scoreAb(sel.runs.map((r) => ({ ...r, scoreable: sel.scoreable })));

  const record = {
    created: new Date().toISOString(),
    is_a_probe:
      'E1-AB is a probe, not a remedy and not a verdict experiment. It cannot confirm, ' +
      "overturn or soften E1's SUPER-LINEAR verdict, and it cannot re-adjudicate E1-PHASE: " +
      'H1 (write-localised, mechanism unidentified) stands whatever this returns. No pragma ' +
      'is shipped on the strength of it.',
    complete: sel.complete,
    unresolved_voids: [...sel.voids.keys()],
    resolved_voids: sel.resolved_voids,
    superseded_controls: sel.superseded,
    poisoned_pairs: sel.poisoned_pairs,
    gate_p2: p2,
    driver_findings: summary.findings,
    ...scored,
  };
  const out = writeResult('e1-ab-verdict.json', record);

  const f = (x, d = 4) => (typeof x === 'number' ? x.toFixed(d) : String(x));
  console.log('');
  console.log('  arm  rung   rho (write_ms)   blocks');
  for (const tier of ['T1', 'T5', 'T9']) {
    for (const arm of ['B', 'D']) {
      const r = scored.level[tier][arm];
      console.log(`  ${arm}    ${tier.padEnd(6)} ${r.void ? 'VOID'.padEnd(15) : f(r.median).padEnd(15)} ` +
        `${r.ratios.map((x) => f(x, 3)).join(' ')}`);
    }
  }
  console.log('');
  console.log('  arm  b_write (median of block slopes)   spread');
  for (const arm of ['A', 'B', 'D']) {
    const s = scored.slopes[arm];
    console.log(`  ${arm}    ${s.void ? 'VOID'.padEnd(33) : f(s.median).padEnd(33)} ${f(s.spread, 4)}`);
  }
  console.log('');
  console.log(`[E1-AB] rho_B(T9) = ${f(scored.rho_B_T9)}   level ${scored.mechanism.level}`);
  console.log(`[E1-AB] rho_D(T1) = ${f(scored.rho_D_T1)}   (connectivity read at T1, AMENDMENT 1 A4)`);
  console.log(`[E1-AB] MECHANISM  ${scored.mechanism.cell}`);
  console.log(`[E1-AB] EXPONENT   ${scored.exponent}`);
  console.log(`[E1-AB] mmap(T5)   rho_C = ${scored.mmap.ratio.void ? 'VOID' : f(scored.mmap.ratio.median)} — ${scored.mmap.reading.split(':')[0]}`);
  if (scored.gate_a_caveat_attached) console.log(`[E1-AB] CAVEAT     ${scored.gate_a_caveat}`);
  for (const finding of scored.mechanism.findings) console.log(`[E1-AB] FINDING: ${finding}`);
  console.log(`[E1-AB] scoreable: ${scored.scoreable}`);
  console.log(`\nwrote ${out}`);
}

if (process.argv[1] && process.argv[1].endsWith('e1-ab-report.mjs')) main();
