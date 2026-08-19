import { describe, it, expect } from 'vitest';
import { buildSearchArgs, formatSearchResults } from '../search-cmd.js';

/**
 * `mast search` is a presentation layer over `mast query mast_search`, never a
 * second search implementation — D0's rule is that the CLI dispatches through the
 * registered MCP handler so ranking, JIT refresh, staleness flags, and `_stats`
 * cannot drift between surfaces. These tests pin the two pure functions that make
 * up the layer; the dispatch itself is `runQuery`, already covered by cli.test.ts.
 */
describe('buildSearchArgs', () => {
  it('sends only the query when no flags are given', () => {
    expect(JSON.parse(buildSearchArgs('LoudGreeter', {}))).toEqual({ query: 'LoudGreeter' });
  });

  it('maps every flag onto its mast_search schema field', () => {
    const args = JSON.parse(buildSearchArgs('greet', {
      limit: '5', type: 'method', language: 'typescript', exported: true, file: 'src/**',
    }));
    expect(args).toEqual({
      query: 'greet', limit: 5, chunk_type: 'method',
      language: 'typescript', only_exported: true, file_pattern: 'src/**',
    });
  });

  it('rejects a non-numeric limit rather than silently sending NaN', () => {
    expect(() => buildSearchArgs('x', { limit: 'ten' })).toThrow(/limit/i);
  });
});

/**
 * A REAL `mast_search` response, captured from the built binary on 2026-08-19, not
 * hand-written. The first draft of this fixture invented `returned_tokens` /
 * `full_file_tokens`; the formatter was written to match the invention, both agreed,
 * the test passed, and the token line never printed in an actual run. A fixture an
 * author writes from memory tests the author's memory (shape S-09, defect D027).
 */
const RESPONSE = JSON.stringify({
  results: [{
    file_path: 'src/greeter.ts', start_line: 1, end_line: 1,
    content: 'export interface Greeter { greet(name: string): string; }',
    chunk_type: 'interface', symbol_name: 'Greeter', parent_symbol: null,
    is_exported: true, match_score: -1.4747373686843421e-6, rank: 1,
    match_snippet: '...ce **Greeter** { g...',
  }],
  _stats: {
    tool: 'mast_search', tokens_returned: 144, tokens_full_file_upper_bound: 53,
    files_referenced: ['src/greeter.ts'], efficiency_ratio: -1.7169811320754715,
    duration_ms: 85,
  },
});

describe('formatSearchResults', () => {
  it('leads each hit with a file:line an editor and a terminal can both open', () => {
    expect(formatSearchResults(RESPONSE)).toContain('src/greeter.ts:1');
  });

  it('names the symbol and its kind', () => {
    const out = formatSearchResults(RESPONSE);
    expect(out).toContain('Greeter');
    expect(out).toContain('interface');
  });

  it('reports the token accounting, which is the reason the tool exists', () => {
    const out = formatSearchResults(RESPONSE);
    expect(out).toContain('144');
    expect(out).toContain('53');
  });

  /**
   * This response is a real one in which search returned MORE tokens than reading
   * the file whole — two tiny files. The number must survive that direction.
   */
  it('reports a negative saving honestly rather than clamping it', () => {
    expect(formatSearchResults(RESPONSE)).toMatch(/MORE/);
  });

  it('reports a positive saving as a saving', () => {
    const big = JSON.stringify({
      results: [], _stats: { tokens_returned: 100, tokens_full_file_upper_bound: 500 },
    });
    expect(formatSearchResults(big)).toMatch(/80% saved/);
  });

  it('says so plainly when nothing matched, rather than printing an empty page', () => {
    expect(formatSearchResults(JSON.stringify({ results: [] }))).toMatch(/no match/i);
  });

  /**
   * A staleness or busy flag is the one thing a user must not miss: it is the
   * difference between "no callers" and "the index could not tell you".
   */
  it('surfaces a staleness flag instead of dropping it', () => {
    const stale = JSON.stringify({ results: [], file_busy_returning_stale_cache: true });
    expect(formatSearchResults(stale)).toMatch(/stale|busy/i);
  });
});
