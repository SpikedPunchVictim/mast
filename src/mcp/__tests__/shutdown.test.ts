import { describe, it, expect } from 'vitest';
import { leaveWhenWorkIsDone } from '../shutdown.js';

/** A promise and the function that resolves it. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('leaveWhenWorkIsDone', () => {
  it('exits only after the watcher has stopped and no index run is left', async () => {
    const events: string[] = [];
    const stopped = deferred();
    let runs = 2;
    const leaving = leaveWhenWorkIsDone({
      stopWatching: async () => { await stopped.promise; events.push('stopped'); },
      isIndexing: () => runs > 0,
      wait: async () => { events.push(`waited with ${runs} run(s)`); runs--; },
      closeIndex: async () => { events.push('index closed'); },
      warn: (message) => { events.push(message); },
      exit: (code) => { events.push(`exit ${code}`); },
    });

    await Promise.resolve();
    const beforeStop = [...events];
    stopped.resolve();
    await leaving;

    expect({ beforeStop, events }).toEqual({
      beforeStop: [],
      events: ['stopped', 'waited with 2 run(s)', 'waited with 1 run(s)', 'index closed', 'exit 0'],
    });
  });

  it('still exits, and says why, when stopping the watcher and closing the index both fail', async () => {
    const events: string[] = [];

    await leaveWhenWorkIsDone({
      stopWatching: async () => { throw new Error('stop failed'); },
      isIndexing: () => false,
      wait: async () => {},
      closeIndex: async () => { throw new Error('close failed'); },
      warn: (message) => { events.push(message); },
      exit: (code) => { events.push(`exit ${code}`); },
    });

    expect(events).toEqual([
      '[mast] shutdown: the watcher did not stop: Error: stop failed',
      '[mast] shutdown: the index did not close: Error: close failed',
      'exit 0',
    ]);
  });
});
