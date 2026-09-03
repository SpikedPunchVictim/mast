// The promotion earned by S-04's "document that refutes itself" sub-shape (D054,
// D056): the two signal tables users read are now derived-checked against the
// types they claim to describe, instead of being prose nobody diffs.
//
// What this decides, and what it does not, stated plainly because a matrix test
// read as exhaustive is worse than none (ledger, standing rules):
//
//   DECIDED  every signal named in either table exists in `src/ast/types.ts`;
//            both tables name the same set; and a signal the docs promise is
//            "omitted when it does not apply" is actually declared optional.
//   NOT      whether a signal's prose *description* is accurate, and whether a
//            newly added field in types.ts is a signal at all — naming that
//            requires knowing what the field means, which is the half of S-04
//            that stayed a brief.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

/**
 * Pulls the leading `` `code` `` cell from every row of the markdown table that
 * follows `heading`, which is how both documents list their signals.
 */
function signalsInTable(markdown: string, heading: string): readonly string[] {
  const start = markdown.indexOf(heading);
  if (start === -1) throw new Error(`signal table heading not found: ${heading}`);
  const body = markdown.slice(start);
  const end = body.indexOf('\n\n', body.indexOf('|---'));
  const rows = body.slice(0, end === -1 ? undefined : end).split('\n');
  return rows
    .map((r) => /^\|\s*`([a-z_]+)`\s*\|/.exec(r)?.[1])
    .filter((name): name is string => name !== undefined);
}

const TYPES = read('src/ast/types.ts');
const README_SIGNALS = signalsInTable(read('README.md'), '### The signals');
const SKILL_SIGNALS = signalsInTable(read('assets/skill.md'), '| signal | on | means |');

/** `undefined` = no declaration at all; otherwise whether it is declared `?`. */
function declaredOptional(field: string): boolean | undefined {
  const m = new RegExp(`^\\s*readonly ${field}(\\??):`, 'm').exec(TYPES);
  return m === null ? undefined : m[1] === '?';
}

describe('signal tables are derived from the types they describe', () => {
  it('finds a non-trivial table in each document', () => {
    expect(README_SIGNALS.length).toBeGreaterThan(5);
    expect(SKILL_SIGNALS).toEqual(README_SIGNALS);
  });

  it.each(README_SIGNALS)('%s is declared in src/ast/types.ts', (signal) => {
    // A signal the docs promise and the wire never carries is S-04 exactly: a
    // property asserted that nothing implements.
    expect(declaredOptional(signal), `${signal} is documented but not declared`).not.toBeUndefined();
  });

  /**
   * Both documents make a blanket promise that a signal's *absence* is
   * meaningful, then carve out the fields that are always present. D056: the
   * carve-out was missing and `truncated` — a required `boolean` — sat under a
   * sentence reading "their presence is never `false`", telling callers to test
   * for a key that is always there.
   */
  it.each(README_SIGNALS)('%s: docs agree with its declaration on whether it can be absent', (signal) => {
    const optional = declaredOptional(signal);
    // Whitespace-insensitive: both documents wrap their prose, and matching on
    // literal spacing made this assertion pass or fail on where a line broke.
    const carvesOut = (doc: string): boolean =>
      new RegExp(`\`${signal}\`[^.]{0,120}\\bexception\\b`, 's').test(doc.replace(/\s+/g, ' '));
    const readmeExcepts = carvesOut(read('README.md'));
    const skillExcepts = carvesOut(read('assets/skill.md'));

    if (optional === false) {
      expect(readmeExcepts, `${signal} is a required field, but README's signal table promises every signal is omitted when it does not apply`).toBe(true);
      expect(skillExcepts, `${signal} is a required field, but assets/skill.md promises every signal is omitted when it does not apply`).toBe(true);
    } else {
      expect(readmeExcepts, `${signal} is optional, but README singles it out as an always-present exception`).toBe(false);
      expect(skillExcepts, `${signal} is optional, but assets/skill.md singles it out as an always-present exception`).toBe(false);
    }
  });
});
