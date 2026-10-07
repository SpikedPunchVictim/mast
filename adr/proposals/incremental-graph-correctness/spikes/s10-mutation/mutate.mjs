#!/usr/bin/env node
// Spike S10 — do the tests fail when the repair code is broken on purpose?
//
// Usage: node mutate.mjs <repo-root> <mutants.json> <out-dir> [ids]
//
// For each mutant in the spec: replace `find` with `replace` in `file` (the
// text must occur exactly once), run the test files in `spec.tests`, record
// which tests failed, and put the file's bytes back. A mutant is KILLED BY ITS
// NAMED TEST when a failing test's full name contains `killer`; KILLED BY
// ANOTHER when only other tests fail; and a SURVIVOR when none do.
//
// Vitest shortens a table row's name in its report (`when 'a file is deleted
// that stood in front…'`), so a killer that starts with `when ` is matched on
// its first 30 characters after that. Two rows share such a prefix ("a file
// gains a name that is imported"), and either counts.
//
// `node mutate.mjs --rescore <out-dir>` applies the matching to a results.json
// already written, without running anything.
//
// A survivor is then run against `spec.deep`: more generated seeds, and the
// whole suite. What still survives is either a gap in the tests or a mutant
// that changes nothing observable, and RESULTS.md says which by hand.
//
// Vitest does not typecheck, so a mutant that leaves an import unused still
// runs. The file is restored in a `finally` and on SIGINT; the script refuses
// to start if any target file has uncommitted changes.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** True when the failing test `fullName` is the one `killer` names. */
function isNamedKiller(fullName, killer) {
  if (fullName.includes(killer)) return true;
  return killer.startsWith('when ') && fullName.includes(`when '${killer.slice(5, 35)}`);
}

function countVerdicts(results) {
  const counts = {};
  for (const result of results) counts[result.verdict] = (counts[result.verdict] ?? 0) + 1;
  return counts;
}

if (process.argv[2] === '--rescore') {
  const path = join(resolve(process.argv[3] ?? '.'), 'results.json');
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  for (const result of stored.results) {
    if (result.verdict !== 'killed-by-named' && result.verdict !== 'killed-by-other') continue;
    result.verdict = result.failed.some((name) => isNamedKiller(name, result.killer)) ? 'killed-by-named' : 'killed-by-other';
  }
  stored.counts = countVerdicts(stored.results);
  writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`);
  console.log(JSON.stringify(stored.counts));
  process.exit(0);
}

const [rootArg, specArg, outArg, onlyIds] = process.argv.slice(2);
if (rootArg === undefined || specArg === undefined || outArg === undefined) {
  console.error('usage: node mutate.mjs <repo-root> <mutants.json> <out-dir>');
  process.exit(2);
}
const root = resolve(rootArg);
const outDir = resolve(outArg);
const spec = JSON.parse(readFileSync(resolve(specArg), 'utf8'));
// A fourth argument, `I04,I11`, runs only those mutants.
if (onlyIds !== undefined) spec.mutants = spec.mutants.filter((m) => onlyIds.split(',').includes(m.id));
mkdirSync(outDir, { recursive: true });

const targets = [...new Set(spec.mutants.map((m) => m.file))];
const dirty = execFileSync('git', ['status', '--porcelain', '--', ...targets], { cwd: root, encoding: 'utf8' });
if (dirty.trim() !== '') {
  console.error(`refusing to run: uncommitted changes in\n${dirty}`);
  process.exit(2);
}

let restore = () => {};
process.on('SIGINT', () => {
  restore();
  process.exit(130);
});

/** Runs vitest over `files` and returns the full names of the tests that failed. */
function failingTests(files, env = {}) {
  const reportPath = join(outDir, 'vitest-report.json');
  // Removed first, so a run that writes no report cannot be scored from the last one's.
  rmSync(reportPath, { force: true });
  const run = spawnSync(
    'pnpm',
    ['vitest', 'run', ...files, '--reporter=json', `--outputFile=${reportPath}`],
    { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } },
  );
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    // No report: vitest itself did not run. That is a broken mutant, not a kill.
    return { failed: [], total: 0, crashed: `${run.stdout}\n${run.stderr}`.slice(-2000) };
  }
  const failed = [];
  let total = 0;
  for (const file of report.testResults) {
    const shortFile = file.name.replace(`${root}/`, '');
    if (file.assertionResults.length === 0 && file.status === 'failed') failed.push(`${shortFile} :: (file failed to load)`);
    for (const test of file.assertionResults) {
      total++;
      if (test.status === 'failed') failed.push(`${shortFile} :: ${test.fullName}`);
    }
  }
  return { failed, total, crashed: null };
}

const baseline = failingTests(spec.tests);
if (baseline.crashed !== null || baseline.failed.length > 0) {
  console.error('the tests do not pass on unmodified code; nothing was mutated');
  console.error(baseline.crashed ?? baseline.failed.join('\n'));
  process.exit(1);
}
console.log(`baseline: ${baseline.total} tests pass`);

const results = [];
for (const mutant of spec.mutants) {
  const path = join(root, mutant.file);
  const original = readFileSync(path, 'utf8');
  const occurrences = original.split(mutant.find).length - 1;
  if (occurrences !== 1) {
    results.push({ ...mutant, verdict: 'invalid', detail: `find text occurs ${occurrences} times` });
    console.log(`${mutant.id}  INVALID (find occurs ${occurrences} times)`);
    continue;
  }
  restore = () => writeFileSync(path, original);
  let record;
  try {
    writeFileSync(path, original.replace(mutant.find, mutant.replace));
    const first = failingTests(spec.tests);
    const named = first.failed.filter((name) => isNamedKiller(name, mutant.killer));
    record = { ...mutant, failed: first.failed, crashed: first.crashed };
    if (first.crashed !== null) record.verdict = 'crashed';
    else if (named.length > 0) record.verdict = 'killed-by-named';
    else if (first.failed.length > 0) record.verdict = 'killed-by-other';
    else {
      const seeds = failingTests(spec.deep.generatedTest, { MAST_GENERATED_SEEDS: spec.deep.seeds });
      record.failedOnMoreSeeds = seeds.failed;
      if (seeds.failed.length > 0) record.verdict = 'killed-by-more-seeds';
      else {
        const whole = failingTests([]);
        record.failedInWholeSuite = whole.failed;
        record.wholeSuiteTests = whole.total;
        record.crashed = whole.crashed;
        record.verdict = whole.failed.length > 0 ? 'killed-by-whole-suite' : 'survived';
      }
    }
  } finally {
    restore();
    restore = () => {};
  }
  results.push(record);
  console.log(`${mutant.id}  ${record.verdict}  (${record.failed.length} failing)  ${mutant.what}`);
}

const stillDirty = execFileSync('git', ['status', '--porcelain', '--', ...targets], { cwd: root, encoding: 'utf8' });
if (stillDirty.trim() !== '') throw new Error(`a target file was not restored:\n${stillDirty}`);

const counts = countVerdicts(results);
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
writeFileSync(
  join(outDir, 'results.json'),
  `${JSON.stringify({ commit: head, baselineTests: baseline.total, tests: spec.tests, deep: spec.deep, counts, results }, null, 2)}\n`,
);
console.log(JSON.stringify(counts));
