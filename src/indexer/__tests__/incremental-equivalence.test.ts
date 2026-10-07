import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { SCENARIOS, type Scenario } from './equivalence-scenarios.js';
import {
  editFile,
  expectGraphEqualsFullIndex,
  indexFull,
  indexIncremental,
  makeProject,
  writeFiles,
} from './graph-fixture.js';

// ---------------------------------------------------------------------------
// T2 — after an incremental run the graph equals a full index of the same
// tree (D081, D084; adr/proposals/incremental-graph-correctness).
//
// Each round of a scenario in equivalence-scenarios.ts is followed by an
// incremental run and the comparison.
// ---------------------------------------------------------------------------


describe('the graph after an incremental run equals a full index', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeProject('incremental-equivalence');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(scenario: Scenario): Promise<void> {
    writeFiles(dir, scenario.files);
    await indexFull(dir);

    for (const round of scenario.rounds) {
      for (const [relativePath, content] of Object.entries(round)) {
        if (content === null) rmSync(join(dir, relativePath));
        else editFile(dir, relativePath, content);
      }
      await indexIncremental(dir);

      await expectGraphEqualsFullIndex(dir);
    }
  }

  it.each(SCENARIOS.filter((scenario) => scenario.openDefect === undefined))('when $name', run);
  it.fails.each(SCENARIOS.filter((scenario) => scenario.openDefect !== undefined))('not yet, $openDefect: when $name', run);
});
