import { extname, relative, resolve } from 'node:path';
import { watch as chokidarWatch } from 'chokidar';
import type { ResolvedConfig } from '../store/config.js';
import { globToRegex } from './walker.js';

// ---------------------------------------------------------------------------
// Debounced single-flight batch scheduler (chokidar-free — unit-testable)
// ---------------------------------------------------------------------------

export interface WatchSchedulerOptions {
  /** Quiet period after the last event before a batch runs (~500ms in prod). */
  readonly debounceMs: number;
  /**
   * Runs one reindex batch. `paths` is the coalesced set of changed files —
   * informational only, since the incremental index run rescans the manifest.
   * A rejection requeues the batch (see `maxConsecutiveFailures`).
   */
  readonly onBatch: (paths: readonly string[]) => Promise<void>;
  /** Warning sink — watcher problems must never crash the MCP server. */
  readonly onWarn: (message: string) => void;
  /**
   * Consecutive failed runs before the batch is dropped (with a warning, never
   * silently). Bounded so a persistently held lock or a broken index cannot
   * retry forever. Default 3, per the repo's three-attempts rule.
   */
  readonly maxConsecutiveFailures?: number;
}

/**
 * Debounce + coalesce + single-flight orchestration for watch mode.
 *
 * - Events within the debounce window collapse into one pending set (a Set,
 *   so rapid saves of the same file are one entry).
 * - Only one `onBatch` runs at a time; events arriving mid-run accumulate and
 *   trigger a follow-up run after the current one settles.
 * - A failed run requeues its paths and warns; after `maxConsecutiveFailures`
 *   the batch is dropped with a warning. JIT staleness handling (§9.0) still
 *   guarantees read correctness, so dropping only delays ranking freshness.
 */
export class WatchScheduler {
  private readonly pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private closed = false;
  private consecutiveFailures = 0;
  private readonly maxConsecutiveFailures: number;

  constructor(private readonly options: WatchSchedulerOptions) {
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
  }

  /** Record a changed path and (re)arm the debounce timer. */
  notify(path: string): void {
    if (this.closed) return;
    this.pending.add(path);
    this.armTimer();
  }

  /** Cancel any pending run; the scheduler accepts no further notifications. */
  close(): void {
    this.closed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private armTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, this.options.debounceMs);
  }

  private async run(): Promise<void> {
    // `running` guard = single-flight: a timer firing mid-run is a no-op; the
    // in-flight run re-arms in `finally` when anything is still pending.
    if (this.running || this.closed || this.pending.size === 0) return;
    this.running = true;

    const batch = [...this.pending];
    this.pending.clear();

    try {
      await this.options.onBatch(batch);
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        this.options.onWarn(
          `[mast] watch: dropping batch of ${batch.length} path(s) after ${this.consecutiveFailures} consecutive failures: ${String(err)}`,
        );
        this.consecutiveFailures = 0;
      } else {
        this.options.onWarn(`[mast] watch: batch failed, requeueing: ${String(err)}`);
        for (const p of batch) this.pending.add(p);
      }
    } finally {
      this.running = false;
      if (this.pending.size > 0 && !this.closed) this.armTimer();
    }
  }
}

// ---------------------------------------------------------------------------
// Path filtering
// ---------------------------------------------------------------------------

export interface WatchPathFilter {
  /** Absolute project root. */
  readonly projectRoot: string;
  /** Absolute state directory — never watched (self-triggering loop hazard). */
  readonly stateDir: string;
  /** Watched file extensions (e.g. ['.ts', '.md']). */
  readonly extensions: readonly string[];
  /** Compiled exclude_patterns, matched against project-relative paths. */
  readonly excludeRegexes: readonly RegExp[];
}

/**
 * True when a filesystem event for `absPath` should feed the scheduler.
 * Mirrors the walker's allowlist/denylist so watch mode indexes exactly the
 * set of files a manual `mast index` run would.
 */
export function shouldWatchPath(filter: WatchPathFilter, absPath: string): boolean {
  if (absPath === filter.stateDir || absPath.startsWith(`${filter.stateDir}/`)) return false;
  if (!filter.extensions.includes(extname(absPath))) return false;
  const rel = relative(filter.projectRoot, absPath);
  if (rel.startsWith('..')) return false;
  return !filter.excludeRegexes.some((rx) => rx.test(rel));
}

// ---------------------------------------------------------------------------
// Chokidar adapter (thin — logic above is what's unit-tested)
// ---------------------------------------------------------------------------

export interface WatchHandle {
  close(): Promise<void>;
}

export interface StartWatchModeOptions {
  readonly config: ResolvedConfig;
  /** One incremental Phase 1 + embed run; supplied by the serve lifecycle. */
  readonly runBatch: (paths: readonly string[]) => Promise<void>;
  readonly onWarn: (message: string) => void;
  /**
   * Called once, when chokidar has finished its initial scan and is actually
   * delivering events.
   *
   * The watcher starts AFTER `serve` accepts MCP connections, and it is
   * constructed with `ignoreInitial: true` — correct, since the startup ladder
   * has already indexed the tree, but it means a file created before the scan
   * finishes is treated as pre-existing and fires no event at all. Without this
   * callback nothing outside the process could tell that window apart from
   * "watching, nothing has changed" or from "the watcher failed to start": the
   * EMFILE path warns, and the success path was silent, so silence meant three
   * different things (D061).
   *
   * Optional. A caller that does not want the signal still gets a watcher.
   */
  readonly onReady?: () => void;
  /** Override for tests; production default 500ms. */
  readonly debounceMs?: number;
}

/**
 * Start `--watch` mode: a chokidar watcher over the project feeding the
 * debounced scheduler. May throw on construction (e.g. EMFILE) — callers must
 * catch and degrade to serving without watch, never crash the server.
 */
export function startWatchMode(options: StartWatchModeOptions): WatchHandle {
  const { config } = options;
  const filter: WatchPathFilter = {
    projectRoot: config.resolved_project_root,
    stateDir: config.resolved_state_dir,
    extensions: config.file_extensions,
    excludeRegexes: config.exclude_patterns.map(globToRegex),
  };

  const scheduler = new WatchScheduler({
    debounceMs: options.debounceMs ?? 500,
    onBatch: options.runBatch,
    onWarn: options.onWarn,
  });

  const watcher = chokidarWatch(config.resolved_project_root, {
    // The startup ladder already reindexed — only future changes matter.
    ignoreInitial: true,
    // Prune ignored subtrees at the directory level so chokidar never descends
    // into node_modules/ or the state dir. Files are re-checked (with the
    // extension allowlist) in shouldWatchPath; `rel + '/'` lets patterns like
    // `**/node_modules/**` match the directory itself, not just its contents.
    ignored: (path: string) => {
      const abs = resolve(path);
      if (abs === filter.stateDir || abs.startsWith(`${filter.stateDir}/`)) return true;
      const rel = relative(filter.projectRoot, abs);
      if (rel === '' || rel.startsWith('..')) return false;
      return filter.excludeRegexes.some((rx) => rx.test(rel) || rx.test(`${rel}/`));
    },
  });

  // `unlink` feeds the same incremental run: deleted files are cleaned up by
  // the index run's manifest diff (removeDeletedFiles), not reimplemented here.
  watcher.on('add', (path) => { if (shouldWatchPath(filter, resolve(path))) scheduler.notify(path); });
  watcher.on('change', (path) => { if (shouldWatchPath(filter, resolve(path))) scheduler.notify(path); });
  watcher.on('unlink', (path) => { if (shouldWatchPath(filter, resolve(path))) scheduler.notify(path); });
  // Fires after the initial scan completes; from here on, a created file
  // produces an `add`. A construction failure (EMFILE, permissions) throws out
  // of `chokidarWatch` above and never reaches this line, so `onReady` cannot
  // announce a watcher that failed to start — the caller's catch handles that
  // case. Handler registration order is NOT what provides that guarantee, and a
  // runtime `error` after a successful scan does not un-fire `ready`: this
  // signal means "the initial scan finished", not "the watcher is healthy".
  watcher.on('ready', () => { options.onReady?.(); });
  watcher.on('error', (err) => {
    // Watcher errors (EMFILE, EPERM, …) degrade to no-watch; JIT staleness
    // handling keeps reads correct, so serving continues.
    options.onWarn(`[mast] watch: watcher error (continuing without event): ${String(err)}`);
  });

  return {
    close: async () => {
      scheduler.close();
      await watcher.close();
    },
  };
}
