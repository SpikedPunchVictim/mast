// A single cold build of vscode at the pinned commit, against the FTS delete guard.
//
// DESCRIPTIVE, NOT REGISTERED. No hypothesis, no threshold, no verdict. Every scaling
// claim in this program is measured at <= 73,359 chunks (E1's T9) and extrapolated one
// doubling to the 150k target in IMPLEMENTATION_PLAN.md § Stage 4.5. This run replaces
// that extrapolation with a measurement at the target, and nothing more.
//
// It is NOT a tenth rung on E1's ladder. The plan's own Design Reserve says so: vscode is
// a DIFFERENT CORPUS, so it "extends the panel, not the nested ladder". E1's exponent is
// fitted on nested subsets of one repo precisely so corpus content is held constant; a
// second repo cannot join that fit. No `b` is computed here.
//
// What it is good for: whether the projection holds, whether the whale-file batching fix
// (Stage 4.5 S1) survives real vscode input, and the first data on the `edges` phase past
// 73k chunks — the one component still above E1's 1.35 bar at a descriptive 1.3949.
//
// Run from `packages/mast`, never the repo root.
//
//   node eval/vscode-build.mjs

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { assertGate0, runColdIndex, writeResult } from './e1-common.mjs';

const PIN = '5ebbe53282bd1d5d3453405d9e6a34ee2eb7f42d';
const CORPUS = join(homedir(), '.cache', 'mast-eval', 'scale-corpus-full');
const STATE = join(homedir(), '.cache', 'mast-eval', 'vscode-guard-state');

// E1's T9, the top of the measured ladder — the point this run extrapolates from.
const T9 = { chunks: 73359, duration_ms: 62136, walk: 221, parse: 21432, write: 31892, edges: 8501 };

function assertCorpusPinned() {
  if (!existsSync(CORPUS)) throw new Error(`No corpus at ${CORPUS}.`);
  const head = execFileSync('git', ['-C', CORPUS, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  if (head !== PIN) {
    throw new Error(`Corpus is at ${head}, not the registered pin ${PIN}. Q1/SCALE's counts do not apply.`);
  }
  return head;
}

// `async` so that a synchronous gate failure still lands in the `.catch` below and sets a
// non-zero exit code, rather than escaping as an uncaught throw past it.
async function main() {
  // Gate 0 + Gate 0b. A stale `dist` is the one failure this program has actually hit, and
  // it is invisible in the output: the run simply measures a different binary.
  const gate0 = assertGate0();
  const head = assertCorpusPinned();
  console.log(`[VSCODE] corpus pinned at ${head}`);
  console.log(`[VSCODE] building (cold, phase timing on) — this takes minutes\n`);

  const run = runColdIndex({ projectRoot: CORPUS, stateDir: STATE });
  return Promise.resolve(run).then((r) => {
    // Projected from T9 by each phase's own descriptive slope, so the comparison is
    // per-phase rather than one aggregate number that can be right for wrong reasons.
    const ratio = r.chunk_count / T9.chunks;
    const proj = (base, b) => Math.round(base * Math.pow(ratio, b));
    const projected = {
      duration_ms: proj(T9.duration_ms, 1.0789),
      walk: proj(T9.walk, 0.6108),
      parse: proj(T9.parse, 0.9929),
      write: proj(T9.write, 1.1136),
      edges: proj(T9.edges, 1.3949),
    };

    const record = {
      created: new Date().toISOString(),
      what_this_is:
        'Single cold build of vscode@' + PIN + ' against the FTS delete guard. DESCRIPTIVE — ' +
        'no hypothesis, no threshold, no verdict. Replaces Stage 4.5\'s one-doubling ' +
        'extrapolation with a measurement at the 150k target.',
      not_a_ladder_rung:
        'vscode is a different corpus from n8n, so this extends the PANEL and cannot join ' +
        'E1\'s nested fit. No exponent is computed from it.',
      gate0, corpus_pin: head, corpus: CORPUS, state_dir: STATE,
      extrapolated_from_T9: T9,
      scale_ratio: ratio,
      projected, measured: r,
    };
    const out = writeResult('vscode-build.json', record);

    const row = (name, m, p) => {
      const err = p === 0 ? '—' : ((m - p) / p * 100).toFixed(1).padStart(6) + '%';
      console.log('  ' + name.padEnd(10) + String(Math.round(m)).padStart(9) +
        String(p).padStart(11) + '   ' + err);
    };
    console.log(`  files ${r.file_count}  chunks ${r.chunk_count}  symbols ${r.symbol_count}  ` +
      `edges ${r.edge_count}`);
    console.log(`  parse_errors ${r.parse_errors}  write_errors ${r.write_errors}`);
    console.log(`  db ${(r.db_bytes / 1048576).toFixed(1)} MiB   scale vs T9 ${ratio.toFixed(3)}x\n`);
    console.log('  phase       measured  projected     error');
    row('total', r.duration_ms, projected.duration_ms);
    for (const k of ['walk', 'parse', 'write', 'edges']) row(k, r.phase_ms[k], projected[k]);
    console.log(`\n  fts_del ${Math.round(r.write_spans.fts_del)} ms  (the guard: expected 0 on a cold build)`);
    console.log(`\nwrote ${out}`);
  });
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
