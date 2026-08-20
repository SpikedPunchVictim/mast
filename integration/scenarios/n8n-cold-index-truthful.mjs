// The first scenario over a corpus of natural complexity, and deliberately the least clever one.
//
// It asserts only what can be asserted without the capture audit that step 2 of
// `adr/proposals/integration-harness/CLONE-FAMILY-DESIGN.md` schedules: that a real pnpm
// monorepo indexes to completion through the INSTALLED artifact, that the index is not empty
// afterwards, that both status surfaces answer, and that nothing was written into the source
// tree. Everything sharper — cross-tool closure, goldens, the git file-set oracle — waits on
// real captured output, because ADR 015 §6 records what happens when an assertion is designed
// against output nobody looked at: two of them turned out unimplementable, and checking the
// third is what found D029.
//
// WHAT THIS ADDS over the fixture family: the fixture is seven files and indexes in about a
// second. Nothing in the harness, and nothing in the unit suite, has ever driven the installed
// binary over ~14k files, a workspace-alias import graph, or a state dir measured in hundreds of
// megabytes. The failure classes that need scale to appear — a walk that quietly drops a
// subtree, a write phase that fails partway and reports success (D034's class), an index whose
// completion claim outruns its content — have had no instrument at all.
//
// `writeSet: []` is not incidental. Indexing 14k files touches nothing in them, and this is the
// scenario where a stray write would be least noticeable by eye.
export default {
  id: 'n8n-cold-index-truthful',
  project: 'n8n',
  description: 'A real pnpm monorepo indexes to completion through the installed artifact, and writes nothing into itself.',
  tags: ['realism', 'core'],
  writeSet: [],
  steps: [
    { install: 'target' },

    // The measurement this family was blocked on. The design could cite only a 636 s
    // full-worktree figure from the 2026-08-12 binary and a ~60 s figure for a hardlinked TIER
    // on the 2026-08-18 one, and had to carry the tiering plan as a projection. `durationMs`
    // lands in results.json for this step.
    { run: 'index .', expect: { exit: 0, stdoutContains: 'files:' } },

    // Not empty, and it says so through the same surface an agent would use. `index_empty` is
    // D029's fix: an empty index and a genuine miss stopped being indistinguishable.
    { assert: { kind: 'indexEmpty', expected: false, query: 'workflow' } },

    // Both status surfaces answer over a 400+ MB state dir. Field-set EQUALITY between them is
    // D035's pin and belongs to a later scenario — it needs the capture audit first, because the
    // unit pin runs in-process and cannot see a serialization difference on the wire.
    { run: 'status --json', expect: { exit: 0 } },
    { mcpCall: { tool: 'mast_status', arguments: {} }, expect: { stdoutContains: 'index_fresh' } },

    // A second index over an unchanged tree. Asserted here only as "completes and stays
    // non-empty" — real idempotency is `captureEquals` over a normalized battery, which is
    // step 3 machinery.
    { run: 'index . --incremental', expect: { exit: 0 } },
    { assert: { kind: 'indexEmpty', expected: false, query: 'workflow' } },
  ],
};
