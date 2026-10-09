import { lstatSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { watch as chokidarWatch } from 'chokidar';
import type { ResolvedConfig } from '../store/config.js';
import { globToRegex } from './walker.js';
import { isDirectoryInDotScope, isFileInDotScope, stateDirBelowRoot } from './scope.js';

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
  /** Normalised `include_dot_dirs`: the only dot directories in scope. */
  readonly dotDirs: readonly string[];
}

/**
 * True when `rel`, a `relative(projectRoot, path)` result, leaves the project.
 * It leaves only through a leading `..` segment: a directory named `..scratch`
 * also starts with two dots and is inside the root.
 */
function leavesRoot(rel: string): boolean {
  return rel === '..' || rel.startsWith('../') || rel.startsWith('/');
}

/**
 * True for the state directory and everything in it, when the state directory
 * is below the project root. The walker applies the same rule
 * (`stateDirBelowRoot`): a state directory that is the root or contains it
 * holds every source file, and excluding it would stop watch mode silently.
 */
function isInStateDir(filter: WatchPathFilter, absPath: string): boolean {
  if (stateDirBelowRoot(filter.projectRoot, filter.stateDir) === null) return false;
  return absPath === filter.stateDir || absPath.startsWith(`${filter.stateDir}/`);
}

/**
 * True when a filesystem event for `absPath` should feed the scheduler.
 * Mirrors the walker's allowlist/denylist so watch mode indexes exactly the
 * set of files a manual `mast index` run would.
 */
export function shouldWatchPath(filter: WatchPathFilter, absPath: string): boolean {
  if (isInStateDir(filter, absPath)) return false;
  if (!filter.extensions.includes(extname(absPath))) return false;
  const rel = relative(filter.projectRoot, absPath);
  if (leavesRoot(rel)) return false;
  if (!isFileInDotScope(rel, filter.dotDirs)) return false;
  return !filter.excludeRegexes.some((rx) => rx.test(rel));
}

// ---------------------------------------------------------------------------
// Chokidar adapter (thin — logic above is what's unit-tested)
// ---------------------------------------------------------------------------

/** One directory entry, reduced to what reconciliation needs. */
export interface ListedEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  /** False for a directory and for a symbolic link, whatever the link points at. */
  readonly isFile: boolean;
}

export interface UnwatchedEntries {
  /** Every unknown file, including those inside unknown directories. */
  readonly files: readonly string[];
  /** Every unknown directory, at any depth. */
  readonly directories: readonly string[];
  /**
   * The unknown entries whose parent the watcher already knows: handing these to
   * the watcher is enough, because it descends into a directory by itself.
   */
  readonly roots: readonly string[];
  /** Directories that could not be listed (vanished, EACCES); the rest was still scanned. */
  readonly failures: ReadonlyArray<{ readonly directory: string; readonly error: unknown }>;
}

export interface FindUnwatchedInput {
  /** chokidar's `getWatched()`: absolute directory -> names of its children, files and directories alike. */
  readonly watched: Readonly<Record<string, readonly string[]>>;
  readonly projectRoot: string;
  readonly listDirectory: (directory: string) => Promise<readonly ListedEntry[]>;
  /**
   * The same rule the watcher was constructed with, applied to files and directories.
   * `isFile` is the entry's own type, so a file can be out of scope by its extension
   * while a directory or a link of the same name is not.
   */
  readonly isIgnored: (absPath: string, isFile: boolean) => boolean;
  /** Checked between directories, so a closed watcher stops walking a large tree. */
  readonly signal?: AbortSignal;
}

function isInsideRoot(projectRoot: string, directory: string): boolean {
  const rel = relative(projectRoot, directory);
  return rel === '' || !leavesRoot(rel);
}

/**
 * Finds what is on disk but unknown to the watcher (D067). Pure over its inputs:
 * `watched` is a snapshot and `listDirectory` is the only I/O.
 *
 * Only directories at or under `projectRoot` are listed: chokidar records the root
 * itself as a child of the root's parent, and that parent is not ours to scan.
 * A file the watcher learns about between the snapshot and the listing is reported
 * too; that is a redundant notification, which the incremental reindex absorbs.
 * Symbolic links are listed as files and never followed, so a link cycle cannot loop.
 */
export async function findUnwatchedEntries(input: FindUnwatchedInput): Promise<UnwatchedEntries> {
  const files: string[] = [];
  const directories: string[] = [];
  const roots: string[] = [];
  const failures: Array<{ directory: string; error: unknown }> = [];

  const list = async (directory: string): Promise<readonly ListedEntry[]> => {
    try {
      return await input.listDirectory(directory);
    } catch (error) {
      failures.push({ directory, error });
      return [];
    }
  };

  // Everything below an unknown directory is unknown too, so it is walked in full.
  const walkUnknown = async (directory: string): Promise<void> => {
    if (input.signal?.aborted === true) return;
    for (const entry of await list(directory)) {
      const abs = join(directory, entry.name);
      if (input.isIgnored(abs, entry.isFile)) continue;
      if (entry.isDirectory) {
        directories.push(abs);
        await walkUnknown(abs);
      } else {
        files.push(abs);
      }
    }
  };

  for (const [directory, children] of Object.entries(input.watched)) {
    if (input.signal?.aborted === true) break;
    if (!isInsideRoot(input.projectRoot, directory)) continue;
    const known = new Set(children);
    for (const entry of await list(directory)) {
      if (known.has(entry.name)) continue;
      const abs = join(directory, entry.name);
      if (input.isIgnored(abs, entry.isFile)) continue;
      roots.push(abs);
      if (entry.isDirectory) {
        directories.push(abs);
        await walkUnknown(abs);
      } else {
        files.push(abs);
      }
    }
  }

  return { files, directories, roots, failures };
}

async function listDirectoryOnDisk(directory: string): Promise<readonly ListedEntry[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }));
}

/** Resolves true after `ms`, or false at once if `signal` aborts first. */
function delay(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(false); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(true); }, ms);
    const onAbort = (): void => { clearTimeout(timer); resolve(false); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The members of chokidar's `FSWatcher` that `startWatchMode` uses. */
export interface FsWatcher {
  onFileEvent(event: 'add' | 'change' | 'unlink', listener: (path: string) => void): void;
  onReady(listener: () => void): void;
  onError(listener: (err: unknown) => void): void;
  getWatched(): Record<string, string[]>;
  add(paths: readonly string[]): unknown;
  close(): Promise<void>;
}

export interface FsWatcherOptions {
  readonly ignoreInitial: true;
  /**
   * chokidar asks about a path before it has read its type and again after;
   * `stats` is absent the first time.
   */
  readonly ignored: (path: string, stats?: { isFile(): boolean }) => boolean;
}

export type FsWatcherFactory = (root: string, options: FsWatcherOptions) => FsWatcher;

export interface WatchHandle {
  close(): Promise<void>;
}

export interface StartWatchModeOptions {
  readonly config: ResolvedConfig;
  /** One incremental Phase 1 + embed run; supplied by the serve lifecycle. */
  readonly runBatch: (paths: readonly string[]) => Promise<void>;
  readonly onWarn: (message: string) => void;
  /**
   * Called once, after chokidar's initial scan, a settle period of `settleMs`, and
   * one reconciliation pass over the directories chokidar is watching (D067).
   * It means: every file that existed when the pass ran has been accounted for
   * (queued for reindex if chokidar had not seen it), and the OS watch has had
   * `settleMs` to go live. It is never called after `close()`.
   *
   * What it does not mean: chokidar's own `ready` fires before the OS watch is
   * delivering, and a file created in that gap produces no event at all. The
   * reconciliation pass recovers files created up to the moment it ran; a watch
   * that goes live later than `settleMs` after `ready` is still a gap, and nothing
   * here proves liveness. Each directory has its own OS watch, so a sentinel file
   * would prove one directory only.
   *
   * Before D067 this fired straight from chokidar's `ready`, and under CPU load 12
   * of 550 files written immediately after it were lost, against 0 of 400 written
   * 300 ms after it.
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
  /**
   * Wait between chokidar's `ready` and the reconciliation pass; production
   * default 1000 ms. Measured under load (D067): 0 of 400 files lost when written
   * 300 ms after `ready`; 1000 ms is a margin over that, not a measured bound.
   */
  readonly settleMs?: number;
  /** Test seam; production uses chokidar. */
  readonly watcherFactory?: FsWatcherFactory;
  /** Whether a path is itself a symbolic link. Production asks the disk. */
  readonly isSymbolicLink?: (absPath: string) => boolean;
}

/**
 * True when `absPath` is itself a symbolic link. A path that cannot be read is
 * not one: chokidar asks about paths that have just been deleted, and the
 * rules that follow this one still apply to them.
 */
function isSymbolicLinkOnDisk(absPath: string): boolean {
  try {
    return lstatSync(absPath).isSymbolicLink();
  } catch {
    return false;
  }
}

const defaultWatcherFactory: FsWatcherFactory = (root, opts) => {
  const fsw = chokidarWatch(root, opts);
  return {
    onFileEvent: (event, listener) => { fsw.on(event, listener); },
    onReady: (listener) => { fsw.on('ready', listener); },
    onError: (listener) => { fsw.on('error', listener); },
    getWatched: () => fsw.getWatched(),
    add: (paths) => fsw.add([...paths]),
    close: () => fsw.close(),
  };
};

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
    dotDirs: config.include_dot_dirs,
  };

  const scheduler = new WatchScheduler({
    debounceMs: options.debounceMs ?? 500,
    onBatch: options.runBatch,
    onWarn: options.onWarn,
  });

  // Prune ignored subtrees at the directory level so chokidar never descends
  // into node_modules/ or the state dir. `rel + '/'` lets patterns like
  // `**/node_modules/**` match the directory itself, not just its contents.
  // Shared with reconciliation so both agree on what is out of scope.
  //
  // A file that would never be indexed is out of scope too (D158): chokidar
  // holds an open file for every file it watches, for as long as it runs, and
  // a watch of this repository held 1,026 of them for 219 indexed files. Only
  // a path known to be a file is judged by its extension, because a directory
  // can be named `icons.png`.
  const isSymbolicLink = options.isSymbolicLink ?? isSymbolicLinkOnDisk;
  const isIgnored = (path: string, isFile: boolean): boolean => {
    const abs = resolve(path);
    const rel = relative(filter.projectRoot, abs);
    const isBelowRoot = rel !== '' && !leavesRoot(rel);
    // The walk follows no symbolic link, so nothing reached through one is
    // indexed, and chokidar follows them all: the files of a linked directory
    // were watched and held open for nothing (D160). The root itself may be a
    // link and is still the project. chokidar's own `followSymlinks: false`
    // is not the fix: a root that is a link is then watched as a link, and no
    // change under it is seen.
    if (isBelowRoot && isSymbolicLink(abs)) return true;
    if (isFile) return !shouldWatchPath(filter, abs);
    if (isInStateDir(filter, abs)) return true;
    if (!isBelowRoot) return false;
    // A dot directory nobody named is pruned like an excluded one. Before
    // ADR 018 chokidar descended into all of them (`.git` included) and every
    // event there started an index run that walked none of those files.
    if (!isDirectoryInDotScope(rel, filter.dotDirs)) return true;
    return filter.excludeRegexes.some((rx) => rx.test(rel) || rx.test(`${rel}/`));
  };

  const watcher = (options.watcherFactory ?? defaultWatcherFactory)(config.resolved_project_root, {
    // The startup ladder already reindexed — only future changes matter.
    ignoreInitial: true,
    ignored: (path, stats) => isIgnored(path, stats?.isFile() === true),
  });

  // Aborted by `close()`; cancels the settle wait and the reconciliation walk.
  const closing = new AbortController();

  const reconcile = async (): Promise<void> => {
    let found: UnwatchedEntries;
    try {
      found = await findUnwatchedEntries({
        watched: watcher.getWatched(),
        projectRoot: filter.projectRoot,
        listDirectory: listDirectoryOnDisk,
        isIgnored,
        signal: closing.signal,
      });
    } catch (err) {
      options.onWarn(`[mast] watch: reconciliation failed (continuing): ${String(err)}`);
      return;
    }
    if (closing.signal.aborted) return;
    for (const failure of found.failures) {
      options.onWarn(
        `[mast] watch: reconciliation could not list ${failure.directory} (continuing): ${String(failure.error)}`,
      );
    }
    for (const file of found.files) {
      if (shouldWatchPath(filter, file)) scheduler.notify(file);
    }
    // `add` under `ignoreInitial: true` emits no `add` events (chokidar handler.js:
    // `_addToNodeFs(path, !_internal, ...)` makes this an initial add), so the files
    // notified above are not delivered twice. It is what makes later changes inside
    // a missed directory visible.
    if (found.roots.length > 0) watcher.add(found.roots);
  };

  const announceReadiness = async (): Promise<void> => {
    if (!(await delay(options.settleMs ?? 1000, closing.signal))) return;
    await reconcile();
    if (closing.signal.aborted) return;
    options.onReady?.();
  };

  // `unlink` feeds the same incremental run: deleted files are cleaned up by
  // the index run's manifest diff (removeDeletedFiles), not reimplemented here.
  watcher.onFileEvent('add', (path) => { if (shouldWatchPath(filter, resolve(path))) scheduler.notify(path); });
  watcher.onFileEvent('change', (path) => { if (shouldWatchPath(filter, resolve(path))) scheduler.notify(path); });
  watcher.onFileEvent('unlink', (path) => { if (shouldWatchPath(filter, resolve(path))) scheduler.notify(path); });
  // chokidar's `ready` only says its initial scan finished; the OS watch may not be
  // delivering yet, and a file created in that gap fires no event (D067). So
  // readiness is announced after a settle period and a reconciliation pass, see
  // `onReady`. A construction failure (EMFILE, permissions) throws out of the
  // factory above and never reaches this line, so `onReady` cannot announce a
  // watcher that failed to start. A runtime `error` after a successful scan does
  // not un-fire it: the signal is not "the watcher is healthy".
  watcher.onReady(() => {
    announceReadiness().catch((err: unknown) => {
      options.onWarn(`[mast] watch: readiness announcement failed: ${String(err)}`);
    });
  });
  watcher.onError((err) => {
    // Watcher errors (EMFILE, EPERM, …) degrade to no-watch; JIT staleness
    // handling keeps reads correct, so serving continues.
    options.onWarn(`[mast] watch: watcher error (continuing without event): ${String(err)}`);
  });

  return {
    close: async () => {
      closing.abort();
      scheduler.close();
      await watcher.close();
    },
  };
}
