// What a step's cap expiring is allowed to look like.
//
// `run` throws on a launch failure and on a timeout, and until this file both produced the
// same shape: `failed to run \`...\`: spawnSync ... ETIMEDOUT`. That message cost this project
// two debugging sessions on the n8n corpus scenario, because it does not distinguish the two
// causes a reader must tell apart — a genuinely hung command, and a cap set below what the
// workload costs on the machine it is running on. The same corpus indexed in 78.7s once and
// 739s an hour earlier under load; only the second exceeded the 300s cap, and nothing in the
// error said how close either was.
//
// So the contract pinned here is narrow and reportorial: a timeout says how long it ran, what
// the cap was, and that the process was killed rather than having failed. It does NOT claim to
// know which cause it was — the harness cannot know that, and a message that guessed would be
// worse than one that reports.
import { describe, it, expect } from 'vitest';
import { run, DEFAULT_TIMEOUT_MS } from '../lib/exec.mjs';

/** A command that will outlive any cap this file sets. */
const SLEEP_FOREVER = ['-e', 'setTimeout(() => {}, 60_000)'];

describe('run() timeout reporting', () => {
  it('names the elapsed time and the cap when a command is killed', () => {
    let message = '';
    try {
      run(process.execPath, SLEEP_FOREVER, { timeoutMs: 250 });
      expect.unreachable('expected the cap to expire');
    } catch (error) {
      message = error.message;
    }

    expect(message).toContain('timed out');
    expect(message).toContain('cap 0.25s');
    // The elapsed figure is the half a reader acts on, and it must be a real measurement
    // rather than an echo of the cap: assert the shape, not a value that could be copied
    // from `timeoutMs` without ever consulting the clock.
    expect(message).toMatch(/after \d+\.\d+s/);
  });

  it('says the process was killed rather than that the command failed', () => {
    // The distinction the old message erased. A killed process produced no verdict at all,
    // so reporting it as a failure of the command invites exactly the wrong investigation.
    expect(() => run(process.execPath, SLEEP_FOREVER, { timeoutMs: 250 })).toThrow(/killed/);
  });

  it('does not describe a launch failure as a timeout', () => {
    // The other arm. If the timeout branch is reached by anything but an expired cap, a
    // missing binary starts reporting a duration and a cap that mean nothing.
    let message = '';
    try {
      run('/nonexistent/binary/mast-does-not-exist', [], { timeoutMs: 60_000 });
      expect.unreachable('expected a launch failure');
    } catch (error) {
      message = error.message;
    }

    expect(message).toContain('failed to run');
    expect(message).not.toContain('timed out');
  });

  it('returns normally when the command finishes inside its cap', () => {
    // Guards the cap being applied at the wrong scale — a `timeoutMs` read as seconds would
    // kill this, and every assertion above would still pass.
    const result = run(process.execPath, ['-e', 'process.stdout.write("ok")'], { timeoutMs: 30_000 });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
  });

  it('exposes the default cap so a scenario can reason about what it is raising', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });
});
