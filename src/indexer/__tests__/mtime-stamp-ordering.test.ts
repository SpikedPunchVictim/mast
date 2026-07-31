import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveConfig } from '../../store/config.js';
import { runIndex } from '../index.js';
import { extractFile } from '../../ast/extract.js';
import { openDatabase, type Db } from '../../graph/db.js';
import { checkAndRefreshIfStale } from '../../mcp/staleness.js';

// ---------------------------------------------------------------------------
// F12 — parse/write mtime-stamp ordering (IMPLEMENTATION_PLAN.md F12,
// GITNEXUS_COMPARISON.md Stage 1).
//
// F1 (indexer/index.ts) moved the write phase's `files.mtime` stamp to a
// RE-STAT taken AFTER `doExtract` already read the file's content, to stop
// `files.mtime` regressing below the run-start walk's `entry.mtime`. That
// inverted a safe ordering: an edit landing in the unlocked window between
// the parse (content read) and the write phase's re-stat is now stamped with
// a mtime NEWER than the content that was actually parsed. Every later
// staleness check (`diskMtime <= storedMtime` -> "fresh",
// mcp/staleness.ts:49) then reads the file as fresh FOREVER, even though the
// stored content predates the edit — silent, permanent corruption, with no
// `file_busy_returning_stale_cache` flag to signal it.
//
// The fix stats immediately BEFORE `doExtract` in the parse loop (mirroring
// `mcp/staleness.ts`'s JIT path, which has always stat'd before parsing) and
// carries that pre-parse stamp through to the write untouched, restoring the
// invariant `stamp <= mtime-at-content-read`. A post-stat edit then leaves
// stamp < content, so staleness re-fires on the next check — self-healing,
// the same property the JIT path already had.
// ---------------------------------------------------------------------------

describe('F12: the write-phase stamp must never exceed the mtime the parsed content was read against', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mast-f12-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a disk edit landing between parse and write leaves staleness able to re-fire (self-healing)', async () => {
    const TARGET = 'race.ts';
    const targetPath = join(dir, TARGET);

    // Baseline: index once so the file already has a `files.mtime` row — the
    // realistic starting point (an already-indexed corpus about to be
    // reindexed), matching lock-scope.test.ts's own baseline pattern.
    writeFileSync(targetPath, 'export function contentA(): number { return 1; }\n');
    const config = resolveConfig({ projectRoot: dir });
    await runIndex(config, { incremental: false });

    // Move the file to content B — this is the version the SECOND run's
    // parse phase will actually read. Explicit mtime bump: some filesystems
    // have mtime resolution too coarse to guarantee the write above already
    // moved it forward within the same test tick (mirrors lock-scope.test.ts).
    writeFileSync(targetPath, 'export function contentB(): number { return 2; }\n');
    const mtimeB = Date.now() / 1_000 + 5;
    utimesSync(targetPath, mtimeB, mtimeB);

    // Deterministically open the parse -> write race window via the
    // `extractFileFn` DI seam (IndexOptions, §4.4 — the same seam F1's own
    // lock-scope tests use to avoid real concurrency/timing flakiness): parse
    // whatever is CURRENTLY on disk (content B — correct), then, still inside
    // this call, simulate a concurrent editor landing a THIRD edit (content
    // C) with a mtime ahead of B. This is exactly the parse->write window
    // `runIndex`'s own WHY-comment describes as unlocked and "seconds" wide
    // under a real batch.
    const raceExtractFileFn: typeof extractFile = (...args) => {
      const result = extractFile(...args);
      if (args[0] === targetPath) {
        writeFileSync(targetPath, 'export function contentC(): number { return 3; }\n');
        const mtimeC = mtimeB + 5;
        utimesSync(targetPath, mtimeC, mtimeC);
      }
      return result;
    };

    await runIndex(config, { incremental: false, extractFileFn: raceExtractFileFn });

    // Ask the same staleness check the MCP tools use in production — the
    // caller's actual contract, not an internal implementation detail.
    const db: Db = openDatabase(config.resolved_state_dir);
    const storedRow = await db
      .selectFrom('files').select('mtime').where('path', '=', TARGET).executeTakeFirstOrThrow();

    const result = await checkAndRefreshIfStale(db, config, TARGET, storedRow.mtime);
    await db.destroy();

    // The decisive assertion (§14.6 — values, not shape). Before the fix: the
    // write phase re-stats AFTER the whole parse loop, observes content C's
    // mtime, and stamps content B (the parsed result) with it — so
    // `diskMtime(C) <= storedMtime(C)` reads "fresh" and this is
    // `{ refreshed: false, busy: false }`, even though the DB holds content B
    // while disk holds C. After the fix, the stamp is B's own pre-edit mtime,
    // strictly older than disk's current C mtime, so staleness re-fires and
    // JIT successfully refreshes to C.
    expect(result).toEqual({ refreshed: true, busy: false });
  });
});
