// Q1/OUTCOME — provision the 30 registered runs.
//
// 24 main runs (12 tasks x 2 arms) + 6 noise-floor runs (3 seeded tasks x 2 arms
// x a 2nd replicate), per AMENDMENT 1 #7.
//
// BLINDING (AMENDMENT 1 #3): the agent is handed `search.sh`, which contains NO
// arm string — it reads the arm from a file OUTSIDE the worktree at run time. The
// run_id -> arm manifest is written to a SEALED file that grading never opens.
//
// LEAKAGE (AMENDMENT 1 #1): one git worktree per TASK, with that task's source
// document DELETED from the filesystem. Index-level exclusion alone was
// insufficient — the doc quotes the ground truth, so `grep` over the task text
// would resolve the task without retrieval being on the causal path at all. Both
// arms of a task share one worktree; runs are read-only so they cannot
// cross-contaminate.
//
//   node eval/ab-run-setup.mjs

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SEED = 20260802;
const ROOT = join(homedir(), '.cache', 'mast-eval');
const WT = join(ROOT, 'ab-wt');
const RUNS = join(ROOT, 'ab-runs');
const STATE = join(ROOT, 'ab-state');
const REPO = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const MAST = join(REPO, 'packages', 'mast');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const doc = JSON.parse(readFileSync('./eval/ab-tasks.json', 'utf8'));
const tasks = doc.tasks;

// Noise-floor tasks: seeded pick of 3, fixed before any run.
const rng = mulberry32(SEED + 1);
const noiseTasks = tasks.map((t) => ({ t, r: rng() })).sort((a, b) => a.r - b.r).slice(0, 3).map((x) => x.t.id);

mkdirSync(RUNS, { recursive: true });
mkdirSync(WT, { recursive: true });

// ---------- one worktree per task, source doc removed ----------
for (const t of tasks) {
  const wt = join(WT, t.id);
  if (!existsSync(wt)) {
    execSync(`git worktree add --detach ${JSON.stringify(wt)} HEAD`, { cwd: REPO, stdio: 'pipe' });
  }
  const victim = join(wt, t.source_doc);
  if (existsSync(victim)) rmSync(victim);
  if (existsSync(victim)) { console.error(`FATAL: could not remove ${victim}`); process.exit(1); }
}

// ---------- runs ----------
const runs = [];
for (const t of tasks) {
  for (const arm of ['hybrid', 'lexical']) {
    const reps = noiseTasks.includes(t.id) ? [1, 2] : [1];
    for (const rep of reps) {
      runs.push({ run_id: `${t.id}-${arm === 'hybrid' ? 'A' : 'B'}${rep}`, task: t.id, arm, replicate: rep });
    }
  }
}

for (const r of runs) {
  const dir = join(RUNS, r.run_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'arm'), r.arm);            // outside the worktree
  const sh = `#!/bin/sh
# Code search. Usage: search.sh --query "<text>" [--limit 10]
MAST_AB_ARM="$(cat ${join(dir, 'arm')})" \\
MAST_AB_LOG=${join(RUNS, 'search-log.jsonl')} \\
MAST_AB_RUN=${r.run_id} \\
MAST_AB_TASK=${r.task} \\
MAST_AB_STATE=${STATE} \\
node ${join(MAST, 'eval', 'ab-search.mjs')} "$@" --exclude-file ${tasks.find((t) => t.id === r.task).source_doc}
`;
  writeFileSync(join(dir, 'search.sh'), sh);
  chmodSync(join(dir, 'search.sh'), 0o755);
}

// SEALED manifest — grading must not open this.
writeFileSync(join(RUNS, 'SEALED-manifest.json'), JSON.stringify({
  created_at: new Date().toISOString(), seed: SEED, noise_floor_tasks: noiseTasks, runs,
}, null, 2));

// Agent-facing task cards (no arm, no ground truth).
const cards = runs.map((r) => {
  const t = tasks.find((x) => x.id === r.task);
  return {
    run_id: r.run_id,
    worktree: join(WT, t.id),
    search: join(RUNS, r.run_id, 'search.sh'),
    result_file: join(RUNS, r.run_id, 'result.json'),
    question: t.query,
  };
});
writeFileSync(join(RUNS, 'cards.json'), JSON.stringify(cards, null, 2));

console.log(`worktrees      : ${tasks.length} (source doc removed from each)`);
console.log(`noise-floor    : ${noiseTasks.join(', ')} (seeded)`);
console.log(`runs provisioned: ${runs.length}  (${runs.filter((r) => r.arm === 'hybrid').length} H / ${runs.filter((r) => r.arm === 'lexical').length} L)`);
console.log(`cards          : ${join(RUNS, 'cards.json')}`);
console.log(`SEALED manifest: ${join(RUNS, 'SEALED-manifest.json')}`);
