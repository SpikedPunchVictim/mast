// `e1-common.mjs`'s argv construction and pragma parsing.
//
// E1-AB needs `runColdIndex` to pass per-arm CLI flags and to read back the
// `pragmas:` line for Gate A. `e1-common.mjs` is SHARED with E1's 42 scored runs
// and E1-PHASE's 15, so the change had to be additive — and "additive" is a
// claim that deserves a test rather than a comment. The first test below is that
// claim: with no extra args, the argv is byte-for-byte what E1 and E1-PHASE
// spawned.
//
// Run from `packages/mast`, never the repo root.

import { describe, it, expect } from 'vitest';
import { buildIndexArgs, parsePragmas, MAST_BIN } from '../e1-common.mjs';

describe('buildIndexArgs — the argv E1 and E1-PHASE were measured with', () => {
  // The behaviour pin. If this ever changes, every scored run in the E1 track
  // was produced by a command line the harness no longer issues.
  it('builds exactly the historical argv when no extra args are given', () => {
    expect(buildIndexArgs({ projectRoot: '/corpus', stateDir: '/state' })).toEqual([
      MAST_BIN, 'index', '/corpus', '--state-dir', '/state',
    ]);
  });

  it('is identical whether extraArgs is omitted or empty', () => {
    expect(buildIndexArgs({ projectRoot: '/corpus', stateDir: '/state', extraArgs: [] }))
      .toEqual(buildIndexArgs({ projectRoot: '/corpus', stateDir: '/state' }));
  });

  // Arm flags go AFTER the pinned prefix, so no extra arg can displace or
  // shadow `--state-dir` and silently redirect a run.
  it('appends arm flags after the pinned prefix', () => {
    expect(buildIndexArgs({
      projectRoot: '/corpus', stateDir: '/state', extraArgs: ['--cache-size-mib', '1024'],
    })).toEqual([
      MAST_BIN, 'index', '/corpus', '--state-dir', '/state', '--cache-size-mib', '1024',
    ]);
  });
});

/**
 * Mirrors `parsePhaseMs`'s contract deliberately, including the null return:
 * E1's and E1-PHASE's binaries could not emit a `pragmas:` line, and the harness
 * must stay able to read its own history. For an E1-AB scored run a null is not
 * tolerated — Gate A VOIDs it — but that judgement belongs to the gate, not to
 * the parser.
 */
describe('parsePragmas — Gate A\'s evidence, read off the run\'s own stdout', () => {
  it('parses the applied pragmas', () => {
    const stdout = 'files: 1 indexed, 0 skipped  duration: 22ms\n' +
      'phases: {"walk":11,"parse":5,"write":6,"edges":0,"finalise":0}\n' +
      'pragmas: {"cache_size":-1048576,"mmap_size":0}\n';
    expect(parsePragmas(stdout)).toEqual({ cache_size: -1048576, mmap_size: 0 });
  });

  it('returns null when the line is absent, so E1 history stays readable', () => {
    expect(parsePragmas('files: 1 indexed, 0 skipped  duration: 22ms\n')).toBeNull();
  });

  it('returns null rather than throwing on a malformed line', () => {
    expect(parsePragmas('pragmas: {not json}\n')).toBeNull();
  });

  // The `phases:` line also matches `\{.*\}`; the parser must not read it as
  // pragmas just because it appears first.
  it('does not mistake the phases line for the pragmas line', () => {
    const stdout = 'phases: {"walk":1,"parse":2,"write":3,"edges":4,"finalise":5}\n' +
      'pragmas: {"cache_size":-16000,"mmap_size":0}\n';
    expect(parsePragmas(stdout)).toEqual({ cache_size: -16000, mmap_size: 0 });
  });
});
