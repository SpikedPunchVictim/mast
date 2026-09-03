// `mast serve` as a SESSION — the half of the system no other scenario reaches.
//
// Every other scenario here drives `mast index` from the CLI and asks one-shot MCP questions, so
// each `mcpCall` gets its own server process that lives for a single request. Everything `serve`
// actually owns is invisible to that: the file watcher (§11.4), the startup reindex's effect on a
// later query, and the freshness probe's cached `unindexed_files` count. All three are properties
// of a process that outlives one request, and none of them had an end-to-end test.
//
// This is D054's severity zero, driven through the real transport rather than a unit fixture: a
// file created after the server started is invisible to every read tool until something reindexes,
// and until 2026-09-03 nothing did. Two independent mechanisms now close it, and this scenario
// asserts each one separately, because either alone would make the other's failure invisible:
//
//   Part 1 — watching is ON BY DEFAULT, so the new file is found without anyone asking.
//   Part 2 — with watching OFF, the answer is still not silent: `unindexed_files` says the corpus
//            the search ran over was incomplete. This is the guard for when the watcher is off,
//            fails to start (EMFILE), or has not caught up yet.
//
// Part 2 runs `--no-startup-reindex` deliberately. With the startup reindex on, the server would
// index the new file within a second or two and there would be nothing to warn about — the
// scenario would pass by racing rather than by asserting.
export default {
  id: 'serve-session-discovers-new-files',
  project: 'fixture',
  description: 'A live `mast serve` session finds a file created after startup (watch default), and warns via unindexed_files when it cannot (D054).',
  tags: ['serve', 'freshness'],
  writeSet: ['src/gamma.ts', 'src/delta.ts'],
  steps: [
    { install: 'target' },
    { run: 'index .', expect: { exit: 0 } },

    // ---- Part 1: the watcher, which is on unless asked otherwise ------------
    // `settleMs`: the watcher starts AFTER the transport connects, and chokidar's initial scan
    // (`ignoreInitial: true`) has no readiness signal anything outside the process can see. A
    // file created inside that window fires no event, so this scenario would report FAIL for a
    // watcher that is working. Not a hypothetical — it passed alone and failed when it ran after
    // the 26k-file n8n scenario. LEDGER D061 records the missing signal as the real defect.
    { serve: { settleMs: 3000 } },

    // Baseline through the SESSION, not a fresh process: the symbol genuinely does not exist yet,
    // so the assertion below cannot be satisfied by a stale index or a lucky prefix match.
    {
      mcpCall: { tool: 'mast_search', arguments: { query: 'gammaAddedWhileServing' } },
      expect: { stdoutMatches: '"results"\\s*:\\s*\\[\\s*\\]' },
    },

    { mutate: { kind: 'addFile', file: 'src/gamma.ts', content: 'export function gammaAddedWhileServing(): number {\n  return 7;\n}\n' } },

    // No `mast_reindex` call, and no `mast index` run — the watcher is the only thing that can
    // make this pass. Polled rather than slept: chokidar debounces and the batch takes
    // `structure.lock`, so the contract is "becomes true, within this long", not "is true now".
    {
      mcpCall: { tool: 'mast_search', arguments: { query: 'gammaAddedWhileServing' } },
      retry: { timeoutMs: 30000, intervalMs: 500 },
      expect: { stdoutContains: 'gammaAddedWhileServing' },
    },

    { serveStop: {} },

    // ---- Part 2: the signal that covers the case the watcher does not -------
    // A file on disk that the index has never seen, and a server that will not go looking.
    { mutate: { kind: 'addFile', file: 'src/delta.ts', content: 'export function deltaNeverIndexed(): number {\n  return 9;\n}\n' } },

    { serve: { args: ['--no-watch', '--no-startup-reindex'] } },

    // The S0 in one call: a confident empty answer for a symbol sitting on disk. What makes it
    // safe is the warning riding alongside it. Retried because the probe measures in the
    // background at startup, so the first search of a session can legitimately land before any
    // measurement has — `unindexed_files` absent means "not warned", never "verified clean".
    {
      mcpCall: { tool: 'mast_search', arguments: { query: 'deltaNeverIndexed' } },
      retry: { timeoutMs: 30000, intervalMs: 500 },
      expect: { stdoutContains: '"unindexed_files"' },
    },

    // The same warning on a tool that is not search — D054's actual gap was that only
    // `mast_search` carried it, while `mast_signature` answered 0 in silence.
    {
      mcpCall: { tool: 'mast_signature', arguments: { symbol: 'deltaNeverIndexed' } },
      retry: { timeoutMs: 30000, intervalMs: 500 },
      expect: { stdoutContains: '"unindexed_files"' },
    },

    { serveStop: {} },
  ],
};
