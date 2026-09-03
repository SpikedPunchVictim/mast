// Scenario validation.
//
// This module's job is NOT catching scenarios that break. It is catching scenarios that keep
// PASSING while asserting less than they claim — the failure mode a test suite cannot report,
// because from the outside it looks like success. Ported from align's `spec-validate.mjs`, which
// the first draft of this harness dropped, plus one guard align itself lacks (see
// `validateHasAssertions`).
import { readFileSync } from 'node:fs';
import { ASSERT_KINDS } from './assert.mjs';
import { knownMutations } from './mutations.mjs';
import { validateWriteSetEntry } from './writeset.mjs';

const KNOWN_STEP_KEYS = ['install', 'run', 'mutate', 'mcpCall', 'snapshot', 'assert', 'expect', 'label', 'serve', 'serveStop', 'retry'];
const KNOWN_ACTION_KEYS = ['install', 'run', 'mutate', 'mcpCall', 'snapshot', 'assert', 'serve', 'serveStop'];
const KNOWN_EXPECT_KEYS = ['exit', 'stdoutContains', 'stderrContains', 'stdoutMatches'];
const KNOWN_SCENARIO_KEYS = ['id', 'project', 'description', 'tags', 'writeSet', 'steps', 'expectFailOn', 'requires'];

export function validateScenario(scenario, sourcePath) {
  const where = `${sourcePath}`;
  const fail = (msg) => { throw new Error(`invalid scenario in ${where}: ${msg}`); };

  for (const key of Object.keys(scenario)) {
    if (!KNOWN_SCENARIO_KEYS.includes(key)) fail(`unknown scenario key '${key}' — known: ${KNOWN_SCENARIO_KEYS.join(', ')}`);
  }
  for (const key of ['id', 'project', 'description']) {
    if (typeof scenario[key] !== 'string' || scenario[key].length === 0) fail(`'${key}' must be a non-empty string`);
  }
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) fail(`'steps' must be a non-empty array`);

  // REQUIRED, and an empty array is a legitimate declaration meaning "this scenario disturbs
  // nothing" — the strongest form. What is rejected is OMITTING it, because a missing write-set
  // and a write-set of nothing are indistinguishable to a reader and only one of them was
  // thought about. Fail-closed is the whole point: align's harness gets its universal implicit
  // assertion from exactly this (see `validateHasAssertions` below).
  if (!Array.isArray(scenario.writeSet)) {
    fail(`'writeSet' is required and must be an array — declare [] if the scenario disturbs nothing. An omitted write-set fails open, which is the one direction this guard must never fail (LEDGER D041)`);
  }
  scenario.writeSet.forEach((entry, i) => {
    const problem = validateWriteSetEntry(entry);
    if (problem !== null) fail(`writeSet[${i}] ${problem}`);
  });

  scenario.steps.forEach((step, i) => {
    for (const key of Object.keys(step)) {
      if (!KNOWN_STEP_KEYS.includes(key)) fail(`step ${i}: unknown key '${key}' — known: ${KNOWN_STEP_KEYS.join(', ')}`);
    }
    const actions = KNOWN_ACTION_KEYS.filter((k) => step[k] !== undefined);
    if (actions.length === 0) fail(`step ${i}: no action (one of ${KNOWN_ACTION_KEYS.join('/')})`);
    if (actions.length > 1) fail(`step ${i}: ${actions.length} actions in one step (${actions.join(', ')}) — split them, or the ordering is ambiguous`);

    if (step.expect !== undefined) {
      const keys = Object.keys(step.expect);
      if (keys.length === 0) fail(`step ${i}: empty 'expect' — an expectation that checks nothing reads as a passing check`);
      for (const key of keys) {
        if (!KNOWN_EXPECT_KEYS.includes(key)) fail(`step ${i}: unknown expect key '${key}' — known: ${KNOWN_EXPECT_KEYS.join(', ')}`);
        if (typeof step.expect[key] === 'string' && step.expect[key].length === 0) {
          fail(`step ${i}: expect.${key} is the empty string, which matches everything`);
        }
      }
      if (step.run === undefined && step.mcpCall === undefined) fail(`step ${i}: 'expect' without a 'run' or 'mcpCall' asserts nothing`);
    }

    if (step.assert !== undefined) {
      const kind = step.assert.kind;
      const required = ASSERT_KINDS[kind];
      if (required === undefined) fail(`step ${i}: unknown assert kind '${kind}' — known: ${Object.keys(ASSERT_KINDS).join(', ')}`);
      for (const key of required) {
        if (step.assert[key] === undefined) fail(`step ${i}: assert '${kind}' requires '${key}'`);
      }
    }

    // `retry` polls an `expect` to a deadline. On a step with no `expect` it would loop doing
    // nothing and then report a pass, which is the "asserts less than it claims" failure this
    // file exists to prevent.
    if (step.retry !== undefined) {
      if (step.mcpCall === undefined) fail(`step ${i}: 'retry' is only meaningful on an 'mcpCall'`);
      if (step.expect === undefined) fail(`step ${i}: 'retry' without an 'expect' polls for nothing and always passes`);
      if (typeof step.retry.timeoutMs !== 'number' || step.retry.timeoutMs <= 0) {
        fail(`step ${i}: 'retry' requires a positive 'timeoutMs' — an unbounded poll hangs the suite`);
      }
    }

    if (step.serve !== undefined) {
      if (typeof step.serve !== 'object' || step.serve === null) fail(`step ${i}: 'serve' must be an object (use '{}' for default flags)`);
      if (step.serve.args !== undefined && !Array.isArray(step.serve.args)) fail(`step ${i}: 'serve.args' must be an array of CLI flags`);
      if (step.serve.settleMs !== undefined && (typeof step.serve.settleMs !== 'number' || step.serve.settleMs < 0)) {
        fail(`step ${i}: 'serve.settleMs' must be a non-negative number of milliseconds`);
      }
    }

    if (step.mutate !== undefined) {
      if (typeof step.mutate !== 'object' || step.mutate === null) fail(`step ${i}: 'mutate' must be an object with a 'kind'`);
      if (!knownMutations().includes(step.mutate.kind)) {
        fail(`step ${i}: unknown mutation '${step.mutate.kind}' — known: ${knownMutations().join(', ')}`);
      }
    }
  });

  validateHasAssertions(scenario, fail);
  return scenario;
}

/**
 * A scenario that never asserts anything cannot fail, and a suite of them reports green forever.
 *
 * This guard was originally justified by mast's write-set NOT backstopping the way align's does.
 * That justification is now void: the write-set is required, enforced after every step, and
 * excludes only the state dir, so it IS a universal implicit assertion again (D041). The guard
 * is kept anyway, on narrower grounds — a scenario that only ever asserts "nothing unexpected
 * moved" is a fine tripwire but a poor test, and this keeps an author from mistaking the
 * backstop for coverage.
 */
function validateHasAssertions(scenario, fail) {
  const asserts = scenario.steps.filter((s) => s.assert !== undefined).length;
  const expects = scenario.steps.filter((s) => s.expect !== undefined).length;
  if (asserts + expects === 0) fail(`no 'assert' and no 'expect' in any step — this scenario cannot fail, so its green means nothing`);
}

/**
 * A duplicate property key is legal JavaScript: the last one silently wins, and by `import()`
 * time the first is gone. So this reads the SOURCE TEXT. A scenario whose second `steps:` key
 * overwrote the first would otherwise run half the steps its author wrote and pass.
 */
export function validateNoDuplicateKeys(sourcePath) {
  const text = readFileSync(sourcePath, 'utf8');
  const objectDepthKeys = [];
  let depth = 0;
  const seen = new Map();
  const keyRe = /(^|[{,\s])([A-Za-z_$][\w$]*)\s*:/g;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    let m;
    while ((m = keyRe.exec(line)) !== null) {
      const key = m[2];
      const bucket = seen.get(depth) ?? new Set();
      if (depth === 1 && bucket.has(key)) {
        throw new Error(`invalid scenario in ${sourcePath}: duplicate key '${key}' at the top level — the later one silently wins, so half the file does not run`);
      }
      bucket.add(key);
      seen.set(depth, bucket);
    }
    for (const ch of line) {
      if (ch === '{' || ch === '[') depth++;
      if (ch === '}' || ch === ']') { depth--; seen.delete(depth + 1); }
    }
    objectDepthKeys.push(depth);
  }
}
