import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { generateScenario } from './generated-edits.js';
import {
  editFile,
  expectGraphEqualsFullIndex,
  indexFull,
  indexIncremental,
  makeProject,
  writeFiles,
} from './graph-fixture.js';

// ---------------------------------------------------------------------------
// T10 — after every round of a generated edit sequence, the graph equals a
// full index of the same tree (adr/proposals/incremental-graph-correctness).
//
// The seeds are fixed, so the suite is the same on every run. To look for new
// cases, run other seeds:
//
//   MAST_GENERATED_SEEDS=100-400 pnpm vitest run src/indexer/__tests__/generated-edits.test.ts
//
// A seed that fails is a finding: it gets a ledger row, and the sequence, cut
// down to the rounds that matter, a row in equivalence-scenarios.ts.
// ---------------------------------------------------------------------------

const ROUNDS = 10;
// 19 and 29 are here because each fails when a call of an inherited member is
// not resolved again after a class above its receiver changed (seen 2026-10-08).
const FIXED_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 19, 29];
// One test is ten rounds, each an incremental run and a full index: about half
// a second on a quiet machine, and past vitest's 5 s default on a loaded one
// (seen at load average 49, with every seed timing out and none failing).
const SEED_TIMEOUT_MS = 60_000;

function seeds(): number[] {
  const range = /^(\d+)-(\d+)$/.exec(process.env['MAST_GENERATED_SEEDS'] ?? '');
  if (range === null) return FIXED_SEEDS;
  const from = Number(range[1]);
  const to = Number(range[2]);
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

describe('the graph after each round of a generated edit sequence equals a full index', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeProject('generated-edits');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(seeds())('seed %i', async (seed) => {
    const scenario = generateScenario(seed, ROUNDS);
    writeFiles(dir, scenario.files);
    await indexFull(dir);

    for (const [index, round] of scenario.rounds.entries()) {
      for (const [relativePath, content] of Object.entries(round)) {
        if (content === null) rmSync(join(dir, relativePath));
        else editFile(dir, relativePath, content);
      }
      await indexIncremental(dir);

      try {
        await expectGraphEqualsFullIndex(dir);
      } catch (error) {
        if (error instanceof Error) {
          const history = scenario.edits.slice(0, index + 1).map((edit, i) => `  ${i + 1}. ${edit}`).join('\n');
          error.message = `seed ${seed}, after round ${index + 1} of:\n${history}\n${error.message}`;
        }
        throw error;
      }
    }
  }, SEED_TIMEOUT_MS);
});
