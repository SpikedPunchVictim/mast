import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveConfig } from '../../store/config.js';
import { runIndex } from '../../indexer/index.js';
import { isPhaseTimingEnabled } from '../../cli/index-cmd.js';

/**
 * Phase timing exists to answer a question E1 could not: `durationMs` alone measured the
 * growth exponent (b = 1.75 over the nested ladder, ~1.90 over its upper half) but not
 * where the time goes, so the 42 scored runs could not be decomposed after the fact and
 * the mechanism stayed unidentified.
 *
 * The candidate mechanisms make DIFFERENT predictions about which phase carries the
 * exponent — a page-cache cliff concentrates in `write` while `parse` stays linear;
 * symbol/edge resolution concentrates in `edges`; FTS5 merge cost concentrates in `write`
 * but tracks chunks rather than DB size. A single total cannot separate them, so this is
 * measurement infrastructure, not diagnostics-for-their-own-sake.
 */
describe('runIndex phase timing', () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mast-phase-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('reports a duration for every phase of a full build', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export function a(): number { return b(); }\nexport function b(): number { return 1; }\n');
    const config = resolveConfig({ projectRoot: dir });

    const result = await runIndex(config, { incremental: false });

    expect(Object.keys(result.phaseMs).sort()).toEqual(['edges', 'finalise', 'parse', 'walk', 'write']);
    for (const [phase, ms] of Object.entries(result.phaseMs)) {
      expect(ms, `${phase} must be a non-negative finite number`).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(ms), `${phase} must be finite`).toBe(true);
    }
  });

  it('accounts for essentially all of durationMs, so no phase is silently unmeasured', async () => {
    // The phases must tile the run. An unmeasured region is exactly where a super-linear
    // cost could hide from the very instrument built to find it — the A4-MAT-3 lesson
    // applied to timing rather than to interruptions.
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(dir, `f${i}.ts`), `export function f${i}(): number { return ${i}; }\n`);
    }
    const config = resolveConfig({ projectRoot: dir });

    const result = await runIndex(config, { incremental: false });

    const summed = Object.values(result.phaseMs).reduce((s, v) => s + v, 0);
    expect(summed).toBeLessThanOrEqual(result.durationMs + 1);
    expect(summed).toBeGreaterThan(result.durationMs * 0.8);
  });

  it('attributes parse work to parse and write work to write on a multi-batch build', async () => {
    // 40 files > LANCE_BATCH (16), so the parse/write interleave runs three times and a
    // timer that only captured the first batch would show up here.
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(dir, `g${i}.ts`), `export function g${i}(): string { return '${'x'.repeat(200)}'; }\n`);
    }
    const config = resolveConfig({ projectRoot: dir });

    const result = await runIndex(config, { incremental: false });

    expect(result.phaseMs.parse).toBeGreaterThan(0);
    expect(result.phaseMs.write).toBeGreaterThan(0);
  });
});

/**
 * The breakdown is instrumentation, so it is opt-in: an unconditional extra stdout line
 * would change the CLI's output contract for every user. The timers themselves are not
 * gated — they cost a handful of Date.now() calls per batch, and a field that is sometimes
 * absent is worse than one that is always present.
 */
describe('isPhaseTimingEnabled — the opt-in gate', () => {
  it('is off when neither the flag nor the env var is set', () => {
    expect(isPhaseTimingEnabled(undefined, {})).toBe(false);
  });

  it('is on with --phase-timing', () => {
    expect(isPhaseTimingEnabled(true, {})).toBe(true);
  });

  it('is on with ENABLE_MAST_PHASE_TIMING=true', () => {
    expect(isPhaseTimingEnabled(undefined, { ENABLE_MAST_PHASE_TIMING: 'true' })).toBe(true);
  });

  it('tolerates casing and surrounding whitespace, since env vars are typed by hand', () => {
    expect(isPhaseTimingEnabled(undefined, { ENABLE_MAST_PHASE_TIMING: ' TRUE ' })).toBe(true);
  });

  it('fails closed on anything that is not true, so a typo cannot enable it', () => {
    // '1' is listed deliberately: the convention is the word true/false, never a number,
    // and a value that reads as truthy elsewhere must not quietly work here.
    for (const value of ['1', '0', 'false', 'yes', 'on', '']) {
      expect(isPhaseTimingEnabled(undefined, { ENABLE_MAST_PHASE_TIMING: value }), value).toBe(false);
    }
  });
});
