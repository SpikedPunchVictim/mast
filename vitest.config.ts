import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
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
