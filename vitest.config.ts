import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // eval/**/*.test.mjs: unit tests for the eval harness's pure logic (Q1/SCALE's
    // scale-rank-check.mjs / scale-score.mjs — statistics and the F4 hit rule must
    // be tested before they ever touch real data, per adr/proposals/retrieval-q1/HANDOFF.md §5's ab-score.mjs
    // defect: a registered-but-never-implemented Wilcoxon test must not repeat).
    // eval/ is not part of the tsc build (tsconfig.json only includes src/**/*), so
    // this does not affect typecheck.
    // integration/**/*.test.mjs: unit tests for the integration harness's pure logic, on the
    // same footing and for the same reason as eval's. The harness decides what the release
    // gate asserts, so its own file-set walk is worth pinning (D051). Like eval/, integration/
    // is outside tsconfig.json's include, so this does not affect typecheck.
    include: ['src/**/*.test.ts', 'eval/**/*.test.mjs', 'integration/**/*.test.mjs'],
    // Stage 7.1 (vector-store deletion, IMPLEMENTATION_PLAN.md Stage 7 decision 1):
    // these five files test RETIRED Q1 instruments whose import chains reach modules
    // deleted at HEAD (dist/search/vector.js, dist/store/lance.js, the embedder).
    // They stay in-repo as the experiment record; their runnable home is the git tag
    // `mast-pre-vector-delete`. Do not re-enable at HEAD — a re-entry per the M2
    // decision memo checks out the tag instead. eval tests with no vector
    // dependency (declex-ranker, idfuse-ranker, …) still run at HEAD.
    exclude: [
      ...configDefaults.exclude,
      // `integration/results/` is the harness's scratch output, and a corpus scenario
      // materialises a real third-party repo into it — n8n ships ~35 of its own `*.test.mjs`,
      // which `integration/**/*.test.mjs` above matches exactly. The directory is gitignored,
      // so this is invisible until a run leaves a working copy behind, which happens precisely
      // when a scenario FAILS. Measured before this line: 66 failed test files, every one of
      // them n8n's, against 97 of ours — a gate that goes red for a reason unrelated to any
      // change in this repo is a gate people learn to ignore (LEDGER D062).
      'integration/results/**',
      'eval/__tests__/declex-cli.test.mjs',
      'eval/__tests__/declex-score.test.mjs',
      'eval/__tests__/scale-score.test.mjs',
      'eval/__tests__/idfuse-score.test.mjs',
      'eval/__tests__/scale-rank-check.test.mjs',
    ],
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
    // Run each test file in a forked child process rather than a worker thread.
    //
    // Originally forced by `@lancedb/lancedb`'s napi runtime threads aborting
    // during worker-thread teardown (BUG_FIXES.md T2). That addon is deleted
    // (Stage 7.1), but the pool is kept: better-sqlite3 and tree-sitter are
    // also native addons, and forked-child teardown remains the conservative
    // choice over re-litigating thread-pool finalization per addon.
    pool: 'forks',
  },
});
