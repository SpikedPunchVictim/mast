// The realism project: n8n at the SHA the E1 registration pinned.
//
// Not a definition of files — a reference to a corpus resolved at run time by `lib/corpus.mjs`
// and materialised by hardlink. See `adr/proposals/integration-harness/CLONE-FAMILY-DESIGN.md`
// for what this corpus is and is not good for. In one line: it buys NATURALNESS — a real pnpm
// monorepo, mixed-case paths, deep re-export chains, an interface with hundreds of natural
// implementors — and it does NOT buy extremity. At 13,985 files it is below SQLite's
// 32,766-parameter ceiling and its largest file yields 404 chunks, so the D037 and D002 ceiling
// classes cannot go red here and stay pinned by their unit tests.
export default {
  id: 'n8n',
  description: 'n8n at the E1 pin — a real pnpm monorepo, resolved from cache and hardlinked.',
  corpus: 'n8n',
};
