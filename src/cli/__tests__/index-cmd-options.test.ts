/**
 * `mast index`'s SQLite tuning flags — edge parsing.
 *
 * The flags exist to give the E1-PHASE mechanism A/B a way to vary
 * `cache_size` / `mmap_size` between arms (see `OpenDatabaseOptions`,
 * `graph/db.ts`). Commander hands the action raw strings, so the conversion
 * from an operator-facing MiB figure to the pragma's own units is a trust
 * boundary and is parsed here rather than trusted downstream.
 *
 * Tested against the exported parser rather than by spawning the CLI: a
 * spawn-based test resolves against `dist/`, which is exactly the D8 failure
 * mode (the test passes against a binary that is not the code under review).
 */
import { describe, it, expect } from 'vitest';
import { parseMebibytes, shouldPrintPragmas } from '../index-cmd.js';

describe('parseMebibytes — the SQLite tuning flags\' edge validation', () => {
  it('accepts a whole number of MiB', () => {
    expect(parseMebibytes('--cache-size-mib', '64')).toBe(64);
  });

  // `mmap_size = 0` disables memory mapping, which is a legitimate A/B arm and
  // must not be rejected as "missing".
  it('accepts zero', () => {
    expect(parseMebibytes('--mmap-size-mib', '0')).toBe(0);
  });

  it('rejects a non-numeric value, naming the flag', () => {
    expect(() => parseMebibytes('--cache-size-mib', 'lots')).toThrow(/--cache-size-mib/);
  });

  it('rejects a negative value', () => {
    expect(() => parseMebibytes('--cache-size-mib', '-64')).toThrow(/non-negative/);
  });

  // A fractional MiB would silently truncate inside SQLite's own parsing, or
  // produce `cache_size = -0.5`, which is not an error and not what was asked
  // for. Refusing it keeps an arm's declared size and its applied size equal.
  it('rejects a fractional value', () => {
    expect(() => parseMebibytes('--mmap-size-mib', '1.5')).toThrow(/whole number/);
  });

  it('rejects an empty value rather than reading it as zero', () => {
    expect(() => parseMebibytes('--mmap-size-mib', '')).toThrow(/--mmap-size-mib/);
  });
});

/**
 * The `pragmas:` line is instrumentation, so it is opt-in on the same terms as
 * `phases:` — an unconditional extra stdout line changes the CLI's output
 * contract for everyone.
 */
describe('shouldPrintPragmas — when the applied-pragma line is emitted', () => {
  it('stays silent on an ordinary run', () => {
    expect(shouldPrintPragmas(false, {})).toBe(false);
  });

  it('prints when a tuning flag was given, so the operator sees what took effect', () => {
    expect(shouldPrintPragmas(false, { cacheSizeKib: 65_536 })).toBe(true);
  });

  // The load-bearing case. The A/B's CONTROL arm passes no tuning flag, and it
  // is the arm whose "un-pragma'd" claim most needs evidence. The harness sets
  // ENABLE_MAST_PHASE_TIMING on every run, so keying off the same gate is what
  // gives both arms a pragmas line to be graded against.
  it('prints under the phase-timing gate even with no tuning flag', () => {
    expect(shouldPrintPragmas(true, {})).toBe(true);
  });
});
