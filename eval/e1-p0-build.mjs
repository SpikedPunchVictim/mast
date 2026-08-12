// E1 — run P0: the prerequisite full-n8n index build.
//
// Registration: IMPLEMENTATION_PLAN.md § E1/E2 PRE-REGISTRATION, AMENDMENT 3 FATAL-3.
//
// P0 exists because the tier cut needs per-file chunk counts, which only a completed
// `graph.db` has. AMENDMENT 3 promoted it from an unstated prerequisite to a registered
// run:
//
//   - it runs under Gate 0 (binary identity) and Gate 1 (corpus integrity) in full;
//   - it is EXCLUDED from every fit and from both scored run counts — it is construction,
//     not measurement;
//   - the peek is DECLARED. P0 yields a T9-scale `durationMs` seen before the ladder is
//     frozen. The mitigation is ordering and it is already discharged: AMENDMENT 3 —
//     rung fractions, seed 811, the 1.35 threshold, the estimator, every trigger and
//     every gate — was committed at b357071, BEFORE this script runs. With the verdict
//     machinery immutable, one duration cannot tune anything.
//
// Usage (run from packages/mast, never the repo root — HANDOFF §7):
//   node eval/e1-p0-build.mjs [--state-dir <dir>]

import { join } from 'node:path';
import {
  E1_ROOT, PINS, assertGate0, assertCorpusPinned, runColdIndex, writeResult,
} from './e1-common.mjs';

function parseArgs(argv) {
  const opts = { stateDir: join(E1_ROOT, 'p0-n8n-state') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--state-dir') opts.stateDir = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write('Usage: node eval/e1-p0-build.mjs [--state-dir <dir>]\n');
    return;
  }

  console.log('[P0] GATE 0 — binary identity');
  const gate0 = assertGate0();
  console.log(`     schema_version : ${gate0.schema_version}`);
  console.log(`     dist newest    : ${gate0.dist_newest_mtime}`);
  console.log(`     dist hash      : ${gate0.dist_hash.slice(0, 16)}...`);
  console.log(`     bin            : ${gate0.bin}`);

  console.log('[P0] GATE 1 — corpus integrity');
  const worktree = assertCorpusPinned('n8n');
  console.log(`     worktree       : ${worktree}`);
  console.log(`     pin            : ${PINS.n8n.sha}`);

  console.log('[P0] indexing full n8n from cold (this is the peek — declared, not hidden)');
  const run = await runColdIndex({ projectRoot: worktree, stateDir: opts.stateDir });

  // Gate 1's write_errors clause. S1 batched the inserts under SQLite's parameter
  // ceiling, so a non-zero count here is a regression, not an expected whale-file loss.
  if (run.write_errors > 0) {
    throw new Error(
      `GATE 1 FAILED: write_errors = ${run.write_errors}. Chunks are silently absent from ` +
      `this index; the tier cut would inherit the gap. Diagnose before proceeding.`
    );
  }

  const record = {
    run: 'P0',
    role: 'prerequisite build for the tier cut — EXCLUDED from every fit and run count',
    created: new Date().toISOString(),
    gate0,
    corpus: { name: 'n8n', ...PINS.n8n, worktree },
    peek_declared: {
      what: 'a T9-scale durationMs, observed before the tier manifest was frozen',
      mitigation:
        'AMENDMENT 3 (rung fractions, seed 811, threshold 1.35, estimator, triggers, gates) ' +
        'was committed at b357071 before this run. The verdict machinery was immutable at ' +
        'the moment of the peek.',
      value_ms: run.duration_ms,
    },
    measurement: run,
  };

  const out = writeResult('e1-p0.json', record);

  console.log('');
  console.log(`[P0] files        : ${run.file_count}`);
  console.log(`[P0] chunks       : ${run.chunk_count}   <- C_total for the rung fractions`);
  console.log(`[P0] symbols      : ${run.symbol_count}`);
  console.log(`[P0] edges        : ${run.edge_count} (POTENTIAL_CALL ${run.potential_call_count})`);
  console.log(`[P0] parse_errors : ${run.parse_errors}`);
  console.log(`[P0] write_errors : ${run.write_errors}`);
  console.log(`[P0] duration      : ${run.duration_ms} ms (fitted clock)  external ${run.external_ms} ms`);
  console.log(`[P0] graph.db      : ${(run.db_bytes / 1e6).toFixed(1)} MB`);
  console.log(`\nwrote ${out}`);
}

main().catch((err) => {
  console.error(`\n[P0] FAILED: ${err.message}`);
  process.exitCode = 1;
});
