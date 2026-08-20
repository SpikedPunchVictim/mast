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

  /**
   * The fixture carries a hit, because a positive saving with ZERO results cannot
   * occur: `files_referenced` is empty on a miss, so the bound is 0. The original
   * version of this test passed `results: []` — an input the tool cannot produce
   * (shape S-09), and the reason D029's "omit the accounting on a miss" fix broke
   * it. A test that only holds for an impossible response is not coverage.
   */
  it('reports a positive saving as a saving', () => {
    const big = JSON.stringify({
      results: [{ file_path: 'src/big.ts', start_line: 1, symbol_name: 'wide', chunk_type: 'function' }],
      _stats: { tokens_returned: 100, tokens_full_file_upper_bound: 500 },
    });
    expect(formatSearchResults(big)).toMatch(/80% saved/);
  });

  it('says so plainly when nothing matched, rather than printing an empty page', () => {
    expect(formatSearchResults(JSON.stringify({ results: [] }))).toMatch(/no match/i);
  });

  /**
   * A staleness or busy flag is the one thing a user must not miss: it is the
   * difference between "no callers" and "the index could not tell you".
   *
   * NOTE the input: a TOP-LEVEL busy flag. `mast_search` does not emit one —
   * `mcp/tools/search.ts:33` reserves that name for the other tools — so this
   * test passed for two days while the real signals below were all dropped
   * (defect D029). Kept because the formatter is shared-shaped and the branch
   * is real, but it is not evidence about `mast search`; the three tests after
   * it are.
   */
  it('surfaces a staleness flag instead of dropping it', () => {
    const stale = JSON.stringify({ results: [], file_busy_returning_stale_cache: true });
    expect(formatSearchResults(stale)).toMatch(/stale|busy/i);
  });
});

/**
 * D029 — the honesty signals `mast_search` ACTUALLY emits, every fixture below
 * captured from the built binary on 2026-08-19 rather than written from memory.
 *
 * The distinction that matters: the JSON surface was already correct in all
 * three cases. What was wrong was the join between it and the human surface,
 * which read none of them — so an answer built on a stale file body, and an
 * answer from an empty index, both printed as ordinary confident results.
 */
describe('formatSearchResults — the signals mast_search really emits (D029)', () => {
  // Captured: index two files, edit one without reindexing, `mast search alphaFunction --json`.
  const STALE_HIT = JSON.stringify({
    results: [
      { file_path: 'a.ts', start_line: 1, end_line: 1, symbol_name: 'alphaFunction',
        chunk_type: 'function', is_exported: true,
        content: 'export function alphaFunction(): number { return 1; }', stale: true },
      { file_path: 'b.ts', start_line: 2, end_line: 2, symbol_name: 'betaCaller',
        chunk_type: 'function', is_exported: true,
        content: 'export function betaCaller(): number { return alphaFunction(); }' },
    ],
    _stats: { tokens_returned: 204, tokens_full_file_upper_bound: 43 },
  });

  it('marks the result whose file changed since it was indexed', () => {
    const out = formatSearchResults(STALE_HIT);
    const aLine = out.split('\n').find((l) => l.startsWith('a.ts:1'));
    expect(aLine).toMatch(/stale/i);
  });

  it('does not mark a result whose file is unchanged', () => {
    const out = formatSearchResults(STALE_HIT);
    const bLine = out.split('\n').find((l) => l.startsWith('b.ts:2'));
    expect(bLine).not.toMatch(/stale/i);
  });

  it('warns that a body shown from a stale file may be out of date', () => {
    // The content printed under a stale hit is the PRE-EDIT body. Printing it
    // without a warning is the S0 this row exists for.
    expect(formatSearchResults(STALE_HIT)).toMatch(/may be out of date|re-?index/i);
  });

  it('distinguishes an empty index from a genuine miss', () => {
    // Captured from `mast search anything --json` in a directory with nothing indexed.
    const empty = JSON.stringify({
      results: [], suggestions: [], index_empty: true,
      _stats: { tokens_returned: 7, tokens_full_file_upper_bound: 0 },
    });
    const miss = JSON.stringify({
      results: [], suggestions: [],
      _stats: { tokens_returned: 7, tokens_full_file_upper_bound: 0 },
    });
    expect(formatSearchResults(empty)).toMatch(/nothing (is )?indexed|index is empty|no index/i);
    expect(formatSearchResults(empty)).not.toEqual(formatSearchResults(miss));
  });

  it('says which languages are indexed when nothing matched, so absence is not overread', () => {
    const miss = JSON.stringify({ results: [], suggestions: [] });
    expect(formatSearchResults(miss)).toMatch(/TypeScript.*JavaScript.*Markdown/i);
  });

  it('prints the zero-result suggestions the tool went to the trouble of computing', () => {
    const withSuggestions = JSON.stringify({
      results: [],
      suggestions: [{ symbol: 'keptSymbol', file_path: 'src/kept.ts' }],
    });
    expect(formatSearchResults(withSuggestions)).toMatch(/keptSymbol/);
  });

  it('omits the token accounting when there were no results to account for', () => {
    // "7 tokens returned vs 0 to read the files whole — 0% MORE" is what this
    // printed before: a comparison against nothing, rendered as a verdict.
    const miss = JSON.stringify({
      results: [], _stats: { tokens_returned: 7, tokens_full_file_upper_bound: 0 },
    });
    expect(formatSearchResults(miss)).not.toMatch(/tokens returned/);
  });
});
