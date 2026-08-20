// The corpus pins, and nothing else.
//
// Extracted from `e1-common.mjs` on 2026-08-20 so that a consumer can learn WHICH commit a
// corpus is pinned at without importing the eval harness — `e1-common.mjs` imports
// `better-sqlite3` at module scope, so reading one constant from it costs a native module load.
// The integration harness (`integration/lib/corpus.mjs`) is the consumer that forced this.
//
// It is an extraction, not a second source. `e1-common.mjs` re-exports `PINS` from here, so
// every existing `eval/*.mjs` importing it is unaffected and there is still exactly one place a
// SHA is written down. Two literals that happen to agree today is S-05, and a pin is the worst
// possible place for it: a corpus at the wrong commit invalidates every frozen target silently.
//
// This file must stay dependency-free. Adding an import to it re-creates the problem it exists
// to solve.

/** The six pins the E1/E2 registration commits. `n8n` is the ladder's source, not a panel rung. */
export const PINS = {
  P1:   { repo: 'opentelemetry-js', sha: '7f3e7eaa9f6bbc9622136479ed846f98c760a408', role: 'panel' },
  P2:   { repo: 'langchainjs',      sha: '62fc484b2a0d1ec5b8bebff4a8a0efe6300ada72', role: 'panel' },
  P3:   { repo: 'strapi',           sha: '0a8a9b40d0642b221c1841ae72295f830352e8ce', role: 'panel' },
  P4:   { repo: 'backstage',        sha: '25463a867ce73ad4bd14179889f84cd815affbb7', role: 'panel' },
  nest: { repo: 'nest',             sha: 'f7fffd63937ce6133624d23eb1d46fdd3c271526', role: 'panel+e2' },
  n8n:  { repo: 'n8n',              sha: '9d9e9bf97e8ae5382a930cd662637a9cf7046ef9', role: 'ladder-source' },
};
