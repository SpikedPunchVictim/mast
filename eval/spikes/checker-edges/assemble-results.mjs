// Assembles the per-question result files into the single results.json the
// task brief requires. Run last, after q1/q2/q3/q4/q4b/q5 have all produced
// their own JSON.
//
//   node eval/spikes/checker-edges/assemble-results.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { SPIKE_DIR, BASE_STATE_DIR, PROJECT_ROOT } from './paths.mjs';
import { PROJECTS } from './projects.mjs';

const load = (name) => JSON.parse(readFileSync(join(SPIKE_DIR, name), 'utf-8'));

const q1 = load('q1-results.json');
const q2 = load('q2-results.json');
const q3 = load('q3-results.json');
const q4 = load('q4-results.json');
const q4b = load('q4b-results.json');
const q5 = load('q5-foreign-corpus-results.json');

const assembled = {
  spike: 'IMPLEMENTATION_PLAN_VEXP.md Feature 1 / Stage 1.1 — checker-verified call edges',
  ran_at: new Date().toISOString(),
  provenance: {
    typescript_version: ts.version,
    typescript_resolved_from: 'root workspace hoist: node_modules/.pnpm/typescript@5.9.3 (packages/mast has no separate pinned version; single install across the workspace per pnpm hoisting)',
    monorepo_state_dir: BASE_STATE_DIR,
    monorepo_state_dir_note: 'Reused from the centrality spike (Stage 3.1), built 2026-07-15, another Claude session\'s scratchpad — opened READ-ONLY, never written to.',
    monorepo_project_root: PROJECT_ROOT,
    dist_rebuilt_before_run: true,
    tsconfig_project_scope: PROJECTS,
    tsconfig_project_scope_count: PROJECTS.length,
  },
  q1_baseline_verified_potential_ratio: q1,
  q2_compiler_cost: q2,
  q3_payoff_monorepo: q3,
  q4_checker_vs_heuristic_agreement: q4,
  q4b_bonus_adversarial_false_green_hunt: q4b,
  q5_addendum_foreign_corpus_generalization_check: q5,
};

writeFileSync(join(SPIKE_DIR, 'results.json'), JSON.stringify(assembled, null, 2));
console.log(`wrote ${join(SPIKE_DIR, 'results.json')}`);
