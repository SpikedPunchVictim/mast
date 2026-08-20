// A compromised `structure.lock` must not kill the process.
//
// proper-lockfile refreshes a held lock on a timer (`stale / 2`). If that
// refresh finds the lock gone or owned by someone else — another process
// judged it stale and stole it — it calls `onCompromised`, whose default is
// `(err) => { throw err; }` (`lib/lockfile.js`). That runs inside an `fs.stat`
// callback with no caller on the stack, so it reached the process as an
// uncaught exception. Measured before this fix: `ECOMPROMISED ENOENT`, exit
// code 7, and `grep -rn 'uncaughtException' --include='*.ts' src` returns zero
// handlers to catch it.
//
// SCOPE. These tests pin the reachable half: no process kill, and a run that
// was not exclusive reports failure instead of success. They do NOT pin
// interruption of the in-flight work, which is not implemented — by the time
// the compromise is detected `fn` is mid-execution, and stopping it needs an
// AbortSignal threaded through `withLock`. See `LockCompromisedError`'s doc.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { initLockMarkers, withLock, acquireLock, LockCompromisedError } from '../lock.js';

// proper-lockfile floors `stale` at 2000ms and the refresh at `stale / 2`, so
// 2000 is the fastest a compromise can be made observable — hence the ~1.4s
// waits below. They are the library's floor, not padding.
const FAST_STALE_MS = 2_000;
const PAST_REFRESH_MS = 1_400;

const OPTS = { maxRetries: 0, staleMs: FAST_STALE_MS, sink: { record() { /* silent */ } } };

let dir: string;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); });

function seed(): string {
  dir = mkdtempSync(join(tmpdir(), 'mast-lock-compromised-'));
  initLockMarkers(dir);
  return dir;
}

/** What another process does when it decides our lock is stale. */
function stealLock(stateDir: string): void {
  rmSync(join(stateDir, 'structure.lock'), { recursive: true, force: true });
}

describe('withLock, when the lock is stolen while held', () => {
  it('reports the compromise to the caller instead of killing the process', async () => {
    const stateDir = seed();
    let bodyCompleted = false;

    const run = withLock(stateDir, 'structure', OPTS, async () => {
      stealLock(stateDir);
      await new Promise((r) => setTimeout(r, PAST_REFRESH_MS));
      bodyCompleted = true;
    });

    await expect(run).rejects.toBeInstanceOf(LockCompromisedError);
    // The honest part of the contract: the body ran to completion anyway.
    expect(bodyCompleted).toBe(true);
  });

  it("surfaces the body's own error in preference to the compromise", async () => {
    const stateDir = seed();
    const bodyFailure = new Error('the work itself failed');

    const run = withLock(stateDir, 'structure', OPTS, async () => {
      stealLock(stateDir);
      await new Promise((r) => setTimeout(r, PAST_REFRESH_MS));
      throw bodyFailure;
    });

    // Both went wrong; the body's failure is the more useful diagnosis, and a
    // release() throwing from a bare `finally` would have masked it.
    await expect(run).rejects.toBe(bodyFailure);
  });

  it('leaves no lock behind, so the next acquisition succeeds', async () => {
    const stateDir = seed();
    await withLock(stateDir, 'structure', OPTS, async () => {
      stealLock(stateDir);
      await new Promise((r) => setTimeout(r, PAST_REFRESH_MS));
    }).catch(() => { /* asserted above */ });

    const release = await acquireLock(stateDir, 'structure', OPTS);
    await release();
  });
});

describe('withLock, when nothing goes wrong', () => {
  it('returns the body value and releases cleanly', async () => {
    const stateDir = seed();
    const value = await withLock(stateDir, 'structure', OPTS, async () => 'done');
    expect(value).toBe('done');

    const release = await acquireLock(stateDir, 'structure', OPTS);
    await release();
  });
});
