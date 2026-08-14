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
import { parseMebibytes, shouldPrintPragmas, resolveSkipFtsDeletes } from '../index-cmd.js';

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

/**
 * `--unsafe-skip-fts-deletes` — E1-FTS's arm G at the CLI boundary.
 *
 * The flag makes `populateFile` skip the two `DELETE FROM *_fts WHERE
 * file_path = ?` statements. On a COLD build those match zero rows, so the
 * finished database is identical and the arm is confound-free. On ANY other
 * path they are load-bearing, and skipping them leaves the previous version's
 * FTS rows behind alongside the new ones — a silently wrong index, since the
 * ordinary tables replace correctly and nothing else looks amiss.
 *
 * So the unsafe combination is refused HERE, at the trust boundary, rather
 * than documented and hoped for. Tested against the exported resolver for the
 * same reason `parseMebibytes` is: a spawn-based test grades `dist/`, not the
 * code under review (D8).
 */
describe('resolveSkipFtsDeletes — the eval-only FTS delete skip', () => {
  it('is off when the flag is absent', () => {
    expect(resolveSkipFtsDeletes(undefined, false)).toBe(false);
    expect(resolveSkipFtsDeletes(undefined, true)).toBe(false);
  });

  it('is on for a cold build when the flag is given', () => {
    expect(resolveSkipFtsDeletes(true, false)).toBe(true);
  });

  // The whole reason the resolver exists. An operator who reached for this on
  // an incremental run would get a corrupt index and no error.
  it('refuses to combine with --incremental, naming both flags', () => {
    expect(() => resolveSkipFtsDeletes(true, true)).toThrow(/--unsafe-skip-fts-deletes/);
    expect(() => resolveSkipFtsDeletes(true, true)).toThrow(/--incremental/);
  });

  // Fails loudly rather than silently degrading to the safe behaviour: an
  // operator who asked for arm G and quietly got arm A would report a null.
  it('throws rather than falling back to the safe path', () => {
    expect(() => resolveSkipFtsDeletes(true, true)).toThrow(Error);
  });
});
