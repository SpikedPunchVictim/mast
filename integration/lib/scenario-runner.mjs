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
import { callMcpTool, openMcpSession } from './mcp-client.mjs';
import { snapshotTree, diffSnapshots, undeclaredWrites } from './writeset.mjs';

export async function runScenario(scenario, ctx) {
  const { installRoot, workingDir, target, log = () => {} } = ctx;
  const snapshots = new Map();
  const saved = new Map();
  const steps = [];
  let pass = true;
  /** The one persistent `mast serve` process, when a scenario opened one. */
  let session = null;

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
      } else if (step.serve !== undefined) {
        // Opens ONE long-lived `mast serve`. Every subsequent `mcpCall` routes through it, so
        // the scenario observes a session rather than eight unrelated processes — the only way
        // to see the watcher, the startup reindex, or the freshness probe's cached count.
        if (session !== null) throw new Error(`step ${i}: a serve session is already open; close it before opening another`);
        const args = step.serve.args ?? [];
        log(`  step ${i}: serve ${args.join(' ') || '(defaults)'}`);
        session = await openMcpSession(installRoot, workingDir, args);
        // `settleMs` is a SLEEP, and unlike `retry` it cannot be a poll, because there is
        // nothing to poll: `mast serve` connects its transport before the watcher starts, and
        // chokidar announces readiness to nobody outside the process. With `ignoreInitial: true`
        // a file created before that initial scan finishes is treated as pre-existing and fires
        // no event at all — so a scenario that mutates too early tests nothing and reports FAIL.
        // Observed exactly that: this scenario passed run alone and failed when it ran after the
        // 26k-file n8n scenario, purely because the scan was slower under load. See LEDGER D061,
        // which records the missing readiness signal as the actual defect; this is the harness
        // living with it, not a fix.
        if (step.serve.settleMs !== undefined) {
          await new Promise((r) => setTimeout(r, step.serve.settleMs));
        }
        record = { index: i, kind: 'serve', args, settleMs: step.serve.settleMs ?? 0, pass: true, failures: [] };
      } else if (step.serveStop !== undefined) {
        log(`  step ${i}: serveStop`);
        if (session === null) throw new Error(`step ${i}: no serve session is open`);
        await session.close();
        session = null;
        record = { index: i, kind: 'serveStop', pass: true, failures: [] };
      } else if (step.mcpCall !== undefined) {
        const via = session !== null ? 'session' : 'one-shot';
        log(`  step ${i}: mcpCall ${step.mcpCall.tool} (${via})`);
        // `retry` exists because a watcher's effect is asynchronous BY DESIGN: chokidar debounces,
        // the batch takes `structure.lock`, and the reindex takes as long as it takes. A fixed
        // sleep would either be flaky or slow, and — worse — a sleep long enough to be safe
        // would hide a watcher that had regressed to "eventually, after 30s". Polling an
        // expectation to a deadline states the actual contract: this becomes true, within this
        // long. NOTE the failure of the LAST attempt is what gets reported, not the first.
        const retry = step.retry ?? null;
        const deadline = Date.now() + (retry?.timeoutMs ?? 0);
        const interval = retry?.intervalMs ?? 250;
        let mcp, p, failures, attempts = 0;
        for (;;) {
          attempts++;
          mcp = session !== null
            ? await session.call(step.mcpCall.tool, step.mcpCall.arguments ?? {})
            : await callMcpTool(installRoot, workingDir, step.mcpCall.tool, step.mcpCall.arguments ?? {});
          ({ pass: p, failures } = evaluateExpect(step.expect, { exitCode: 0, stdout: mcp.text, stderr: '' }));
          if (p || retry === null || Date.now() >= deadline) break;
          await new Promise((r) => setTimeout(r, interval));
        }
        record = { index: i, kind: 'mcpCall', tool: step.mcpCall.tool, via, attempts, text: mcp.text, pass: p, failures };
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
  } finally {
    // A `mast serve` left running holds a chokidar watcher and keeps the harness alive; a
    // scenario that throws mid-session must not leak one into the next scenario's working copy.
    if (session !== null) await session.close().catch(() => {});
  }
}
