import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESULT_WRITE_HELPERS } from '../../eval/results-writers.mjs';

const SUITE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `eval/results-writers.mjs` classifies only the scripts directly under `eval/`, so it
 * cannot warn about a script here. The rule that makes that safe: nothing in the suite
 * writes into `eval/results/`. This pins the declared ways of doing so.
 */
describe('eval-suite scripts', () => {
  const scripts = readdirSync(SUITE_DIR).filter((f) => f.endsWith('.mjs'));

  // A scan of no files passes every check below.
  it('are found by this test', () => {
    expect(scripts).toContain('replay-check.mjs');
  });

  it.each(scripts)('%s uses no helper that writes into eval/results', (script) => {
    const source = readFileSync(join(SUITE_DIR, script), 'utf8');
    const used = [...RESULT_WRITE_HELPERS, 'RESULTS_DIR'].filter((name) => new RegExp(`\\b${name}\\b`).test(source));

    expect(used).toEqual([]);
  });
});
