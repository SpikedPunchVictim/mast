import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../../store/config.js';
import {
  WatchScheduler, shouldWatchPath, startWatchMode, findUnwatchedEntries,
  type WatchPathFilter, type WatchHandle, type StartWatchModeOptions,
  type FsWatcher, type ListedEntry,
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

describe('WatchScheduler', () => {
  // Scoped here, not file-wide: `startWatchMode` now waits on a real settle timer
  // before announcing readiness, and a test awaiting `onReady` hangs under fake timers.
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
    dotDirs: ['.agents'],
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

  it('rejects a file in a dot directory that include_dot_dirs does not name', () => {
    expect(shouldWatchPath(filter, '/proj/.history/src/index.ts')).toBe(false);
  });

  it('accepts a file in a dot directory that include_dot_dirs names', () => {
    expect(shouldWatchPath(filter, '/proj/.agents/notes/plan.md')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findUnwatchedEntries — which on-disk entries chokidar does not know (D067)
// ---------------------------------------------------------------------------

describe('findUnwatchedEntries', () => {
  const root = '/proj';

  /** In-memory disk: directory -> entries. A missing key rejects like ENOENT. */
  function fakeDisk(tree: Record<string, readonly ListedEntry[]>) {
    return async (directory: string): Promise<readonly ListedEntry[]> => {
      const entries = tree[directory];
      if (entries === undefined) throw new Error(`ENOENT: ${directory}`);
      return entries;
    };
  }
  const file = (name: string): ListedEntry => ({ name, isDirectory: false });
  const dir = (name: string): ListedEntry => ({ name, isDirectory: true });
  const notIgnored = (): boolean => false;

  it('reports a file that is on disk but unknown to the watcher', async () => {
    const result = await findUnwatchedEntries({
      watched: { '/proj': ['known.ts'] },
      projectRoot: root,
      listDirectory: fakeDisk({ '/proj': [file('known.ts'), file('missed.ts')] }),
      isIgnored: notIgnored,
    });

    expect(result.files).toEqual(['/proj/missed.ts']);
  });

  it('does not report a file the watcher already knows', async () => {
    const result = await findUnwatchedEntries({
      watched: { '/proj': ['known.ts'] },
      projectRoot: root,
      listDirectory: fakeDisk({ '/proj': [file('known.ts')] }),
      isIgnored: notIgnored,
    });

    expect(result.files).toEqual([]);
  });

  it('reports an unknown directory and the files inside it, handing only the directory to the watcher', async () => {
    const result = await findUnwatchedEntries({
      watched: { '/proj': [] },
      projectRoot: root,
      listDirectory: fakeDisk({
        '/proj': [dir('newdir')],
        '/proj/newdir': [file('a.ts'), dir('deep')],
        '/proj/newdir/deep': [file('b.ts')],
      }),
      isIgnored: notIgnored,
    });

    expect({ files: result.files, directories: result.directories, roots: result.roots }).toEqual({
      files: ['/proj/newdir/a.ts', '/proj/newdir/deep/b.ts'],
      directories: ['/proj/newdir', '/proj/newdir/deep'],
      roots: ['/proj/newdir'],
    });
  });

  it('skips ignored entries, and does not descend into an ignored directory', async () => {
    const result = await findUnwatchedEntries({
      watched: { '/proj': [] },
      projectRoot: root,
      listDirectory: fakeDisk({
        '/proj': [dir('node_modules'), file('skip.ts'), file('keep.ts')],
        // No entry for node_modules: descending would reject and surface as a failure.
      }),
      isIgnored: (p) => p === '/proj/node_modules' || p === '/proj/skip.ts',
    });

    expect({ files: result.files, failures: result.failures.length }).toEqual({
      files: ['/proj/keep.ts'],
      failures: 0,
    });
  });

  it('ignores watched directories outside the project root (chokidar tracks the root inside its parent)', async () => {
    const result = await findUnwatchedEntries({
      watched: { '/': ['proj', 'other'], '/proj': [] },
      projectRoot: root,
      listDirectory: fakeDisk({ '/': [dir('proj'), dir('other')], '/proj': [] }),
      isIgnored: notIgnored,
    });

    expect(result.roots).toEqual([]);
  });

  it('records a directory that cannot be listed and still reports what the others held', async () => {
    const result = await findUnwatchedEntries({
      watched: { '/proj': [], '/proj/gone': [] },
      projectRoot: root,
      listDirectory: fakeDisk({ '/proj': [file('missed.ts')] }),
      isIgnored: notIgnored,
    });

    expect({ files: result.files, failed: result.failures.map((f) => f.directory) }).toEqual({
      files: ['/proj/missed.ts'],
      failed: ['/proj/gone'],
    });
  });

  it('lists nothing once its signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let listed = 0;

    await findUnwatchedEntries({
      watched: { '/proj': [] },
      projectRoot: root,
      listDirectory: async () => { listed++; return []; },
      isIgnored: notIgnored,
      signal: controller.signal,
    });

    expect(listed).toBe(0);
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

// ---------------------------------------------------------------------------
// startWatchMode against a fake watcher — the D067 gap, made deterministic
// ---------------------------------------------------------------------------

/**
 * D067: chokidar's `ready` fires before the OS watch delivers events, so a file
 * created just after it can produce no event at all. Real chokidar loses that race
 * about 2% of the time under load, which no test can pin. This fake never emits
 * `add`, i.e. it loses the race every time.
 */
class FakeWatcher implements FsWatcher {
  watched: Record<string, string[]> = {};
  readonly added: string[][] = [];
  closeCount = 0;
  private readyListeners: Array<() => void> = [];

  onFileEvent(): void {}
  onError(): void {}
  onReady(listener: () => void): void { this.readyListeners.push(listener); }
  getWatched(): Record<string, string[]> { return this.watched; }
  add(paths: readonly string[]): void { this.added.push([...paths]); }
  async close(): Promise<void> { this.closeCount++; }
  emitReady(): void { for (const l of this.readyListeners) l(); }
}

/**
 * The predicate handed to chokidar decides which directories get an OS watch at
 * all. It has to agree with the walker: a directory the walker enters and the
 * watcher prunes is a file that changes without the index hearing about it.
 */
describe('startWatchMode — which directories it asks chokidar to ignore', () => {
  let dir: string;
  let handle: WatchHandle | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mast-watch-dot-'));
  });

  afterEach(async () => {
    await handle?.close().catch(() => {});
    handle = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function ignoredPredicate(includeDotDirs: readonly string[]): (path: string) => boolean {
    writeFileSync(join(dir, 'mast.config.json'), JSON.stringify({ include_dot_dirs: includeDotDirs }));
    let ignored: ((path: string) => boolean) | undefined;
    handle = startWatchMode({
      config: resolveConfig({ projectRoot: dir }),
      runBatch: async () => {},
      onWarn: () => {},
      watcherFactory: (_root, opts) => { ignored = opts.ignored; return new FakeWatcher(); },
    });
    if (ignored === undefined) throw new Error('the watcher factory was not called');
    return ignored;
  }

  it('ignores a dot directory that include_dot_dirs does not name', () => {
    const ignored = ignoredPredicate(['.agents']);

    expect(ignored(join(dir, '.git'))).toBe(true);
  });

  it('descends into a dot directory that include_dot_dirs names', () => {
    const ignored = ignoredPredicate(['.agents']);

    expect(ignored(join(dir, '.agents'))).toBe(false);
    expect(ignored(join(dir, '.agents', 'notes', 'plan.md'))).toBe(false);
  });

  it('descends into the dot-leading parent of a named subdirectory', () => {
    const ignored = ignoredPredicate(['.github/workflows']);

    expect(ignored(join(dir, '.github'))).toBe(false);
    expect(ignored(join(dir, '.github', 'actions'))).toBe(true);
  });

  it('still descends into ordinary directories', () => {
    const ignored = ignoredPredicate([]);

    expect(ignored(join(dir, 'src'))).toBe(false);
  });
});

describe('startWatchMode with a watcher that loses events', () => {
  let dir: string;
  let handles: WatchHandle[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mast-watch-gap-'));
    writeFileSync(join(dir, 'seed.ts'), 'export const seed = 1;\n');
    handles = [];
  });

  afterEach(async () => {
    for (const h of handles) await h.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  function startWithFake(fake: FakeWatcher, options: Partial<StartWatchModeOptions> = {}): WatchHandle {
    const handle = startWatchMode({
      config: resolveConfig({ projectRoot: dir }),
      runBatch: async () => {},
      onWarn: () => {},
      debounceMs: 5,
      settleMs: 100,
      watcherFactory: () => fake,
      ...options,
    });
    handles.push(handle);
    return handle;
  }

  it('queues a file created in the gap before announcing readiness', async () => {
    const fake = new FakeWatcher();
    fake.watched = { [dir]: ['seed.ts'] };
    const batches: string[][] = [];
    let addedWhenReady: string[][] = [];
    const ready = new Promise<void>((resolve) => {
      startWithFake(fake, {
        runBatch: async (paths) => { batches.push([...paths]); },
        onReady: () => { addedWhenReady = fake.added.map((a) => [...a]); resolve(); },
      });
    });

    fake.emitReady();
    writeFileSync(join(dir, 'created-in-gap.ts'), 'export const gap = 1;\n');
    await ready;

    await vi.waitFor(() => {
      expect(batches.flat().map((p) => p.split('/').pop())).toEqual(['created-in-gap.ts']);
    }, { timeout: 3_000, interval: 10 });
    expect(addedWhenReady.flat().map((p) => p.split('/').pop())).toEqual(['created-in-gap.ts']);
  });

  it('does not announce readiness before settleMs has elapsed', async () => {
    const fake = new FakeWatcher();
    fake.watched = { [dir]: ['seed.ts'] };
    let elapsed = -1;
    const ready = new Promise<void>((resolve) => {
      startWithFake(fake, { settleMs: 200, onReady: () => { elapsed = performance.now() - t0; resolve(); } });
    });

    const t0 = performance.now();
    fake.emitReady();
    await ready;

    // 5 ms of slack for timer granularity; lateness (load) only makes elapsed larger.
    expect(elapsed).toBeGreaterThanOrEqual(195);
  });

  it('never announces readiness or queues anything when closed during the settle period', async () => {
    const fake = new FakeWatcher();
    fake.watched = { [dir]: ['seed.ts'] };
    const batches: string[][] = [];
    let readyCount = 0;
    const handle = startWithFake(fake, {
      settleMs: 100,
      runBatch: async (paths) => { batches.push([...paths]); },
      onReady: () => { readyCount++; },
    });

    fake.emitReady();
    writeFileSync(join(dir, 'created-in-gap.ts'), 'export const gap = 1;\n');
    await handle.close();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect({ readyCount, batches, added: fake.added }).toEqual({ readyCount: 0, batches: [], added: [] });
  });

  it('warns and still announces readiness when a watched directory cannot be listed', async () => {
    const fake = new FakeWatcher();
    fake.watched = { [dir]: ['seed.ts'], [join(dir, 'vanished')]: [] };
    const warnings: string[] = [];
    const ready = new Promise<void>((resolve) => {
      startWithFake(fake, { onWarn: (m) => warnings.push(m), onReady: resolve });
    });

    fake.emitReady();
    await ready;

    expect(warnings.some((w) => w.includes('vanished'))).toBe(true);
  });

  it('hands a directory created in the gap to the watcher and queues the files inside it', async () => {
    const fake = new FakeWatcher();
    fake.watched = { [dir]: ['seed.ts'] };
    const batches: string[][] = [];
    const ready = new Promise<void>((resolve) => {
      startWithFake(fake, {
        runBatch: async (paths) => { batches.push([...paths]); },
        onReady: resolve,
      });
    });

    fake.emitReady();
    mkdirSync(join(dir, 'newdir'));
    writeFileSync(join(dir, 'newdir', 'inside.ts'), 'export const inside = 1;\n');
    await ready;

    await vi.waitFor(() => {
      expect(batches.flat().map((p) => p.split('/').pop())).toEqual(['inside.ts']);
    }, { timeout: 3_000, interval: 10 });
    expect(fake.added).toEqual([[join(dir, 'newdir')]]);
  });
});
