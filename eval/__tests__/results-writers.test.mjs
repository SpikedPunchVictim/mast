/**
 * D025's pin.
 *
 * The defect: to decide which eval scripts were safe for a reviewer to re-run, I
 * grepped them for `writeFileSync|appendFileSync|createWriteStream`, got no hits in
 * five scorers, and called them read-only. All five write through `writeResult(...)`.
 * Running them overwrote five committed verdict artifacts.
 *
 * The mechanism was not a deep indirection — adding one token to that grep would have
 * caught every one of them. The mechanism was a **grep vocabulary invented from memory
 * at the moment of asking**, which is stale the instant anyone adds a new way to write.
 * So this file pins the vocabulary, not the answer:
 *
 *   1. every write verb reachable in `eval/` is declared, so the vocabulary cannot go
 *      stale silently — this is the assertion that would have failed before D025;
 *   2. the classifier returns the known-correct answer for the five scripts that were
 *      actually clobbered, and for scripts that genuinely do not write;
 *   3. a target the classifier cannot resolve is reported as a writer, so its blind
 *      spots fail safe.
 *
 * The lookup itself is `node eval/results-writers.mjs`, which is computed on demand and
 * therefore cannot drift. There is deliberately no committed manifest to go stale.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WRITE_PRIMITIVES,
  RESULT_WRITE_HELPERS,
  NON_RESULT_WRITE_HELPERS,
  classify,
  classifyAll,
} from '../results-writers.mjs';

const EVAL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The five artifacts D025 overwrote, and the script that produces each. */
const CLOBBERED = {
  'e1-fts-report.mjs': 'e1-fts-verdict.json',
  'e1-hoist-score.mjs': 'e1-hoist-verdict.json',
  'e1-phase-report.mjs': 'e1-phase-verdict.json',
  'e1-scan-score.mjs': 'e1-scan-verdict.json',
  'e1-unread-fit.mjs': 'e1-unread-fit.json',
};

/** Scripts with no filesystem write of any kind — safe to re-run by inspection. */
const READ_ONLY = ['e1-fts-score.mjs', 'e1-phase-score.mjs', 'e1-schedule.mjs', 'e1-stats.mjs'];

describe('the write vocabulary is declared, not remembered', () => {
  it('declares every exported helper in eval/ that performs a filesystem write', () => {
    const declared = new Set([...RESULT_WRITE_HELPERS, ...NON_RESULT_WRITE_HELPERS]);
    const undeclared = [];

    for (const file of readdirSync(EVAL_DIR).filter((f) => f.endsWith('.mjs'))) {
      const lines = readFileSync(join(EVAL_DIR, file), 'utf8').split('\n');
      let name = null;
      let depth = 0;
      let writes = false;

      for (const line of lines) {
        const decl = /^export function ([A-Za-z0-9_]+)/.exec(line);
        if (decl) {
          name = decl[1];
          depth = 0;
          writes = false;
        }
        if (name === null) continue;
        depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
        if (WRITE_PRIMITIVES.some((v) => new RegExp(`\\b${v}\\s*\\(`).test(line))) writes = true;
        if (depth <= 0 && line.startsWith('}')) {
          if (writes && !declared.has(name)) undeclared.push(`${file}::${name}`);
          name = null;
        }
      }
    }

    // An undeclared write helper is exactly D025: a new way to write that the next
    // person's grep will not know to look for.
    expect(undeclared).toEqual([]);
  });
});

describe('classify answers the question D025 answered wrongly', () => {
  it.each(Object.entries(CLOBBERED))(
    '%s writes into eval/results/ (it produces %s)',
    (script) => {
      const result = classify(script, readFileSync(join(EVAL_DIR, script), 'utf8'));

      expect(result.writesResults).toBe(true);
    },
  );

  it.each(READ_ONLY)('%s does not write into eval/results/', (script) => {
    const result = classify(script, readFileSync(join(EVAL_DIR, script), 'utf8'));

    expect(result.writesResults).toBe(false);
  });

  it('reports evidence, so a caller can check the verdict instead of trusting it', () => {
    const result = classify(
      'e1-scan-score.mjs',
      readFileSync(join(EVAL_DIR, 'e1-scan-score.mjs'), 'utf8'),
    );

    expect(result.evidence.join('\n')).toMatch(/writeResult/);
  });

  it('classifies every script in eval/ without throwing', () => {
    const all = classifyAll(EVAL_DIR);

    expect(all.length).toBeGreaterThan(50);
  });
});

describe('unresolvable targets fail safe', () => {
  it('treats a write whose target it cannot resolve as a writer', () => {
    const source = [
      "import { writeFileSync } from 'node:fs';",
      'const target = pickSomethingAtRuntime();',
      'writeFileSync(target, JSON.stringify({}));',
    ].join('\n');

    const result = classify('synthetic.mjs', source);

    expect(result.writesResults).toBe(true);
  });

  it('does not flag a write whose target provably resolves outside eval/results/', () => {
    const source = [
      "import { writeFileSync } from 'node:fs';",
      "const target = join(STATE_DIR, 'graph.db');",
      'writeFileSync(target, JSON.stringify({}));',
    ].join('\n');

    const result = classify('synthetic.mjs', source);

    expect(result.writesResults).toBe(false);
  });
});

describe('proven and assumed are distinguishable', () => {
  it('labels an unresolved target differently from a proven one', () => {
    const proven = classify('p.mjs', "writeResult('x.json', {});");
    const assumed = classify(
      'a.mjs',
      ['const t = pickAtRuntime();', 'writeFileSync(t, "x");'].join('\n'),
    );

    // A reader who cannot tell conservatism from evidence will eventually discount both.
    expect(proven.evidence[0]).toMatch(/writes eval\/results\/$/);
    expect(assumed.evidence[0]).toMatch(/target unresolved, assumed/);
  });
});

describe('regressions found by attacking the classifier', () => {
  it('catches a literal path into eval/results/ that is not quote-anchored', () => {
    // ab-score.mjs:146 writes './eval/results/ab-outcome.json'. The first draft anchored
    // its results token on the opening quote and reported this script as safe to re-run.
    const result = classify(
      'ab-score.mjs',
      readFileSync(join(EVAL_DIR, 'ab-score.mjs'), 'utf8'),
    );

    expect(result.writesResults).toBe(true);
  });

  it('does not claim a script writing elsewhere under eval/ writes results', () => {
    // harvest-real-queries.mjs writes eval/real-query-harvest.json — outside results/.
    const result = classify(
      'harvest-real-queries.mjs',
      readFileSync(join(EVAL_DIR, 'harvest-real-queries.mjs'), 'utf8'),
    );

    expect(result.writesResults).toBe(false);
  });
});
