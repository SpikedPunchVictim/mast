import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../../store/config.js';
import {
  WatchScheduler, shouldWatchPath, startWatchMode,
  type WatchPathFilter, type WatchHandle, type StartWatchModeOptions,
} from '../watcher.js';

// ---------------------------------------------------------------------------
// WatchScheduler — debounce / coalesce / single-flight (fake timers, no chokidar)
// ---------------------------------------------------------------------------

const DEBOUNCE = 500;

interface Harness {
  /**
   * Assigned immediately after the literal, never reassigned afterwards — so it is
   * mutable for one reason only: `WatchScheduler`'s `onBatch` closes over the harness,
   * so the harness has to exist before the scheduler does. Declaring it `readonly`
   * made `makeHarness` a type error that nothing reported, because test files were
   * outside `tsc`'s view until `tsconfig.test.json`.
   */
  scheduler: WatchScheduler;
  readonly batches: string[][];
  readonly warnings: string[];
  /** Resolvers for in-flight onBatch promises, in call order. */
  readonly resolvers: Array<{ resolve: () => void; reject: (err: Error) => void }>;
  /** Number of onBatch calls currently in flight. */
  inFlight: number;
  maxInFlight: number;
}

/** Scheduler wired to a manually-resolvable onBatch so runs can be held open. */
function makeHarness(opts: { autoResolve?: boolean; maxConsecutiveFailures?: number } = {}): Harness {
  const h: Harness = {
    scheduler: undefined as unknown as WatchScheduler,
    batches: [],
    warnings: [],
    resolvers: [],
    inFlight: 0,
    maxInFlight: 0,
  };
  h.scheduler = new WatchScheduler({
    debounceMs: DEBOUNCE,
    ...(opts.maxConsecutiveFailures !== undefined
      ? { maxConsecutiveFailures: opts.maxConsecutiveFailures }
      : {}),
    onWarn: (m) => h.warnings.push(m),
    onBatch: (paths) => {
      h.batches.push([...paths]);
      h.inFlight++;
      h.maxInFlight = Math.max(h.maxInFlight, h.inFlight);
      return new Promise<void>((resolve, reject) => {
        if (opts.autoResolve !== false) {
          h.inFlight--;
          resolve();
          return;
        }
        h.resolvers.push({
          resolve: () => { h.inFlight--; resolve(); },
          reject: (err) => { h.inFlight--; reject(err); },
        });
      });
    },
  });
  return h;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WatchScheduler', () => {
  it('coalesces rapid events on the same file into one batch entry', async () => {
    const h = makeHarness();

    h.scheduler.notify('a.ts');
    await vi.advanceTimersByTimeAsync(100);
    h.scheduler.notify('a.ts');
    h.scheduler.notify('a.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(h.batches).toEqual([['a.ts']]);
  });

  it('batches distinct files arriving within the debounce window', async () => {
    const h = makeHarness();

    h.scheduler.notify('a.ts');
    h.scheduler.notify('b.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(h.batches).toEqual([['a.ts', 'b.ts']]);
  });

  it('each new event resets the debounce timer', async () => {
    const h = makeHarness();

    h.scheduler.notify('a.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE - 100);
    h.scheduler.notify('b.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE - 100);
    // Neither timer has fully elapsed since its most recent reset.
    expect(h.batches).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(100);
    expect(h.batches).toEqual([['a.ts', 'b.ts']]);
  });

  it('queues events arriving mid-run into a follow-up batch (single-flight)', async () => {
    const h = makeHarness({ autoResolve: false });

    h.scheduler.notify('a.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(h.batches).toEqual([['a.ts']]);

    // Run 1 still in flight — new event must not start an overlapping run.
    h.scheduler.notify('b.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(h.batches).toHaveLength(1);
    expect(h.maxInFlight).toBe(1);

    h.resolvers[0]!.resolve();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(h.batches).toEqual([['a.ts'], ['b.ts']]);
    expect(h.maxInFlight).toBe(1);
  });

  it('requeues the batch with a warning when onBatch fails, then retries', async () => {
    const h = makeHarness({ autoResolve: false });

    h.scheduler.notify('a.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    h.resolvers[0]!.reject(new Error('structure.lock held'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    // Retry carries the same path; the failure was logged, not silent.
    expect(h.batches).toEqual([['a.ts'], ['a.ts']]);
    expect(h.warnings.some((w) => w.includes('structure.lock held'))).toBe(true);

    h.resolvers[1]!.resolve();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(h.batches).toHaveLength(2);
  });

  it('drops the batch with a warning after max consecutive failures', async () => {
    const h = makeHarness({ autoResolve: false, maxConsecutiveFailures: 2 });

    h.scheduler.notify('a.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    h.resolvers[0]!.reject(new Error('boom'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    h.resolvers[1]!.reject(new Error('boom'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);

    // Two attempts, then the batch is dropped — never a third run.
    expect(h.batches).toHaveLength(2);
    expect(h.warnings.some((w) => w.includes('dropping'))).toBe(true);
  });

  it('close() cancels a pending debounce and ignores later notifications', async () => {
    const h = makeHarness();

    h.scheduler.notify('a.ts');
    h.scheduler.close();
    h.scheduler.notify('b.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);

    expect(h.batches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// shouldWatchPath — extension / exclude / state-dir filtering
// ---------------------------------------------------------------------------

describe('shouldWatchPath', () => {
  const filter: WatchPathFilter = {
    projectRoot: '/proj',
    stateDir: '/proj/.mast',
    extensions: ['.ts', '.md'],
    excludeRegexes: [/^(.+\/)?node_modules\/.*$/, /^dist\/.*$/],
  };

  it('accepts a source file with a watched extension', () => {
    expect(shouldWatchPath(filter, '/proj/src/index.ts')).toBe(true);
    expect(shouldWatchPath(filter, '/proj/README.md')).toBe(true);
  });

  it('rejects unwatched extensions', () => {
    expect(shouldWatchPath(filter, '/proj/image.png')).toBe(false);
  });

  it('rejects anything under the state directory (self-trigger loop hazard)', () => {
    expect(shouldWatchPath(filter, '/proj/.mast/graph.db')).toBe(false);
    expect(shouldWatchPath(filter, '/proj/.mast/lance/chunks.ts')).toBe(false);
  });

  it('rejects paths matching exclude patterns', () => {
    expect(shouldWatchPath(filter, '/proj/node_modules/pkg/index.ts')).toBe(false);
    expect(shouldWatchPath(filter, '/proj/dist/out.ts')).toBe(false);
  });

  it('rejects paths outside the project root', () => {
    expect(shouldWatchPath(filter, '/elsewhere/file.ts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// startWatchMode — the chokidar wiring itself (D061)
// ---------------------------------------------------------------------------

/**
 * Until now this function had no test: `WatchScheduler` and `shouldWatchPath`
 * above are pure and were covered, and everything that made them a *watcher*
 * was not. D061 lived in that gap — the watcher starts after `serve` accepts
 * connections and chokidar's initial scan (`ignoreInitial: true`) announced
 * readiness to nobody, so a file created inside that window is treated as
 * pre-existing and fires no event at all. Silence covered three different
 * states: watching, not watching yet, and failed to start.
 */
describe('startWatchMode', () => {
  let dir: string;
  let handles: WatchHandle[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mast-watch-ready-'));
    writeFileSync(join(dir, 'seed.ts'), 'export const seed = 1;\n');
    handles = [];
  });

  afterEach(async () => {
    for (const h of handles) await h.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  function start(options: Partial<StartWatchModeOptions> = {}): WatchHandle {
    const handle = startWatchMode({
      config: resolveConfig({ projectRoot: dir }),
      runBatch: async () => {},
      onWarn: () => {},
      debounceMs: 20,
      ...options,
    });
    handles.push(handle);
    return handle;
  }

  it('announces readiness once the initial scan has finished', async () => {
    let readyCount = 0;
    const ready = new Promise<void>((resolve) => {
      start({ onReady: () => { readyCount++; resolve(); } });
    });

    await expect(ready).resolves.toBeUndefined();
    expect(readyCount).toBe(1);
  }, 20_000);

  /**
   * The point of the signal, not just its existence: an observer that waits for
   * it can create a file and rely on the event arriving. A readiness callback
   * that fired before the scan completed would satisfy the test above and still
   * leave D061 exactly where it was.
   */
  it('delivers events for files created after readiness was announced', async () => {
    const batches: string[][] = [];
    await new Promise<void>((resolve) => {
      start({
        onReady: resolve,
        runBatch: async (paths) => { batches.push([...paths]); },
      });
    });

    writeFileSync(join(dir, 'created-after-ready.ts'), 'export const later = 2;\n');

    // The budget is deliberately far larger than the latency this ever exhibits (delivery is
    // sub-second in isolation). It is not a claim about speed — the assertion is "eventually
    // delivered", and any bound tight enough to fail under load is asserting a latency the
    // test never meant to. At 10 s this failed once in five full-suite runs while passing
    // 3/3 alone: 98 forked test processes starve a chokidar callback for longer than seems
    // plausible, and a flaky pin on a defect fix is worse than none, because the first
    // response to it is to re-run rather than to read (LEDGER D064).
    await vi.waitFor(() => {
      expect(batches.flat().some((p) => p.endsWith('created-after-ready.ts'))).toBe(true);
    }, { timeout: 45_000, interval: 50 });
  }, 60_000);

  it('is optional — a caller that does not want the signal still watches', async () => {
    const batches: string[][] = [];
    start({ runBatch: async (paths) => { batches.push([...paths]); } });

    await vi.waitFor(() => {
      writeFileSync(join(dir, 'no-ready-callback.ts'), 'export const x = 3;\n');
      expect(batches.flat().some((p) => p.endsWith('no-ready-callback.ts'))).toBe(true);
    }, { timeout: 10_000, interval: 100 });
  }, 20_000);
});
