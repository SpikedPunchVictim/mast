import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configFor,
  dumpGraph,
  editFile,
  expectGraphEqualsFullIndex,
  indexFull,
  makeProject,
  writeFiles,
} from '../../indexer/__tests__/graph-fixture.js';
import { startWatchMode, type WatchHandle } from '../../indexer/watcher.js';
import type { FreshnessProbe } from '../freshness-probe.js';
import { reindexAndRemeasure } from '../server.js';

// ---------------------------------------------------------------------------
// T8 — the watcher path (D081; adr/proposals/incremental-graph-correctness).
//
// The one-session finding in spikes/s2-commit-replay came through here: with
// `mast serve` watching, an edit to a called file left it with no callers, and
// no test drove this path. A real watcher and the function the server gives
// it as its batch handler, so the wiring is what is under test; the cases are
// in the equivalence tables.
// ---------------------------------------------------------------------------

const NO_PROBE: FreshnessProbe = {
  peekUnindexed: () => null,
  invalidate: () => {},
  refresh: () => {},
  settled: () => Promise.resolve(),
};

describe('an edit picked up by the watcher', () => {
  let dir: string;
  let handle: WatchHandle | undefined;

  beforeEach(() => {
    dir = makeProject('watch-batch-edges');
  });
  afterEach(async () => {
    await handle?.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves the callers of the edited file in place', async () => {
    writeFiles(dir, {
      'src/x.ts': `export function fn(): number { return 1; }\n`,
      'src/zc.ts': `import { fn } from './x.js';\nexport function use(): void { fn(); }\n`,
    });
    await indexFull(dir);
    const config = configFor(dir);
    let batchesFinished = 0;
    await new Promise<void>((resolve) => {
      handle = startWatchMode({
        config,
        runBatch: async () => {
          await reindexAndRemeasure(config, NO_PROBE, { incremental: true });
          batchesFinished++;
        },
        onWarn: () => {},
        onReady: resolve,
        debounceMs: 20,
      });
    });

    editFile(dir, 'src/x.ts', `export function fn(): number { return 2; }\n`);
    // "Eventually", not a latency claim: see the note on the same budget in
    // indexer/__tests__/watcher.test.ts (D064).
    await vi.waitFor(() => { expect(batchesFinished).toBeGreaterThan(0); }, { timeout: 45_000, interval: 50 });
    await handle?.close();
    handle = undefined;

    const stored = await dumpGraph(config, { withResolution: false, edgeTypes: ['POTENTIAL_CALL'] });
    expect(stored.edges).toEqual(['POTENTIAL_CALL src/zc.ts:use -> src/x.ts:fn']);
    await expectGraphEqualsFullIndex(dir);
  }, 60_000);
});
