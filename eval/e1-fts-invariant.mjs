// Closes FINDINGS.md § 1's last unread rows: `chunk_fts_count` and `identifier_fts_count`.
//
// DESCRIPTIVE, NOT REGISTERED — the `e1-unread-fit.mjs` pattern. No hypothesis, no
// threshold, no verdict. It turns two pieces of hand analysis into a script that FAILS
// LOUDLY if either stops holding.
//
// Why these two rows were worth closing rather than deleting. `chunk_fts_count ===
// chunk_count` is not a curiosity: it is **the check that separates a correct FTS delete
// guard from a merely fast one** (§2.1). The guard at `43eb928` skips
// `DELETE FROM chunk_fts WHERE file_path = ?` when the file was never indexed, and it took
// the T9 build from 538.6 s to 62.1 s. A guard that skipped the delete when the file HAD
// been indexed would be just as fast and would silently orphan rows. The identity is what
// rules that out, and until now nothing ran it.
//
// Run from `packages/mast`, never the repo root.
//
//   node eval/e1-fts-invariant.mjs

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { RESULTS_DIR, writeResult } from './e1-common.mjs';

/**
 * Every journal carrying the two fields.
 *
 * THIS LIST IS THE POINT OF THE SCRIPT. FINDINGS.md § 1 tracked these rows at 27, then 54,
 * then 114 — and every one of those figures omitted `e1-scan`'s 24, because each re-count
 * asked "does the new journal add a new series?" instead of "which journals carry this
 * series?". The true total is 138. Enumerating the space and subtracting is the only
 * method that produces a complete list (§11.3); incrementing a running total is not.
 */
const JOURNALS = ['e1-verify', 'e1-ladder', 'e1-scan', 'e1-hoist'];

/**
 * Fold a journal: last write per key wins, a `void` removes the key.
 *
 * The key differs per journal — `e1-verify` uses `corpus`, `e1-ladder` carries both `tier`
 * and `corpus`, `e1-scan`/`e1-hoist` use `arm` + `tier` + `block`. Joining whatever
 * identity fields are present is stable across all four without hardcoding a shape.
 */
export function foldRuns(records) {
  const keyOf = (r) => [r.arm, r.corpus, r.tier, r.block, r.rep].filter((x) => x !== undefined).join('#');
  const m = new Map();
  const voided = [];
  for (const r of records) {
    if (r.type === 'run') m.set(keyOf(r), r);
    else if (r.type === 'void') { m.delete(keyOf(r)); voided.push(keyOf(r)); }
  }
  return { runs: [...m.values()].map((r) => ({ ...r, __key: keyOf(r) })), voided };
}

/**
 * Read a count that may live at the top level or only under `measurement`.
 *
 * `e1-ladder` carries BOTH FTS counts ONLY at `measurement.*` — reading them from the top
 * level yields `undefined`, and any ratio built on that silently becomes `NaN`. This is
 * the § 1 "not every field is at the top level" trap, which has already cost this program
 * one wrong number.
 *
 * Note this is NOT the `measurement.phase_ms` hazard, which is the opposite instruction:
 * for a TIMING on a Gate 3 retake, top-level holds the fitted attempt and `measurement`
 * holds the wrong one. These are ground-truth COUNTS read from `graph.db` after the run,
 * identical in both places. Falling back is safe here and would not be there.
 */
export function count(row, key) {
  const top = row[key];
  if (top !== undefined) return { value: top, source: 'top-level' };
  const nested = row.measurement?.[key];
  if (nested !== undefined) return { value: nested, source: 'measurement' };
  return { value: undefined, source: null };
}

/**
 * The invariant check over one journal's folded runs. Pure, so the FAILURE path can be
 * exercised by a test — a check nothing has ever seen fail is a check nobody knows works.
 *
 * @returns {{held: number, violations: object[], ratios: object[], sources: string[]}}
 */
export function checkRuns(name, runs) {
  const violations = [];
  const ratios = [];
  let held = 0;
  const sources = new Set();
  for (const r of runs) {
    const chunk = count(r, 'chunk_count');
    const cfts = count(r, 'chunk_fts_count');
    const ifts = count(r, 'identifier_fts_count');
    if (cfts.source !== null) sources.add(cfts.source);

    if (cfts.value === undefined || chunk.value === undefined) {
      violations.push({ journal: name, key: r.__key, reason: 'field_absent', chunk: chunk.value, chunk_fts: cfts.value });
      continue;
    }
    if (cfts.value === chunk.value) held++;
    else violations.push({ journal: name, key: r.__key, reason: 'identity_broken', chunk: chunk.value, chunk_fts: cfts.value, delta: cfts.value - chunk.value });

    if (ifts.value !== undefined && chunk.value > 0) {
      ratios.push({ journal: name, key: r.__key, rung: r.corpus ?? r.tier ?? null, ratio: ifts.value / chunk.value });
    }
  }
  return { held, violations, ratios, sources: [...sources] };
}

function main() {
  const perJournal = [];
  const violations = [];
  const ratios = [];
  let total = 0;

  for (const name of JOURNALS) {
    const path = join(RESULTS_DIR, `${name}-runs.jsonl`);
    const records = readFileSync(path, 'utf-8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
    const { runs, voided } = foldRuns(records);
    const res = checkRuns(name, runs);
    violations.push(...res.violations);
    ratios.push(...res.ratios);
    total += runs.length;
    perJournal.push({ journal: name, runs: runs.length, identity_holds: res.held, voided: voided.length, read_from: res.sources });
  }

  // --- the invariant ---------------------------------------------------------
  const identityOk = violations.length === 0;

  // --- identifier_fts: a ratio, and the identity that explains it ------------
  // Measured directly against three retained databases (e1/run-T{1,5,9}-r3) on
  // 2026-08-18: EVERY chunk lacking an `identifier_fts` row is a markdown chunk, and
  // EVERY markdown chunk lacks one. T1 204/204, T5 744/744, T9 3484/3484, non-markdown
  // misses zero in all three. So the ratio is not a fuzzy proportion — it is
  //
  //     identifier_fts_count === chunk_count - markdown_chunk_count
  //
  // exactly, and the spread below is just the markdown share of each nested subset.
  // The journals do NOT record a markdown chunk count, so this script can report the
  // ratio but cannot assert the identity on all 138 rows; it is verified on 3 databases
  // and inferred elsewhere. Stated rather than blurred (§11.5).
  const rs = ratios.map((r) => r.ratio).sort((a, b) => a - b);
  const byRung = new Map();
  for (const r of ratios) {
    if (r.rung === null) continue;
    if (!byRung.has(r.rung)) byRung.set(r.rung, []);
    byRung.get(r.rung).push(r.ratio);
  }

  const record = {
    created: new Date().toISOString(),
    what: 'Closes FINDINGS.md §1 rows chunk_fts_count / identifier_fts_count. Descriptive, not registered.',
    journals: JOURNALS,
    total_rows: total,
    chunk_fts_identity: {
      statement: 'chunk_fts_count === chunk_count on every scoreable run',
      why_it_matters: 'the check that separates a correct FTS delete guard (43eb928) from a merely fast one — a guard that skipped the delete for an already-indexed file would be equally fast and would orphan rows',
      holds: identityOk,
      rows_checked: total,
      violations,
      per_journal: perJournal,
    },
    identifier_fts_ratio: {
      statement: 'identifier_fts_count === chunk_count - markdown_chunk_count',
      verified_on: ['e1/run-T1-r3 (204/204 md)', 'e1/run-T5-r3 (744/744 md)', 'e1/run-T9-r3 (3484/3484 md)'],
      verified_confidence: 'measured on 3 retained databases; INFERRED on the other 135 journal rows, which record no markdown chunk count',
      non_markdown_misses: 0,
      ratio_min: rs[0],
      ratio_max: rs[rs.length - 1],
      ratio_n: rs.length,
      by_rung: Object.fromEntries([...byRung.entries()].sort()
        .map(([k, v]) => [k, { mean: v.reduce((a, b) => a + b, 0) / v.length, n: v.length }])),
    },
  };

  writeResult('e1-fts-invariant.json', record);

  console.log(`[FTS-INVARIANT] ${total} scoreable rows across ${JOURNALS.length} journals`);
  for (const p of perJournal) {
    console.log(`   ${p.journal.padEnd(10)} ${String(p.identity_holds).padStart(3)}/${String(p.runs).padEnd(3)} identity  (read from ${p.read_from.join('+')})`);
  }
  console.log('');
  console.log(`   chunk_fts_count === chunk_count : ${identityOk ? 'HOLDS' : 'BROKEN'} in ${total - violations.length}/${total}`);
  console.log(`   identifier_fts_count / chunk_count : ${rs[0].toFixed(4)} .. ${rs[rs.length - 1].toFixed(4)}  (= 1 - markdown share)`);

  if (!identityOk) {
    console.error('\n[FTS-INVARIANT] FAILED — the FTS delete guard is orphaning or dropping rows:');
    for (const v of violations.slice(0, 20)) console.error(`   ${v.journal} ${v.key}: ${v.reason} chunk=${v.chunk} chunk_fts=${v.chunk_fts}`);
    process.exitCode = 1;
  }
}

// Only run when invoked directly. Importing this module — which the test suite does, to
// exercise the failure path — must not read journals or write artifacts (§3.3: a module
// that *does* something on import is a side-effectful module, and this one has no reason
// to be).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
