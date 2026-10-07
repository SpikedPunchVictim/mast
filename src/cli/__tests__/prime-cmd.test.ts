import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import type { StatusReport } from '../status.js';
import { renderPrime, registerPrimeCommand, PRIME_ASSET_PATH } from '../prime-cmd.js';
import { listRegisteredToolNames } from '../query.js';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const RULES = 'RULES-SENTINEL: search with mast before grep.';

const fresh: StatusReport = {
  state_dir: '/work/proj/.mast',
  project_root: '/work/proj',
  initialised: true,
  schema_version: '3',
  last_indexed: '2026-10-04T11:55:00.000Z',
  indexed_files: 412,
  chunk_count: 9000,
  stale_files: 0,
  stale_breakdown: { changed: 0, unindexed: 0, deleted: 0 },
  stale_paths: { changed: [], unindexed: [], deleted: [] },
  parse_errors: 0,
  write_errors: 0,
  index_fresh: true,
  freshness_cause: null,
};

const stale: StatusReport = {
  ...fresh,
  stale_files: 8,
  stale_breakdown: { changed: 3, unindexed: 4, deleted: 1 },
  index_fresh: false,
  freshness_cause: 'phase1_stale',
};

const mismatch: StatusReport = {
  ...stale,
  stale_files: 3391,
  stale_breakdown: { changed: 1, unindexed: 3000, deleted: 390 },
  freshness_cause: 'root_mismatch',
};

const uninitialised: StatusReport = {
  state_dir: '/work/proj/.mast',
  project_root: '/work/proj',
  initialised: false,
  schema_version: '3',
  last_indexed: null,
  indexed_files: null,
  chunk_count: null,
  stale_files: null,
  stale_breakdown: null,
  stale_paths: null,
  parse_errors: null,
  write_errors: null,
  index_fresh: false,
  freshness_cause: 'not_initialised',
};

describe('renderPrime', () => {
  it('prints the rules and the indexed file count for a fresh index, with no reindex instruction', () => {
    const out = renderPrime(fresh, RULES, NOW);

    expect(out).toContain(RULES);
    expect(out).toContain('412');
    expect(out).toContain('5m ago');
    expect(out).not.toContain('mast_reindex');
  });

  it('prints the rules, the changed/unindexed/deleted split and a reindex instruction for a stale index', () => {
    const out = renderPrime(stale, RULES, NOW);

    expect(out).toContain(RULES);
    expect(out).toMatch(/changed 3/);
    expect(out).toMatch(/unindexed 4/);
    expect(out).toMatch(/deleted 1/);
    expect(out).toContain('mast_reindex');
  });

  it('withholds the rules and says the index describes a different tree on a root mismatch', () => {
    const out = renderPrime(mismatch, RULES, NOW);

    expect(out).not.toContain(RULES);
    expect(out).toContain('/work/proj/.mast');
    expect(out).toContain('/work/proj');
    expect(out).toMatch(/different/);
    expect(out).toMatch(/reindexing will not fix/i);
  });

  it('withholds the rules and points at ordinary search plus `mast init` when nothing is indexed', () => {
    const out = renderPrime(uninitialised, RULES, NOW);

    expect(out).not.toContain(RULES);
    expect(out).toContain('mast init');
    expect(out).toMatch(/no index/i);
  });
});

describe('assets/prime.md', () => {
  it('mentions only mast_ tools the MCP server actually registers', () => {
    const rules = readFileSync(PRIME_ASSET_PATH, 'utf8');
    const mentioned = [...new Set(rules.match(/\bmast_[a-z_]+\b/g) ?? [])];
    const registered = new Set(listRegisteredToolNames());

    expect(mentioned.length).toBeGreaterThan(0);
    expect(mentioned.filter((name) => !registered.has(name))).toEqual([]);
  });
});

describe('mast prime', () => {
  let tmpDir: string;
  afterEach(() => {
    process.exitCode = undefined;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits 0 and prints the not-initialised note in a directory with no index', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-prime-cmd-'));
    let buffer = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      buffer += typeof chunk === 'string' ? chunk : String(chunk);
      return true;
    });
    const program = new Command();
    registerPrimeCommand(program);

    try {
      await program.parseAsync(['prime', tmpDir], { from: 'user' });
    } finally {
      spy.mockRestore();
    }

    expect({ exit: process.exitCode ?? 0, mentionsInit: buffer.includes('mast init') })
      .toEqual({ exit: 0, mentionsInit: true });
  });
});
