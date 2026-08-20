import { describe, it, expect } from 'vitest';
import { toReindexResult } from '../reindex.js';
import type { IndexResult } from '../../../indexer/index.js';

// ---------------------------------------------------------------------------
// toReindexResult — pure field mapping (cheapest layer, §5.5)
//
// A required field on `ReindexResult` guarantees `write_errors` is PRESENT
// (tsc rejects a literal missing it), but not that it holds the right VALUE —
// a copy-paste mistake like `write_errors: result.parseErrors` still
// compiles. This is exactly the "right shape, wrong value" bug class this
// whole fix targets (§14.6), so the mapping's values are asserted directly.
// ---------------------------------------------------------------------------

describe('toReindexResult', () => {
  it('maps writeErrors to write_errors, distinct from parseErrors', () => {
    const result: IndexResult = {
      filesIndexed: 3,
      filesSkipped: 1,
      chunksAdded: 5,
      chunksRemoved: 2,
      parseErrors: 4,
      writeErrors: 7,
      staleWriteRejections: 0,
      miscasedImports: { count: 9, samples: [] },
      durationMs: 123,
      appliedPragmas: { cache_size: -2000, mmap_size: 0 },
      phaseMs: { walk: 1, parse: 2, write: 3, edges: 4, finalise: 5 },
    };

    const mapped = toReindexResult(result);

    expect(mapped.write_errors).toBe(7);
    expect(mapped.parse_errors).toBe(4);
  });

  // `staleWriteRejections`' own doc comment says it "exists only so the rejection is
  // visible instead of silently indistinguishable from an ordinary write (mirrors
  // `writeErrors`'s precedent)". It was mapped onto no wire field and printed by no
  // surface, so the property the comment asserted was implemented nowhere (D039).
  // Every other counter in this fixture holds a different number, so a mis-wired field
  // cannot coincidentally agree.
  it('maps staleWriteRejections to stale_write_rejections, distinct from write_errors', () => {
    const result: IndexResult = {
      filesIndexed: 3,
      filesSkipped: 1,
      chunksAdded: 5,
      chunksRemoved: 2,
      parseErrors: 4,
      writeErrors: 7,
      staleWriteRejections: 11,
      miscasedImports: { count: 9, samples: [] },
      durationMs: 123,
      appliedPragmas: { cache_size: -2000, mmap_size: 0 },
      phaseMs: { walk: 1, parse: 2, write: 3, edges: 4, finalise: 5 },
    };

    const mapped = toReindexResult(result);

    expect(mapped.stale_write_rejections).toBe(11);
    expect(mapped.write_errors).toBe(7);
  });

  // The wire DTO carries the count only; the samples stay CLI-side. Asserting
  // the value guards the same copy-paste class as write_errors above — every
  // other counter in this fixture holds a different number, so a mis-wired
  // field cannot coincidentally agree.
  it('maps the mis-cased import count, not its samples', () => {
    const result: IndexResult = {
      filesIndexed: 3,
      filesSkipped: 1,
      chunksAdded: 5,
      chunksRemoved: 2,
      parseErrors: 4,
      writeErrors: 7,
      staleWriteRejections: 0,
      miscasedImports: {
        count: 9,
        samples: [{ fromFile: 'src/a.ts', specifier: './b', onDiskPath: 'src/B.ts' }],
      },
      durationMs: 123,
      appliedPragmas: { cache_size: -2000, mmap_size: 0 },
      phaseMs: { walk: 1, parse: 2, write: 3, edges: 4, finalise: 5 },
    };

    expect(toReindexResult(result).miscased_imports).toBe(9);
  });
});
