/**
 * Answers one question: **does re-running this eval script overwrite a committed
 * artifact under `eval/results/`?**
 *
 * D025 is what happens when that question is answered by a grep composed from memory.
 * The grep was `writeFileSync|appendFileSync|createWriteStream`; five scorers write via
 * `writeResult(...)`; the silence was read as proof of absence and five published
 * verdicts were overwritten. The vocabulary was the defect, so the vocabulary is what
 * this module declares and `__tests__/results-writers.test.mjs` pins.
 *
 * Deliberately computed on demand rather than published as a committed manifest: a
 * manifest is a second producer of the same value, and S-05 is the shape that says two
 * producers drift. `node eval/results-writers.mjs` is always current.
 *
 * Usage:
 *   node eval/results-writers.mjs                # classify every script
 *   node eval/results-writers.mjs e1-scan-score  # classify some
 *   node eval/results-writers.mjs --writers      # names only, for scripting
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every call that can put bytes on disk. `linkSync` is here because `materialiseTier`
 * hard-links corpus files and would otherwise read as a non-writer — it was missing from
 * the first draft of this list, which is the same omission D025 records.
 */
export const WRITE_PRIMITIVES = Object.freeze([
  'writeFileSync',
  'appendFileSync',
  'createWriteStream',
  'writeFile',
  'copyFileSync',
  'renameSync',
  'cpSync',
  'rmSync',
  'unlinkSync',
  'mkdirSync',
  'linkSync',
  'symlinkSync',
  'truncateSync',
]);

/** Local helpers that write into `eval/results/`. Calling one makes a script a writer. */
export const RESULT_WRITE_HELPERS = Object.freeze(['writeResult']);

/**
 * Local helpers that write, but never into `eval/results/`. Declared so the vocabulary
 * check stays complete without making every corpus builder look like a results writer.
 *
 * `materialiseTier` links into a tier root; the two index builders create state DBs
 * under a cache dir. Re-running any of them costs time, not provenance.
 */
export const NON_RESULT_WRITE_HELPERS = Object.freeze([
  'materialiseTier',
  'buildDecompIndex',
  'buildReserve2Index',
]);

/**
 * Anchoring this on the opening quote is what let `ab-score.mjs` — which writes the
 * literal `'./eval/results/ab-outcome.json'` — classify as safe. Match `results/` at any
 * path segment boundary instead; over-matching costs a reviewer caution, under-matching
 * costs a verdict.
 */
const RESULTS_TOKEN = /\bRESULTS_DIR\b|(?:^|[/'"`])results\//;

/** Strips line comments and string bodies so a mention in prose is not read as a call. */
function stripNoise(line) {
  return line.replace(/\/\/.*$/, '');
}

/**
 * First argument of a call, up to the matching comma at paren depth 1. Returns null when
 * the call spans lines in a way this scanner cannot follow — the caller treats that as
 * unresolved, not as absence.
 */
function firstArg(line, callIndex) {
  const open = line.indexOf('(', callIndex);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < line.length; i += 1) {
    const c = line[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return line.slice(open + 1, i).trim();
    } else if (c === ',' && depth === 1) return line.slice(open + 1, i).trim();
  }
  return null; // unterminated on this line
}

/**
 * A binding value this scanner can actually follow: a path construction, a literal, or
 * another binding. Anything else — a call into unknown code, a ternary, a destructure —
 * is unresolvable, and unresolvable targets are assumed to hit `eval/results/`. The
 * asymmetry is deliberate: a false "WRITES" costs a reviewer some caution, a false
 * "read-only" costs provenance, which is what D025 actually spent.
 */
const RESOLVABLE_VALUE = /^\s*(?:join|resolve|relative|normalize|new URL|['"`])/;

/**
 * Splits local bindings into those that reach `RESULTS_DIR` and those this scanner
 * cannot follow. Both are iterated to a fixpoint, so `const dir = RESULTS_DIR; const f =
 * join(dir, x)` resolves `f`, and an unresolvable root taints everything built from it.
 */
function classifyBindings(lines) {
  const bindings = new Map();
  for (const raw of lines) {
    const m = /^\s*(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(.+)$/.exec(stripNoise(raw));
    if (m) bindings.set(m[1], m[2]);
  }

  const results = new Set();
  const unresolved = new Set();
  for (const [name, value] of bindings) {
    if (!RESOLVABLE_VALUE.test(value)) unresolved.add(name);
  }

  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, value] of bindings) {
      const mentions = (set) => [...set].some((b) => new RegExp(`\\b${b}\\b`).test(value));
      if (!results.has(name) && (RESULTS_TOKEN.test(value) || mentions(results))) {
        results.add(name);
        grew = true;
      }
      if (!unresolved.has(name) && mentions(unresolved)) {
        unresolved.add(name);
        grew = true;
      }
    }
  }
  const resolved = new Set([...bindings.keys()].filter((n) => !unresolved.has(n)));
  return { results, unresolved, resolved };
}

/**
 * @param {string} filename display name, used only in evidence lines
 * @param {string} source   the script's text
 * @returns {{ writesResults: boolean, evidence: string[] }}
 *   `evidence` names every line that drove the verdict, so a caller can check the answer
 *   rather than trust it. An empty `evidence` with `writesResults === false` means no
 *   write of any kind was found.
 */
export function classify(filename, source) {
  const lines = source.split('\n');
  const { results: bound, unresolved, resolved } = classifyBindings(lines);
  const evidence = [];

  lines.forEach((raw, i) => {
    const line = stripNoise(raw);
    const at = (verb) => {
      const m = new RegExp(`\\b${verb}\\s*\\(`).exec(line);
      return m ? m.index : -1;
    };

    for (const helper of RESULT_WRITE_HELPERS) {
      if (at(helper) !== -1) evidence.push(`${filename}:${i + 1}: ${helper} — writes eval/results/`);
    }

    for (const verb of WRITE_PRIMITIVES) {
      const idx = at(verb);
      if (idx === -1) continue;
      const arg = firstArg(line, idx);
      if (arg === null) {
        evidence.push(`${filename}:${i + 1}: ${verb} — target spans lines, assumed eval/results/`);
        continue;
      }
      const mentions = (set) => [...set].some((b) => new RegExp(`\\b${b}\\b`).test(arg));
      if (RESULTS_TOKEN.test(arg) || mentions(bound)) {
        evidence.push(`${filename}:${i + 1}: ${verb}(${arg}) — writes eval/results/`);
      } else if (
        mentions(unresolved) ||
        (!RESOLVABLE_VALUE.test(arg) && !mentions(resolved))
      ) {
        evidence.push(`${filename}:${i + 1}: ${verb}(${arg}) — target unresolved, assumed eval/results/`);
      }
    }
  });

  return { writesResults: evidence.length > 0, evidence };
}

/** Classifies every `.mjs` directly under `dir`, sorted by filename. */
export function classifyAll(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.mjs'))
    .sort()
    .map((f) => ({ script: f, ...classify(f, readFileSync(join(dir, f), 'utf8')) }));
}

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const writersOnly = args.includes('--writers');
  const wanted = args.filter((a) => !a.startsWith('--'));
  const rows = classifyAll(EVAL_DIR).filter(
    (r) => wanted.length === 0 || wanted.some((w) => r.script.includes(w.replace(/\.mjs$/, ''))),
  );

  for (const row of rows) {
    if (writersOnly) {
      if (row.writesResults) console.log(row.script);
      continue;
    }
    console.log(`${row.writesResults ? 'WRITES        ' : 'no results/ write'} ${row.script}`);
    for (const e of row.evidence) console.log(`            ${e}`);
  }
  if (!writersOnly) {
    // Proven and assumed are reported apart. Collapsing them would hide how much of the
    // verdict is conservatism, and an unlabelled assumption is the thing D025 was made of.
    const proven = rows.filter((r) => r.evidence.some((e) => e.endsWith('writes eval/results/')));
    const assumed = rows.filter((r) => r.writesResults).length - proven.length;
    console.log(
      `\n${proven.length} of ${rows.length} provably write into eval/results/; ` +
        `${assumed} more have a target this scanner cannot resolve and are assumed to. ` +
        `Do not re-run either kind in a review.`,
    );
    // Scope, stated rather than implied: this asks only about `eval/results/`. Several
    // scripts overwrite committed *inputs* elsewhere under `eval/` — `gold-set-normal.json`,
    // `scale-queries.json`, `ab-tasks.json` — and are reported here as no-results-write.
    console.log(
      'Scope: eval/results/ only. Scripts that rebuild committed inputs elsewhere under ' +
        'eval/ (frozen gold sets, query manifests) are NOT covered and still are not safe to re-run blind.',
    );
  }
}
