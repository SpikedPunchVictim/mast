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
      durationMs: 123,
    };

    const mapped = toReindexResult(result);

    expect(mapped.write_errors).toBe(7);
    expect(mapped.parse_errors).toBe(4);
  });
});
