// E1-PHASE — anchor Gate P's attribution floor on a measurement, not on a smoke run.
//
// The design review (P8) refused the first draft's 90% floor: its only support was a
// one-file 22 ms run whose ~7 `Date.now()` stamps are quantization-dominated, so the
// observation could not distinguish 96% attribution from 80%. This runs the real T1 rung
// three times and commits the result, so the floor is set beneath something measured.
//
// Usage (run from packages/mast, never the repo root — HANDOFF §7):
//   node eval/e1-phase-attribution.mjs

import { join } from 'node:path';
import { E1_ROOT, assertGate0, runColdIndex, writeResult } from './e1-common.mjs';

const REPS = 3;

async function main() {
  const gate0 = assertGate0();
  const projectRoot = join(E1_ROOT, 'tiers', 'T1');
  const stateDir = join(E1_ROOT, 'phase-attrib-state');

  const runs = [];
  for (let i = 1; i <= REPS; i++) {
    const r = await runColdIndex({ projectRoot, stateDir });
    if (!r.phase_ms) {
      throw new Error(
        `Run ${i} produced no phase breakdown. The binary predates c71d59c, or ` +
        `ENABLE_MAST_PHASE_TIMING did not reach it.`
      );
    }
    const summed = Object.values(r.phase_ms).reduce((s, v) => s + v, 0);
    runs.push({
      rep: i,
      chunk_count: r.chunk_count,
      file_count: r.file_count,
      duration_ms: r.duration_ms,
      phase_ms: r.phase_ms,
      summed_ms: summed,
      remainder_ms: r.duration_ms - summed,
      attribution: summed / r.duration_ms,
      walk_share: r.phase_ms.walk / r.duration_ms,
    });
    const p = runs[runs.length - 1];
    console.log(
      `[attrib] rep ${i}: ${r.chunk_count} chunks, ${r.duration_ms} ms, ` +
      `attribution ${(p.attribution * 100).toFixed(2)}%, remainder ${p.remainder_ms} ms, ` +
      `walk ${(p.walk_share * 100).toFixed(2)}%`
    );
    console.log(`[attrib]   phases ${JSON.stringify(r.phase_ms)}`);
  }

  const worst = Math.min(...runs.map((r) => r.attribution));
  const worstWalk = Math.max(...runs.map((r) => r.walk_share));

  const out = writeResult('e1-phase-attribution.json', {
    created: new Date().toISOString(),
    gate0,
    tier: 'T1',
    reps: REPS,
    runs,
    worst_attribution: worst,
    worst_walk_share: worstWalk,
    why:
      'Gate P (attribution) and the walk-share void condition were registered against a ' +
      'one-file 22ms smoke run whose Date.now() quantization could not support either ' +
      'number (design review P8). These are the same measurements at the real T1 rung.',
  });

  console.log('');
  console.log(`[attrib] worst attribution : ${(worst * 100).toFixed(2)}%`);
  console.log(`[attrib] worst walk share  : ${(worstWalk * 100).toFixed(2)}%`);
  console.log(`\nwrote ${out}`);
}

main().catch((err) => {
  console.error(`\n[attrib] FAILED: ${err.message}`);
  process.exitCode = 1;
});
