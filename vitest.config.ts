import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // eval/**/*.test.mjs: unit tests for the eval harness's pure logic (Q1/SCALE's
    // scale-rank-check.mjs / scale-score.mjs — statistics and the F4 hit rule must
    // be tested before they ever touch real data, per HANDOFF_Q1.md §5's ab-score.mjs
    // defect: a registered-but-never-implemented Wilcoxon test must not repeat).
    // eval/ is not part of the tsc build (tsconfig.json only includes src/**/*), so
    // this does not affect typecheck.
    include: ['src/**/*.test.ts', 'eval/**/*.test.mjs'],
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
    // Run each test file in a forked child process rather than a worker thread.
    //
    // `@lancedb/lancedb` is a native (napi/Rust) addon with its own background
    // runtime threads. Under vitest's default `threads` pool the napi
    // environment is finalized during worker-thread teardown while those native
    // threads can still hold references, which intermittently aborts the
    // process with a `Reference::Finalize` fault *after* all tests have passed
    // (see BUG_FIXES.md T2). The `forks` pool defers native finalization to a
    // normal child-process exit, which the addon handles cleanly.
    pool: 'forks',
  },
});
