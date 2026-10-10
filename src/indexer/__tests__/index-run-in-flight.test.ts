import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { runIndex, isIndexRunInFlight } from '../index.js';
import { configFor, makeProject, writeFiles } from './graph-fixture.js';

// `mast serve` asks this before it ends the process (D161). A run takes and
// releases the structure lock several times and walks the project before the
// first, so "a lock is held" is not the question.
describe('isIndexRunInFlight', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeProject('run-in-flight');
    writeFiles(dir, { 'src/a.ts': 'export const a = 1;\n' });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is true from the call of a run until it has returned', async () => {
    const before = isIndexRunInFlight();
    const run = runIndex(configFor(dir), { incremental: false });
    const atTheCall = isIndexRunInFlight();
    await new Promise((resolve) => setImmediate(resolve));
    const duringTheWalk = isIndexRunInFlight();

    await run;

    expect({ before, atTheCall, duringTheWalk, after: isIndexRunInFlight() }).toEqual({
      before: false, atTheCall: true, duringTheWalk: true, after: false,
    });
  });

  it('is false again after a run that threw', async () => {
    const config = { ...configFor(dir), resolved_state_dir: `${dir}/src/a.ts/not-a-directory` };

    await expect(runIndex(config, { incremental: false })).rejects.toThrow();

    expect(isIndexRunInFlight()).toBe(false);
  });
});
