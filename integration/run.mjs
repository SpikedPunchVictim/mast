#!/usr/bin/env node
// mast integration harness — entry point. See README.md and adr/015.
//
// Every filter guards against matching nothing. A typo'd `--scenarios` or `--tags` that selects
// zero scenarios is a HARD ERROR, never a green run: "nothing ran" and "everything passed" are
// the same output otherwise, and only one of them is true.
import { mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installLocal, knownBreakages } from './lib/install.mjs';
import { materialize } from './lib/project.mjs';
import { runScenario } from './lib/scenario-runner.mjs';
import { validateScenario, validateNoDuplicateKeys } from './lib/spec-validate.mjs';
import { checkRequirement } from './lib/requirements.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

function parseArgs(argv) {
  const args = { targets: ['local'], out: undefined, keepAll: false, scenarios: undefined, tags: undefined, gateTarget: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '--targets') args.targets = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--scenarios') args.scenarios = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--tags') args.tags = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--gate-target') args.gateTarget = next();
    else if (a === '--out') args.out = next();
    else if (a === '--keep-all') args.keepAll = true;
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else throw new Error(`unknown flag '${a}'`);
  }
  return args;
}

function usage() {
  console.log(`mast integration harness

  node integration/run.mjs [flags]

  --targets <t1,t2>     'local' (the packed working tree) or 'local-broken-<name>'.
                        Known breakages: ${knownBreakages().join(', ')}
  --scenarios <id,...>  run only these scenario ids
  --tags <tag,...>      run scenarios carrying at least one of these tags
  --gate-target <t>     which target decides the exit code (default: local if present)
  --out <dir>           where to write results (default: integration/results/<timestamp>)
  --keep-all            keep working copies even for scenarios that passed
`);
}

async function loadScenarios(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
  const out = [];
  for (const f of files) {
    const path = join(dir, f);
    validateNoDuplicateKeys(path);
    const mod = await import(path);
    const scenario = mod.default;
    validateScenario(scenario, path);
    if (scenario.id !== f.replace(/\.mjs$/, '')) {
      throw new Error(`${path}: scenario id '${scenario.id}' does not match its filename — one of the two is a typo, and selecting by id would silently miss it`);
    }
    out.push(scenario);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = args.out ?? join(HERE, 'results', stamp);
  mkdirSync(outDir, { recursive: true });

  const all = await loadScenarios(join(HERE, 'scenarios'));
  if (all.length === 0) throw new Error('no scenarios found — refusing to report a zero-scenario run as passing');

  let selected = all;
  if (args.scenarios !== undefined) {
    const known = new Set(all.map((s) => s.id));
    for (const id of args.scenarios) if (!known.has(id)) throw new Error(`--scenarios '${id}' matches no scenario — refusing to run: a typo'd id would silently narrow the suite`);
    selected = selected.filter((s) => args.scenarios.includes(s.id));
  }
  if (args.tags !== undefined) {
    selected = selected.filter((s) => (s.tags ?? []).some((t) => args.tags.includes(t)));
    if (selected.length === 0) throw new Error(`--tags ${args.tags.join(',')} matches no scenario — refusing to run`);
  }
  if (selected.length === 0) throw new Error('scenario selection is empty — refusing to report a zero-scenario run as passing');

  const gateTarget = args.gateTarget ?? (args.targets.includes('local') ? 'local' : args.targets[0]);
  if (!args.targets.includes(gateTarget)) {
    throw new Error(`--gate-target '${gateTarget}' is not among --targets (${args.targets.join(', ')}) — refusing to run: a gate target matching no results would silently report success`);
  }

  const log = (m) => { console.log(m); };
  log(`[run] ${selected.length} scenario(s) x ${args.targets.length} target(s); gate: ${gateTarget}`);
  log(`[run] results: ${outDir}`);

  const matrix = [];
  for (const target of args.targets) {
    const breakage = target === 'local' ? undefined : target.replace(/^local-broken-/, '');
    if (target !== 'local' && !knownBreakages().includes(breakage)) {
      throw new Error(`unknown target '${target}' — expected 'local' or one of ${knownBreakages().map((b) => `local-broken-${b}`).join(', ')}`);
    }
    const installRoot = join(outDir, `install-${target}`);
    log(`\n[run] === target ${target} ===`);
    const install = installLocal(REPO_ROOT, installRoot, { breakage, log });
    writeFileSync(join(outDir, `install-${target}.json`), JSON.stringify(install, null, 2));

    for (const scenario of selected) {
      const unmet = checkRequirement(scenario.requires);
      if (unmet !== null) {
        // SKIP is its own outcome. A scenario that could not run on this machine must not be
        // counted as evidence in either direction — reporting it as a pass is the S-07 shape.
        log(`\n[${target}] ${scenario.id}: SKIP — ${unmet}`);
        matrix.push({ scenarioId: scenario.id, target, pass: false, skipped: true, reason: unmet, errored: false, steps: [] });
        continue;
      }
      const workingDir = join(outDir, `work-${target}-${scenario.id}`);
      const project = (await import(join(HERE, 'projects', `${scenario.project}.mjs`))).default;
      materialize(project, workingDir);
      log(`\n[${target}] ${scenario.id} — ${scenario.description}`);
      const result = await runScenario(scenario, { installRoot, workingDir, target, log });
      const pinnedRed = (scenario.expectFailOn ?? []).includes(target);
      matrix.push({ ...result, pinnedRed, workingDir });
      const verdict = result.errored ? 'ERROR' : result.pass ? 'PASS' : 'FAIL';
      log(`[${target}] ${scenario.id}: ${verdict}${pinnedRed ? ' (pinned red)' : ''}`);
      if (result.errored) log(`  ERROR: ${result.errorMessage}`);
      if (result.pass && !args.keepAll) rmSync(workingDir, { recursive: true, force: true });
    }
  }

  writeFileSync(join(outDir, 'results.json'), JSON.stringify(matrix, null, 2));

  // Red/green calibration. A scenario pinned to fail against a deliberately broken build, that
  // passes anyway, means the harness can no longer demonstrate the defect it exists to catch.
  // Checked independently of --gate-target: this is harness integrity, not a per-target result.
  const calibrationBreaks = matrix.filter((m) => m.pinnedRed && m.pass && m.skipped !== true).map((m) => `${m.scenarioId}@${m.target}`);
  const unexercised = [];
  for (const s of selected) {
    for (const t of s.expectFailOn ?? []) {
      if (!args.targets.includes(t)) unexercised.push(`${s.id}@${t}`);
    }
  }

  log('\n[run] --- summary ---');
  for (const m of matrix) {
    const verdict = m.skipped === true ? 'SKIP ' : m.errored ? 'ERROR' : m.pass ? 'PASS ' : 'FAIL ';
    log(`  ${verdict}  ${m.target}  ${m.scenarioId}${m.pinnedRed ? '  (pinned red)' : ''}${m.skipped === true ? `  — ${m.reason}` : ''}`);
  }
  if (unexercised.length > 0) log(`[run] NOTE: pinned-red pairs not exercised this run: ${unexercised.join(', ')} — their green is uncalibrated.`);

  let exit = 0;
  if (calibrationBreaks.length > 0) {
    log(`\n[run] RED/GREEN CALIBRATION BROKEN: ${calibrationBreaks.join(', ')} are pinned to prove a real defect by going RED, and they PASSED. The harness can no longer demonstrate the regression it exists to catch — treat this as a blocker, not a note.`);
    exit = 1;
  }
  const gated = matrix.filter((m) => m.target === gateTarget && !m.pinnedRed && m.skipped !== true);
  const bad = gated.filter((m) => !m.pass);
  if (bad.length > 0) {
    log(`\n[run] ${bad.length} scenario(s) failed on the gate target '${gateTarget}': ${bad.map((m) => m.scenarioId).join(', ')}`);
    exit = 1;
  }
  if (exit === 0) log(`\n[run] green: ${gated.length} scenario(s) on '${gateTarget}', ${calibrationBreaks.length === 0 ? `${matrix.filter((m) => m.pinnedRed).length} calibration pin(s) held` : ''}`);
  process.exit(exit);
}

main().catch((err) => {
  console.error(`[run] ERROR: ${err.message}`);
  process.exit(2);
});
