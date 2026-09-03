// E1 — freeze the 9-rung tier manifest, then discharge Gate 1b.
//
// Registration: IMPLEMENTATION_PLAN.md § E1/E2 PRE-REGISTRATION, AMENDMENT 3 FATAL-2.
//
// Rungs are geometric fractions of the REALIZED total chunk count from run P0:
// f_i = 20^(-(9-i)/8), i = 1..9 — a 20x span, exactly even in ln N, which is the scale the
// fit is performed on. The first draft stated targets in files and cut them in chunks; the
// units are now the same on both sides, and they are the unit the exposure variable uses.
//
// Gate 1b (same amendment) re-derives the whole power analysis from the manifest's realized
// counts rather than trusting the projected figures, because AMENDMENT 1 published a power
// analysis computed on an anchor it had itself disavowed. Arithmetic that is never
// re-derived against reality is decoration.
//
// Usage (run from packages/mast):
//   node eval/e1-build-tiers.mjs [--p0 eval/results/e1-p0.json]

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SEED, RUNGS, SPAN, rungFractions, seededShuffle, readPerFileChunkCounts, writeResult,
} from './e1-common.mjs';
import { studentTQuantile } from './e1-stats.mjs';

/** Projected cluster-level Sxx for a perfectly-spaced ladder; Gate 1b's tolerance anchor. */
const PROJECTED_SXX_CLUSTER = 8.414;
const SXX_TOLERANCE = 0.20;
/** The threshold, registered at fd46152 and unchanged through three amendments. */
const THRESHOLD = 1.35;
/** Expected exponent under the N log N model, used only for the reachability arithmetic. */
const EXPECTED_B = 1.12;

function parseArgs(argv) {
  const opts = { p0: 'eval/results/e1-p0.json' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--p0') opts.p0 = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write('Usage: node eval/e1-build-tiers.mjs [--p0 <path>]\n');
    return;
  }

  const p0 = JSON.parse(readFileSync(resolve(opts.p0), 'utf-8'));
  const stateDir = p0.measurement.state_dir;
  const rows = readPerFileChunkCounts(stateDir);

  const cTotal = rows.reduce((s, r) => s + r.chunk_count, 0);
  if (cTotal !== p0.measurement.chunk_count) {
    throw new Error(
      `Chunk sum over files (${cTotal}) != P0's chunks table total ` +
      `(${p0.measurement.chunk_count}). The cut's population disagrees with the corpus.`
    );
  }
  console.log(`[tiers] C_total (realized)      : ${cTotal} chunks`);
  console.log(`[tiers] chunk-bearing files     : ${rows.length} (P0 indexed ${p0.measurement.file_count})`);

  // --- seeded shuffle, then prefix cuts on cumulative chunks ---
  const shuffled = seededShuffle(rows, SEED);
  const prefix = [];
  let running = 0;
  for (const r of shuffled) { running += r.chunk_count; prefix.push(running); }
  if (running !== cTotal) throw new Error(`Prefix sum ${running} != C_total ${cTotal}`);

  const fractions = rungFractions();
  const nearestCut = (target) => {
    let best = 0, bestDiff = Infinity;
    for (let i = 0; i < prefix.length; i++) {
      const d = Math.abs(prefix[i] - target);
      if (d < bestDiff) { bestDiff = d; best = i; }
    }
    return best;
  };

  const tiers = {};
  const cuts = [];
  for (let i = 0; i < RUNGS; i++) {
    const name = `T${i + 1}`;
    const target = fractions[i] * cTotal;
    // T9 is the whole corpus by definition, not by nearest-cut search.
    const cut = i === RUNGS - 1 ? shuffled.length - 1 : nearestCut(target);
    cuts.push(cut);
    tiers[name] = {
      target_fraction: fractions[i],
      target_chunks: Math.round(target),
      file_count: cut + 1,
      chunk_count: prefix[cut],
      files: shuffled.slice(0, cut + 1).map((r) => r.file_path),
    };
  }

  // Nesting is automatic from prefixes of one shuffle; assert it anyway, because "automatic"
  // is what every silently-broken invariant was called before it broke.
  for (let i = 1; i < RUNGS; i++) {
    if (cuts[i] < cuts[i - 1]) throw new Error(`Cut indices not monotone at T${i + 1}`);
    const bigger = new Set(tiers[`T${i + 1}`].files);
    const missing = tiers[`T${i}`].files.filter((f) => !bigger.has(f));
    if (missing.length > 0) throw new Error(`T${i} is not a subset of T${i + 1} (${missing.length} files missing)`);
  }

  console.log('');
  for (let i = 0; i < RUNGS; i++) {
    const t = tiers[`T${i + 1}`];
    const err = ((t.chunk_count / t.target_chunks - 1) * 100).toFixed(2);
    console.log(
      `[tiers] T${i + 1}: files=${String(t.file_count).padStart(6)} chunks=${String(t.chunk_count).padStart(6)}` +
      `  target=${String(t.target_chunks).padStart(6)} (${err.padStart(6)}%)`
    );
  }

  // ---------------- GATE 1b: re-derive the power analysis from realized counts -----------
  const chunkCounts = Object.values(tiers).map((t) => t.chunk_count);
  const lnN = chunkCounts.map(Math.log);
  const xbar = lnN.reduce((s, v) => s + v, 0) / RUNGS;
  const sxxCluster = lnN.reduce((s, v) => s + (v - xbar) ** 2, 0);
  const sxxRun = 3 * sxxCluster;

  const realizedSpan = chunkCounts[RUNGS - 1] / chunkCounts[0];
  const nMax = chunkCounts[RUNGS - 1], nMin = chunkCounts[0];
  const bEff = 1 + Math.log(Math.log(nMax) / Math.log(nMin)) / Math.log(realizedSpan);

  const tCluster = studentTQuantile(0.975, RUNGS - 2);      // df = 7
  const tRun = studentTQuantile(0.975, RUNGS * 3 - 2);      // df = 25
  const margin = THRESHOLD - EXPECTED_B;
  const sigmaCeilingCluster = (margin * Math.sqrt(sxxCluster)) / tCluster;
  const sigmaCeilingRun = (margin * Math.sqrt(sxxRun)) / tRun;

  const sxxShortfall = 1 - sxxCluster / PROJECTED_SXX_CLUSTER;
  const geometryOk = sxxShortfall <= SXX_TOLERANCE;

  console.log('');
  console.log('[GATE 1b] re-derived from realized chunk counts');
  console.log(`  realized span          : ${realizedSpan.toFixed(3)}x  (registered target ${SPAN}x)`);
  console.log(`  Sxx (cluster, 9 rungs) : ${sxxCluster.toFixed(3)}  (projected ${PROJECTED_SXX_CLUSTER}, shortfall ${(sxxShortfall * 100).toFixed(1)}%)`);
  console.log(`  Sxx (run, 27 runs)     : ${sxxRun.toFixed(2)}`);
  console.log(`  SE(b) cluster          : sigma_tier / ${Math.sqrt(sxxCluster).toFixed(4)}`);
  console.log(`  SE(b) run              : sigma / ${Math.sqrt(sxxRun).toFixed(4)}`);
  console.log(`  sigma_tier ceiling     : < ${sigmaCeilingCluster.toFixed(3)}   <- the HONEST one`);
  console.log(`  sigma ceiling (HC3)    : < ${sigmaCeilingRun.toFixed(3)}`);
  console.log(`  N log N effective b    : ${bEff.toFixed(4)}  (registered ~1.10)`);
  console.log(`  geometry gate          : ${geometryOk ? 'PASS' : 'FAIL'} (tolerance ${SXX_TOLERANCE * 100}% shortfall)`);

  const manifest = {
    created: new Date().toISOString(),
    seed: SEED,
    rungs: RUNGS,
    span_target: SPAN,
    threshold: THRESHOLD,
    source: { run: 'P0', corpus: 'n8n', sha: p0.corpus.sha, state_dir: stateDir },
    population: {
      c_total: cTotal,
      chunk_bearing_files: rows.length,
      p0_file_count: p0.measurement.file_count,
    },
    cut_rule:
      'seeded shuffle (seed 811) of chunk-bearing files; prefix minimising ' +
      '|cumulative_chunks - f_i * C_total|; T9 = all files by definition',
    logged_deviation: {
      what:
        'The cut population is files with >= 1 chunk (13,330), not every file P0 indexed ' +
        '(13,985). 655 files produced zero chunks — barrel re-exports, .d.ts-only files, ' +
        'config files. So T9 is "all CHUNK-BEARING files", where the registration prose ' +
        'says "all indexed files".',
      why_it_does_not_bias_the_ladder:
        'The exclusion is uniform across rungs: the shuffle runs over chunk-bearing files ' +
        'only, so NO rung contains a zero-chunk file. Every rung is the same kind of corpus, ' +
        'and T9 chunk_count == C_total exactly, so the exposure variable is unaffected.',
      direction_of_error:
        'T9 skips 655 files that cost walk+parse time and yield no chunks, so T9 is slightly ' +
        'CHEAPER than a full n8n build. That flattens the top of the ladder and biases b ' +
        'DOWNWARD — i.e. toward O(N) HOLDS, the investigator prior. It does not affect the ' +
        'fit (no rung has these files) but it does mean the ladder does not price the ' +
        'zero-chunk tail, and P0 (which does) is excluded from every fit.',
      precedent:
        'Q1/SCALE\'s tier constructor logged this same class rather than reconciling it ' +
        'silently — 124 zero-chunk files on vscode, of which only 2 were write failures.',
    },
    gate_1b: {
      realized_span: realizedSpan,
      sxx_cluster: sxxCluster,
      sxx_run: sxxRun,
      se_divisor_cluster: Math.sqrt(sxxCluster),
      se_divisor_run: Math.sqrt(sxxRun),
      t_cluster_df7: tCluster,
      t_run_df25: tRun,
      expected_b: EXPECTED_B,
      sigma_ceiling_cluster: sigmaCeilingCluster,
      sigma_ceiling_run: sigmaCeilingRun,
      n_log_n_effective_exponent: bEff,
      projected_sxx_cluster: PROJECTED_SXX_CLUSTER,
      sxx_shortfall: sxxShortfall,
      geometry_gate: geometryOk ? 'PASS' : 'FAIL',
    },
    tiers,
  };

  const out = writeResult('e1-tiers.json', manifest);
  console.log(`\nwrote ${out}`);

  if (!geometryOk) {
    throw new Error(
      `GATE 1b FAILED: realized Sxx_cluster ${sxxCluster.toFixed(3)} is ` +
      `${(sxxShortfall * 100).toFixed(1)}% below the projected ${PROJECTED_SXX_CLUSTER}. ` +
      `Re-examine the cut BEFORE any scored run — never by moving the threshold.`
    );
  }
}

try { main(); } catch (err) {
  console.error(`\n[tiers] FAILED: ${err.message}`);
  process.exitCode = 1;
}
