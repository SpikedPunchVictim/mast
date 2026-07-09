import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WatchScheduler, shouldWatchPath, type WatchPathFilter } from '../watcher.js';

// ---------------------------------------------------------------------------
// WatchScheduler — debounce / coalesce / single-flight (fake timers, no chokidar)
// ---------------------------------------------------------------------------

const DEBOUNCE = 500;

interface Harness {
  readonly scheduler: WatchScheduler;
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
