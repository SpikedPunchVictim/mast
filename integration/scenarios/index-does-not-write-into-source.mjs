// The premise this package's severity zero is written on, asserted for the first time.
//
// `docs/defects/LEDGER.md` derives mast's S0 from "`mast` never writes to the user's source; its
// state lives in its own `graph.db`, and a crash costs a re-index". Everything downstream of that
// sentence — that a bad index is recoverable, that the irreversible damage is only ever a wrong
// ANSWER — depends on it being true. Until this scenario it was a claim in a document, which is
// the exact thing this repo's standing rules say never to treat as evidence.
//
// `writeSet: []` is the strongest declaration available and the right one: indexing a project
// must disturb nothing in it. The state dir is excluded from the check by construction
// (`lib/writeset.mjs`), so what is asserted here is precisely "no writes to SOURCE".
//
// CALIBRATION — and the honest label on it. This is pinned red against
// `local-broken-writes-into-source`, which is a CONSTRUCTED fault, not a ledger revert: no
// shipped defect has ever made mast write into an indexed project, so there is nothing real to
// revert. That makes this pin weaker than `case-only-rename-keeps-callers`'s, which reverts D023
// exactly. It proves the guard sees the fault that was built for it. Read it as that and no more.
export default {
  id: 'index-does-not-write-into-source',
  project: 'fixture',
  description: 'Indexing a project writes nothing into it — the premise the severity-zero definition rests on.',
  tags: ['core', 'calibration', 'invariant'],
  writeSet: [],
  expectFailOn: ['local-broken-writes-into-source'],
  steps: [
    { install: 'target' },

    // A full index, then an incremental one, then a query surface and an MCP call: four
    // different code paths that all run against the project directory. The write-set is checked
    // after every one of them, so each step is independently capable of catching a stray write.
    { run: 'index .', expect: { exit: 0, stdoutContains: 'files:' } },
    { run: 'index . --incremental', expect: { exit: 0 } },
    { run: 'status --json', expect: { exit: 0 } },
    { assert: { kind: 'searchFinds', query: 'alphaFunction', symbol: 'alphaFunction', inFile: 'src/alpha.ts' } },
    { mcpCall: { tool: 'mast_status', arguments: {} }, expect: { stdoutContains: 'index_fresh' } },
  ],
};
