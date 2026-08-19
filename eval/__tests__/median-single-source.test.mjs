import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// One median, one definition (D016, D024).
//
// D016 recorded two median implementations disagreeing on even n. Enumerating
// the family found NINE value-median expressions in three behaviours: five
// agreeing, three taking the upper element (differing on even n — the defect),
// and one indexing `[(n - 1) / 2]`, which is a fractional index and returns
// `undefined` on even n.
//
// They are now all `import { median } from './e1-schedule.mjs'`. This test is
// what keeps them there: it is a source scan, not a behavioural test, because
// the failure mode is a NEW hand-rolled median appearing in a new script —
// something no runtime assertion over today's scripts can see. It is S-05's
// promoted rung (SHAPES.md).
// ---------------------------------------------------------------------------

const EVAL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The single definition every other script must import. */
const CANONICAL_FILE = 'e1-schedule.mjs';

/**
 * Declared exceptions, each with the reason it is not the canonical median.
 * Adding a file here is a deliberate act that has to be justified in review —
 * which is the point. An undeclared match fails the test.
 */
const DECLARED_EXCEPTIONS = {
  'e1-phase-score.mjs': 'medianRun selects a representative RUN, not a value, and throws on even n — averaging two runs\' phase maps would fabricate a decomposition no run produced.',
  'e1-score.mjs': 'percentile(xs, 0.5) is an interpolating percentile, a different estimator, used deliberately.',
};

/** A definition binding `median`/`med` to a function of its own. */
const DEFINES_MEDIAN = /(?:function\s+(?:median|med)\s*\(|(?:const|let|var)\s+(?:median|med)\s*=\s*(?:\(|function\b))/;

/** The formula itself: a sort whose result is indexed inline. */
const SORT_THEN_INDEX = /\.sort\([^;]*\)\s*\[/;

function evalScripts() {
  return readdirSync(EVAL_DIR)
    .filter((f) => f.endsWith('.mjs'))
    .filter((f) => f !== CANONICAL_FILE);
}

describe('median has exactly one definition in eval/', () => {
  it('no script defines its own median', () => {
    const offenders = [];
    for (const file of evalScripts()) {
      if (file in DECLARED_EXCEPTIONS) continue;
      const lines = readFileSync(join(EVAL_DIR, file), 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return;
        if (DEFINES_MEDIAN.test(line) || SORT_THEN_INDEX.test(line)) {
          offenders.push(`${file}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('every script that medians imports the canonical one', () => {
    const missing = [];
    for (const file of evalScripts()) {
      const src = readFileSync(join(EVAL_DIR, file), 'utf-8');
      // `\bmedian(` as a CALL, not the import specifier itself.
      const calls = /(?<!import \{ )\bmedian\(/.test(src);
      if (calls && !src.includes(`from './${CANONICAL_FILE}'`)) missing.push(file);
    }
    expect(missing).toEqual([]);
  });

  it('the canonical median averages the middle two on an even sample', async () => {
    const { median } = await import(join(EVAL_DIR, CANONICAL_FILE));
    expect(median([5, 1, 4, 2])).toBe(3);
    expect(median([5, 1, 4, 2, 3])).toBe(3);
    expect(() => median([])).toThrow(/empty sample/);
  });
});
