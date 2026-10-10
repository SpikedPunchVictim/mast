/** What `leaveWhenWorkIsDone` needs from the process it ends. */
export interface ShutdownDeps {
  /** Stops the watcher's work without closing its OS watches. */
  stopWatching(): Promise<void>;
  /** True while an index run of this process has not returned. */
  isIndexing(): boolean;
  /** Resolves a short while later; how long is the caller's choice. */
  wait(): Promise<void>;
  /**
   * Closes the index database. A process that runs dry closes it and leaves no
   * `graph.db-wal` behind; one ended by `exit` does not, unless it is asked to.
   */
  closeIndex(): Promise<void>;
  /** Told what failed on the way out; the exit goes ahead. */
  warn(message: string): void;
  exit(code: number): void;
}

/**
 * Ends a server whose client has gone: stops the watcher, lets an index run
 * that is under way finish, closes the index, then exits. Never rejects.
 *
 * The runs waited for are the startup run, a watch batch and a `mast_reindex`
 * call. Any other tool call still being answered is cut off: its client is
 * gone, and what it writes to the index is one transaction.
 *
 * The process is ended by `exit` because the watches are still open. Closing
 * them is what took `mast serve` 22 to 25 s to leave nest (D161), and a process
 * whose event loop runs dry with them open pays the same at exit.
 *
 * An index run is waited for, as it was when the process ended by running dry.
 * Cut off, it leaves the index behind the files, or empty after a start that
 * cleared it for a new schema, with exit code 0 (found by review: a client
 * gone 300 ms after the start, while the run was still walking the project).
 */
export async function leaveWhenWorkIsDone(deps: ShutdownDeps): Promise<void> {
  try {
    await deps.stopWatching();
  } catch (err) {
    deps.warn(`[mast] shutdown: the watcher did not stop: ${String(err)}`);
  }
  while (deps.isIndexing()) await deps.wait();
  try {
    await deps.closeIndex();
  } catch (err) {
    // The next process reads it through the WAL that is left.
    deps.warn(`[mast] shutdown: the index did not close: ${String(err)}`);
  }
  deps.exit(0);
}
