// Executes one scenario against one target, in one working copy. Pure orchestration — every
// actual decision lives in exec.mjs / assert.mjs / mutations.mjs.
//
// FAIL and ERROR are different outcomes and never collapse into each other. FAIL is an
// assertion that came back false: a statement about mast. ERROR is the harness failing to run
// the check at all: a statement about the harness. Reporting the second as the first is how a
// suite quietly stops testing anything.
import { runMast } from './exec.mjs';
import { evaluateAssert, evaluateExpect, captureCounts } from './assert.mjs';
import { applyMutation } from './mutations.mjs';
import { callMcpTool } from './mcp-client.mjs';
import { snapshotTree, diffSnapshots, undeclaredWrites } from './writeset.mjs';

export async function runScenario(scenario, ctx) {
  const { installRoot, workingDir, target, log = () => {} } = ctx;
  const snapshots = new Map();
  const saved = new Map();
  const steps = [];
  let pass = true;

  // The declared write-set is checked after EVERY step, not once at the end, so the failure
  // names the step that caused it. `writeSet` is required by spec-validate, so this is a
  // universal implicit assertion on every scenario — which is what makes a scenario whose
  // asserts all pass still capable of failing (LEDGER D041).
  const declared = scenario.writeSet;
  let treeBefore = snapshotTree(workingDir);

  try {
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      let record;

      if (step.install !== undefined) {
        // The install itself happens once per target, before any scenario runs — this step only
        // records that the scenario depends on it, so a scenario file still reads top to bottom.
        record = { index: i, kind: 'install', target, pass: true, failures: [] };
      } else if (step.run !== undefined) {
        log(`  step ${i}: run mast ${step.run}`);
        const result = runMast(installRoot, workingDir, step.run);
        const { pass: p, failures } = evaluateExpect(step.expect, result);
        record = { index: i, kind: 'run', command: step.run, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs, pass: p, failures };
      } else if (step.mcpCall !== undefined) {
        log(`  step ${i}: mcpCall ${step.mcpCall.tool}`);
        const mcp = await callMcpTool(installRoot, workingDir, step.mcpCall.tool, step.mcpCall.arguments ?? {});
        const { pass: p, failures } = evaluateExpect(step.expect, { exitCode: 0, stdout: mcp.text, stderr: '' });
        record = { index: i, kind: 'mcpCall', tool: step.mcpCall.tool, text: mcp.text, pass: p, failures };
      } else if (step.mutate !== undefined) {
        log(`  step ${i}: mutate ${step.mutate.kind}`);
        applyMutation(step.mutate, { dir: workingDir, saved });
        record = { index: i, kind: 'mutate', mutation: step.mutate, pass: true, failures: [] };
      } else if (step.snapshot !== undefined) {
        log(`  step ${i}: snapshot '${step.snapshot}'`);
        snapshots.set(step.snapshot, captureCounts({ installRoot, workingDir }));
        record = { index: i, kind: 'snapshot', label: step.snapshot, counts: snapshots.get(step.snapshot), pass: true, failures: [] };
      } else if (step.assert !== undefined) {
        log(`  step ${i}: assert ${step.assert.kind}`);
        const { pass: p, failures } = evaluateAssert(step.assert, { installRoot, workingDir, snapshots });
        record = { index: i, kind: 'assert', spec: step.assert, pass: p, failures };
      } else {
        throw new Error(`step ${i} has no recognised action — spec-validate should have caught this`);
      }

      // Who moved the filesystem, and were they allowed to?
      const treeAfter = snapshotTree(workingDir);
      const stray = undeclaredWrites(diffSnapshots(treeBefore, treeAfter), declared);
      treeBefore = treeAfter;
      if (stray.length > 0) {
        if (record.kind === 'mutate') {
          // The scenario's own mutation touched something it did not declare. That is a
          // statement about the SCENARIO, so it is ERROR — a mis-declared scenario must not be
          // reported as a defect in mast.
          throw new Error(
            `step ${i} (mutate ${step.mutate.kind}) wrote outside the declared writeSet: ${stray.join(', ')}. ` +
            `Declared: ${declared.length === 0 ? '(nothing)' : declared.join(', ')}. ` +
            `Either the mutation is wrong or the declaration is — the harness cannot tell which, so this is ERROR, not FAIL.`,
          );
        }
        // A mast command changed the indexed project. THIS is the assertion the write-set
        // exists for: LEDGER.md's severity-zero rests on "mast never writes to the user's
        // source", and until this line nothing checked it.
        record.pass = false;
        record.failures = [
          ...record.failures,
          `mast wrote into the indexed project outside the declared writeSet: ${stray.join(', ')}. ` +
          `The state dir is excluded from this check, so these are writes to SOURCE.`,
        ];
      }

      steps.push(record);
      if (record.pass === false) {
        pass = false;
        for (const f of record.failures) log(`    FAIL: ${f.split('\n')[0]}`);
      }
    }
    return { scenarioId: scenario.id, target, pass, errored: false, steps };
  } catch (err) {
    return {
      scenarioId: scenario.id,
      target,
      pass: false,
      errored: true,
      errorMessage: err instanceof Error ? err.message : String(err),
      steps,
    };
  }
}
