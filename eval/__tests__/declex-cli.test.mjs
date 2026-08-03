// Gate G — CLI spawn tests (IMPLEMENTATION_PLAN.md § "Q1/DECLEX ... Gates
// before scoring", Gate G: "every shipped script's CLI entry point is
// exercised by an automated test (spawn with --help or a fixture invocation,
// assert exit 0). No script ships CLI-less; no runner-authored drivers this
// time."). Verified recurrence this gate exists to make structurally
// impossible: Q1/SCALE's scale-rank-check.mjs/scale-score.mjs shipped with no
// CLI entry point at all (HANDOFF_Q1.md §5); idfuse-score.mjs recurred the
// same defect one track later (results review F-R7). This is the THIRD
// scoring instrument in this program — every script below is spawned for
// real, as a child process, and its exit code asserted.
//
//   pnpm -F mast test

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = join(__dirname, '..');
const REPO_ROOT = join(EVAL_DIR, '..');

function spawnNode(scriptRelPath, args) {
  return spawnSync(process.execPath, [join(EVAL_DIR, scriptRelPath), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('declex-build-queries.mjs — CLI entry point', () => {
  it('--help exits 0 and prints usage, touching no DB/state', () => {
    const result = spawnNode('declex-build-queries.mjs', ['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('declex-build-queries.mjs');
  });
});

describe('declex-rank-check.mjs — CLI entry point', () => {
  it('--help exits 0 and prints usage, touching no DB/state', () => {
    const result = spawnNode('declex-rank-check.mjs', ['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('--self-check');
    expect(result.stdout).toContain('--measure');
  });

  it('a bare invocation (no recognized flag) prints usage and exits 2 (unrecognized invocation, not a silent no-op)', () => {
    const result = spawnNode('declex-rank-check.mjs', []);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('Usage:');
  });

  it('--measure without --query-set refuses with a clear message and exits 2 (never silently defaults to a query set)', () => {
    const result = spawnNode('declex-rank-check.mjs', ['--measure', '--tier', 'T1', '--arm', 'L']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--query-set');
  });

  it('--measure over a scored stratum without --confirm-scored refuses and exits 2 (the hard-rule safety rail)', () => {
    const result = spawnNode('declex-rank-check.mjs', ['--measure', '--tier', 'T1', '--arm', 'L', '--query-set', 'fresh', '--strata', 's_ident']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('confirm-scored');
  });
});

describe('declex-score.mjs — CLI entry point', () => {
  it('--help exits 0 and prints usage, touching no filesystem beyond stdout', () => {
    const result = spawnNode('declex-score.mjs', ['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('--in');
  });

  it('a fixture invocation (--in a small hand-built ResultRow file) scores end-to-end and exits 0', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'declex-score-cli-'));
    try {
      const inFile = join(tmpDir, 'fixture-rows.json');
      const outFile = join(tmpDir, 'fixture-score-output.json');
      const rows = [];
      function row(overrides) {
        return {
          query_id: 'q0', stratum: 's_ident', tier: 'T1', arm: 'H', query_set: 'fresh',
          mode: 'hybrid', mode_integrity_valid: true, rank: 1, hit_case: 'exact',
          suppression_event: false, censored_rank: 1, in_window_10: true, pre_dedup_rank: 1,
          ...overrides,
        };
      }
      for (let i = 0; i < 10; i++) {
        const qid = `q${i}`;
        rows.push(row({ query_id: qid, tier: 'T1', arm: 'H', in_window_10: true }));
        rows.push(row({ query_id: qid, tier: 'T4', arm: 'H', in_window_10: true }));
        rows.push(row({ query_id: qid, tier: 'T1', arm: 'L', in_window_10: true }));
        rows.push(row({ query_id: qid, tier: 'T4', arm: 'L', in_window_10: false }));
        rows.push(row({ query_id: qid, tier: 'T1', arm: 'L+D', in_window_10: true, d_diagnostic: { fired: true } }));
        rows.push(row({ query_id: qid, tier: 'T4', arm: 'L+D', in_window_10: true, d_diagnostic: { fired: true } }));
      }
      writeFileSync(inFile, JSON.stringify(rows));

      const result = spawnNode('declex-score.mjs', ['--in', inFile, '--out', outFile]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('VERDICT:');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
