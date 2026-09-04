// The per-step cap, and the one way it could fail silently.
//
// `timeoutMs` raises the cap for a step whose command is legitimately expensive (the n8n corpus
// index). The risk it introduces is not a wrong cap — it is a cap that is never read: this spec
// already has `retry: { timeoutMs }` and `serve: { timeoutMs }`, so an author writing
// `timeoutMs` at step level next to an `mcpCall` has written something plausible that nothing
// consumes, and the step would keep its default cap while reading as though it had been raised.
// That is this project's severity zero in miniature — an answer indistinguishable from a
// correct one — so the key is accepted ONLY where it is honoured, and rejected loudly
// everywhere else.
import { describe, it, expect } from 'vitest';
import { validateScenario } from '../lib/spec-validate.mjs';

/**
 * The smallest scenario the validator accepts, with `steps` swapped per case. Every step
 * carries an `expect` because the validator rejects a scenario that cannot fail — a guard
 * worth not working around, so the fixtures satisfy it rather than bypass it.
 */
function scenario(steps) {
  return { id: 'x', project: 'p', description: 'd', writeSet: [], steps };
}

const check = (steps) => () => validateScenario(scenario(steps), 'test.mjs');

describe('step timeoutMs', () => {
  it('is accepted on a run step', () => {
    expect(check([{ run: 'index .', expect: { exit: 0 }, timeoutMs: 900_000 }])).not.toThrow();
  });

  it('is optional', () => {
    expect(check([{ run: 'index .', expect: { exit: 0 } }])).not.toThrow();
  });

  it('is rejected on a step whose command it would not cap', () => {
    expect(check([{ mcpCall: { name: 'mast_status' }, expect: { stdoutContains: 'files' }, timeoutMs: 900_000 }])).toThrow(/only meaningful on a 'run'/);
  });

  it('is rejected when it is not a positive number', () => {
    expect(check([{ run: 'index .', expect: { exit: 0 }, timeoutMs: 0 }])).toThrow(/positive/);
    expect(check([{ run: 'index .', expect: { exit: 0 }, timeoutMs: -1 }])).toThrow(/positive/);
    expect(check([{ run: 'index .', expect: { exit: 0 }, timeoutMs: '900000' }])).toThrow(/positive/);
  });
});
