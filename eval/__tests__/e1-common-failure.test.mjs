// `runColdIndex`'s failure path — the child's own diagnosis must survive the throw.
//
// The defect this pins cost a session. On 2026-08-13 an E1-AB T9 cell died with a
// structure-lock race; `runColdIndex` threw `readIndexMeta`'s bare "No index.json"
// and discarded the child's stderr, which carried the CLI's own "Could not acquire
// structure lock" message. The cause had to be reconstructed from lock metrics and
// WAL sizes instead of simply read.
//
// Run from `packages/mast`, never the repo root.

import { describe, it, expect } from 'vitest';
import { ColdIndexFailure } from '../e1-common.mjs';

const failure = (over = {}) => new ColdIndexFailure({
  stateDir: '/tmp/e1ab-run-A-T9-b1',
  status: 1,
  signal: null,
  stdout: 'indexed 13330 files\n73359 chunks\n',
  stderr: 'Could not acquire structure lock after 5 attempts\nat runIndex (index.ts:241)\n',
  cause: new Error('No index.json in /tmp/e1ab-run-A-T9-b1 — the index run produced no metadata.'),
  ...over,
});

describe('ColdIndexFailure — the child\'s stderr survives the throw', () => {
  it('puts the child\'s stderr in the message, where a reader will actually see it', () => {
    expect(failure().message).toContain('Could not acquire structure lock after 5 attempts');
  });

  it('names the operation and the state dir that failed', () => {
    const m = failure().message;
    expect(m).toContain('/tmp/e1ab-run-A-T9-b1');
    expect(m).toMatch(/cold index/i);
  });

  it('carries the exit status, so a signal kill is distinguishable from a thrown error', () => {
    expect(failure({ status: null, signal: 'SIGKILL' }).message).toContain('SIGKILL');
  });

  // Without this the underlying reader error — which names WHICH artifact was missing —
  // is replaced rather than wrapped.
  it('preserves the underlying reader error as its cause', () => {
    expect(failure().cause).toBeInstanceOf(Error);
    expect(failure().cause.message).toContain('No index.json');
  });

  it('exposes the tails as structured fields, not only as prose', () => {
    const e = failure();
    expect(e.stderr_tail).toContain('Could not acquire structure lock after 5 attempts');
    expect(e.stdout_tail).toContain('73359 chunks');
    expect(e.state_dir).toBe('/tmp/e1ab-run-A-T9-b1');
    expect(e.exit_status).toBe(1);
  });

  // A silent child is itself diagnostic — it distinguishes "the CLI explained itself and
  // we threw the explanation away" from "the CLI died without a word".
  it('says so explicitly when the child wrote nothing to stderr', () => {
    expect(failure({ stderr: '   \n' }).message).toMatch(/stderr.*empty/i);
  });

  it('is an Error subclass, so a driver\'s catch and rethrow behave normally', () => {
    expect(failure()).toBeInstanceOf(Error);
    expect(failure().name).toBe('ColdIndexFailure');
  });
});
