// One name for the gate, and a test that keeps it honest.
//
// S-10 ("the check you ran is not the check that governs") has five instances, two of them on a
// single day. The recurring mechanism is not carelessness — it is that *nothing named the gate*.
// `pnpm typecheck` is `tsc --noEmit && tsc -p tsconfig.test.json`; `pnpm lint` covers three
// directories. Anyone reconstructing those from memory writes `npx tsc --noEmit` or
// `eslint src eval`, gets a real green from a narrower instrument, and reports it as the gate
// passing. D021 and D065 are that exact mistake, four months apart, on the same script.
//
// `pnpm gate` gives the phrase one referent. This file is the half that makes it stay true: the
// script and the workflows are two producers of one value (S-05), and without a check they drift
// silently — a CI step added and not mirrored locally recreates the original defect with an extra
// layer of confidence on top.
//
// Parsed with a regex rather than a YAML library because the only construct read is
// `run: pnpm <script>`, and a dependency added to inspect four lines of workflow would cost more
// than it protects (CLAUDE.md §8.5). If the workflows ever express steps in a way this cannot
// see, the assertion fails closed: an unparsed step is a missing step, never a passing one.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');

/**
 * Scripts that appear in a workflow but are deliberately not part of the local gate:
 * `install` is the runner preparing a fresh checkout, and `publish` is the release action the
 * gate exists to guard. Everything else a workflow runs through pnpm MUST be in `gate` — a new
 * CI step that is not mirrored locally is precisely the drift this file exists to catch, so the
 * list is a fixed exclusion of two, never a general escape hatch.
 */
const NOT_GATE_STEPS = new Set(['install', 'publish']);

/** The ordered `pnpm <script>` invocations a workflow runs, minus the two above. */
function workflowGateSteps(file: string): readonly string[] {
  const yaml = readFileSync(join(repoRoot, '.github', 'workflows', file), 'utf8');
  const steps: string[] = [];
  for (const match of yaml.matchAll(/^\s*run:\s*pnpm\s+([a-z][\w:-]*)/gm)) {
    const script = match[1];
    if (script !== undefined && !NOT_GATE_STEPS.has(script)) steps.push(script);
  }
  return steps;
}

/** The ordered `pnpm <script>` invocations the `gate` script chains together. */
function gateScriptSteps(): readonly string[] {
  const pkg: unknown = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const scripts = (pkg as { scripts?: Record<string, string> }).scripts ?? {};
  const gate = scripts.gate;
  if (gate === undefined) throw new Error("package.json has no 'gate' script");
  return gate.split('&&').map((part) => part.trim().replace(/^pnpm\s+/, ''));
}

describe('gate parity', () => {
  it('runs the same steps the release workflow runs, in the same order', () => {
    // Release is the authority: it is the gate that decides whether users get the artifact.
    expect(gateScriptSteps()).toEqual(workflowGateSteps('release.yml'));
  });

  it('runs the same steps CI runs, in the same order', () => {
    expect(gateScriptSteps()).toEqual(workflowGateSteps('ci.yml'));
  });

  it('actually found steps to compare', () => {
    // Without this, a regex that matched nothing would compare [] to [] and pass — the empty
    // gate reporting green over an empty rule set, which is D053's shape exactly.
    expect(gateScriptSteps().length).toBeGreaterThanOrEqual(4);
  });
});
