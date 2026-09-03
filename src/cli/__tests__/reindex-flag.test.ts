// `--reindex` on the CLI query surfaces.
//
// The CLI is the surface with the least freshness protection in the package:
// no watcher (that is `mast serve`) and no cached freshness probe (a one-shot
// process has no lifetime to amortise a TTL over, so `AppContext.freshness` is
// deliberately unset there). Its answer is this explicit flag.
//
// Two properties carry the design and are tested as a pair, because either one
// alone can pass for the wrong reason:
//   1. `--reindex` actually makes a new file discoverable, AND the same query
//      without it does not. The second half is what proves the first is not
//      passing because the file was already indexed.
//   2. A reindex that fails does NOT fail the query. `runIndex` takes
//      `structure.lock`, and with `mast serve` now watching by default that
//      lock is contended more often than it used to be. A search that errors
//      because something else was indexing is worse than a slightly stale one.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { resolveConfig } from '../../store/config.js';
import { runIndex } from '../../indexer/index.js';
import { runQuery, QueryError, registerQueryCommand, type RunQueryOptions } from '../query.js';
import { registerSearchCommand } from '../search-cmd.js';

let tmpDir: string;

const ALPHA = 'export function alphaOne(): number { return 1; }\n';
const BETA = 'export function betaTwo(): number { return 2; }\n';

/** Symbol names `mast_search` returned, in rank order. */
function symbolsIn(responseText: string): readonly (string | null)[] {
  return (JSON.parse(responseText) as { results: Array<{ symbol_name: string | null }> })
    .results.map((r) => r.symbol_name);
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mast-reindex-flag-'));
  writeFileSync(join(tmpDir, 'alpha.ts'), ALPHA);
  await runIndex(resolveConfig({ projectRoot: tmpDir }), { incremental: false });
  // Created AFTER the index run: no `files` row, so JIT staleness is
  // structurally blind to it and only a reindex can surface it.
  writeFileSync(join(tmpDir, 'beta.ts'), BETA);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('runQuery — reindex', () => {
  it('does not find a file created since the last index run', async () => {
    const text = await runQuery('mast_search', JSON.stringify({ query: 'betaTwo' }), { path: tmpDir });

    expect(symbolsIn(text)).toEqual([]);
  });

  it('finds it when reindex is requested', async () => {
    const text = await runQuery('mast_search', JSON.stringify({ query: 'betaTwo' }), {
      path: tmpDir,
      reindex: true,
    });

    expect(symbolsIn(text)).toContain('betaTwo');
  });

  it('reports what the reindex did, on the warn channel rather than stdout', async () => {
    const warnings: string[] = [];

    await runQuery('mast_search', JSON.stringify({ query: 'betaTwo' }), {
      path: tmpDir, reindex: true, warn: (m) => warnings.push(m),
    });

    expect(warnings.join('\n')).toMatch(/reindexed/);
  });

  it('still answers from the existing index when the reindex fails', async () => {
    // The lock-contention path: `acquireLock` throws after exhausting retries.
    const text = await runQuery('mast_search', JSON.stringify({ query: 'alphaOne' }), {
      path: tmpDir,
      reindex: true,
      reindexer: () => Promise.reject(new Error('Could not acquire structure lock after 3 attempt(s)')),
      warn: () => {},
    });

    expect(symbolsIn(text)).toContain('alphaOne');
  });

  it('says the reindex failed rather than failing silently', async () => {
    const warnings: string[] = [];

    await runQuery('mast_search', JSON.stringify({ query: 'alphaOne' }), {
      path: tmpDir,
      reindex: true,
      reindexer: () => Promise.reject(new Error('Could not acquire structure lock after 3 attempt(s)')),
      warn: (m) => warnings.push(m),
    });

    expect(warnings.join('\n')).toMatch(/Could not acquire structure lock/);
  });

  it('does not turn --reindex into a bootstrap for a never-indexed path', async () => {
    // `mast index` creates; `--reindex` refreshes. Running the indexer ahead of
    // the never-indexed guard would create graph.db as a side effect and mask
    // exactly the state that guard exists to report — the same ordering hazard
    // its own comment describes for `openDatabase`.
    const neverIndexed = mkdtempSync(join(tmpdir(), 'mast-never-indexed-'));
    try {
      await expect(
        runQuery('mast_status', '{}', { path: neverIndexed, reindex: true }),
      ).rejects.toThrow(QueryError);
    } finally {
      rmSync(neverIndexed, { recursive: true, force: true });
    }
  });
});

describe('--reindex flag wiring', () => {
  /** Parse `argv` and return the RunQueryOptions the command would dispatch with. */
  async function optionsFrom(
    register: (program: Command, run: typeof runQuery) => void,
    argv: readonly string[],
  ): Promise<RunQueryOptions> {
    let captured: RunQueryOptions | null = null;
    const program = new Command();
    program.exitOverride();
    register(program, (_tool, _json, options = {}) => {
      captured = options;
      return Promise.resolve(JSON.stringify({ results: [], _stats: {} }));
    });

    await program.parseAsync(['node', 'mast', ...argv]);

    if (captured === null) throw new Error('command action did not run');
    return captured;
  }

  it('mast search --reindex asks for a reindex', async () => {
    const options = await optionsFrom(registerSearchCommand, ['search', 'betaTwo', '--reindex']);

    expect(options.reindex).toBe(true);
  });

  it('mast search does not reindex by default', async () => {
    const options = await optionsFrom(registerSearchCommand, ['search', 'betaTwo']);

    expect(options.reindex).toBeFalsy();
  });

  it('mast query --reindex asks for a reindex', async () => {
    const options = await optionsFrom(registerQueryCommand, ['query', 'mast_search', '{"query":"betaTwo"}', '--reindex']);

    expect(options.reindex).toBe(true);
  });

  it('mast query does not reindex by default', async () => {
    const options = await optionsFrom(registerQueryCommand, ['query', 'mast_search', '{"query":"betaTwo"}']);

    expect(options.reindex).toBeFalsy();
  });
});
