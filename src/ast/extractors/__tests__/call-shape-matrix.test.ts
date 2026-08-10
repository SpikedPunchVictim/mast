import { describe, it, expect } from 'vitest';
import { parseSource } from '../../parser.js';
import { extractEdges, type CallSiteOutcome } from '../typescript.js';
import type { CallerResolution, EdgeRecord } from '../../types.js';

/**
 * D7 (IMPLEMENTATION_PLAN.md Stage 4) — deterministic call-shape matrix, the
 * "property-based" half without a new dependency (project CLAUDE.md §8.5:
 * every new dependency is a justified liability, and a fast-check adoption
 * is not justified for this finite a shape space). A cartesian product of
 * receiver forms x call wrappers, with the expected outcome for every cell
 * declared from §10.3.1's documented resolver contract. This is the
 * regression floor for every future extractor change to `parseCallee` /
 * `receiverString` / `unwrapAwaitedReceiver` / `LocalTypeEnvironment`.
 *
 * Grammar-validity note: the task brief flagged `(await this).m()` as a
 * possibly ill-formed cell to verify. A tree-sitter parse dump
 * (`tree.rootNode.toString()`) showed BOTH `(await this).m()` and
 * `(await super).m()` parse cleanly with no ERROR node — tree-sitter's
 * grammar does not reject a bare `await this`/`await super` operand the way
 * the real TypeScript checker would flag it semantically. So no cell in
 * this matrix is grammar-ill-formed; none are skipped. Both cells are new
 * coverage (not previously tested): they show the F3 await-unwrap logic
 * generalises to the `this`/`super` receiver bindings, not just
 * identifier/field receivers.
 */

function emptyTally(): Record<CallSiteOutcome, number> {
  return { edge_emitted: 0, unparseable_callee: 0, unresolved_receiver: 0, bare_call_unresolved: 0 };
}

function runOnce(src: string): { edges: EdgeRecord[]; tally: Record<CallSiteOutcome, number> } {
  const tree = parseSource(src, '.ts');
  const tally = emptyTally();
  const edges = extractEdges(tree, 'matrix.ts', src, (outcome) => {
    tally[outcome] += 1;
  });
  return { edges, tally };
}

// ---------------------------------------------------------------------------
// Receiver dimension — §10.3.1's catches/does-not-catch list
// ---------------------------------------------------------------------------

interface ReceiverCase {
  readonly id: string;
  /** The receiver expression text substituted into each call-wrapper template. */
  readonly expr: string;
  readonly buildSource: (callExpr: string) => string;
  readonly expectedTally: Record<CallSiteOutcome, number>;
  readonly expectedEdge: { toName: string; resolution: CallerResolution } | null;
}

const RECEIVER_CASES: readonly ReceiverCase[] = [
  {
    id: 'annotated param (§10.3.1 #4)',
    expr: 'repoParam',
    buildSource: (callExpr) => `
      class UserRepository {}
      class Klass {
        async method(repoParam: UserRepository): Promise<void> {
          ${callExpr}
        }
      }
    `,
    expectedTally: { edge_emitted: 1, unparseable_callee: 0, unresolved_receiver: 0, bare_call_unresolved: 0 },
    expectedEdge: { toName: 'UserRepository.m', resolution: 'parameter_type' },
  },
  {
    id: 'field `this.repo` (§10.3.1 #2/#3)',
    expr: 'this.repoField',
    buildSource: (callExpr) => `
      class UserRepository {}
      class Klass {
        constructor(private readonly repoField: UserRepository) {}
        async method(): Promise<void> {
          ${callExpr}
        }
      }
    `,
    expectedTally: { edge_emitted: 1, unparseable_callee: 0, unresolved_receiver: 0, bare_call_unresolved: 0 },
    expectedEdge: { toName: 'UserRepository.m', resolution: 'field_type' },
  },
  {
    id: 'bare `this` (F4)',
    expr: 'this',
    buildSource: (callExpr) => `
      class Klass {
        async method(): Promise<void> {
          ${callExpr}
        }
      }
    `,
    expectedTally: { edge_emitted: 1, unparseable_callee: 0, unresolved_receiver: 0, bare_call_unresolved: 0 },
    expectedEdge: { toName: 'Klass.m', resolution: 'this_method' },
  },
  {
    id: 'bare `super` (F4)',
    expr: 'super',
    buildSource: (callExpr) => `
      class Base {}
      class Klass extends Base {
        async method(): Promise<void> {
          ${callExpr}
        }
      }
    `,
    expectedTally: { edge_emitted: 1, unparseable_callee: 0, unresolved_receiver: 0, bare_call_unresolved: 0 },
    expectedEdge: { toName: 'Base.m', resolution: 'super_method' },
  },
  {
    id: '`new`-bound local (§10.3.1 #5)',
    expr: 'repoNew',
    buildSource: (callExpr) => `
      class UserRepository {}
      class Klass {
        async method(): Promise<void> {
          const repoNew = new UserRepository();
          ${callExpr}
        }
      }
    `,
    expectedTally: { edge_emitted: 1, unparseable_callee: 0, unresolved_receiver: 0, bare_call_unresolved: 0 },
    expectedEdge: { toName: 'UserRepository.m', resolution: 'new_expression' },
  },
  {
    id: 'unannotated local — does NOT resolve (§10.3.1 "does NOT catch": factory return types)',
    expr: 'repoUnannotated',
    // The setup line itself is a bare call to an unimported/undeclared
    // `makeRepository` — a second, incidental call site the tally below
    // accounts for (bare_call_unresolved), distinct from the target call's
    // own unresolved_receiver outcome.
    buildSource: (callExpr) => `
      class Klass {
        async method(): Promise<void> {
          const repoUnannotated = makeRepository();
          ${callExpr}
        }
      }
    `,
    expectedTally: { edge_emitted: 0, unparseable_callee: 0, unresolved_receiver: 1, bare_call_unresolved: 1 },
    expectedEdge: null,
  },
  {
    id: 'chained `getX()` — does NOT resolve (§10.3.1 "does NOT catch": chained calls without intermediate binding)',
    expr: 'getX()',
    // `getX()` is itself a call_expression nested inside the outer call's
    // receiver position; collectCalls visits it too (bare_call_unresolved),
    // alongside the outer call's own unparseable_callee outcome.
    buildSource: (callExpr) => `
      class Klass {
        async method(): Promise<void> {
          ${callExpr}
        }
      }
    `,
    expectedTally: { edge_emitted: 0, unparseable_callee: 1, unresolved_receiver: 0, bare_call_unresolved: 1 },
    expectedEdge: null,
  },
];

// ---------------------------------------------------------------------------
// Call-wrapper dimension — the plan's named shapes
// ---------------------------------------------------------------------------

interface WrapperCase {
  readonly id: string;
  readonly make: (receiver: string) => string;
}

const WRAPPER_CASES: readonly WrapperCase[] = [
  { id: 'plain `r.m()`', make: (r) => `${r}.m();` },
  { id: 'awaited whole call `await r.m()`', make: (r) => `await ${r}.m();` },
  { id: 'paren-awaited receiver `(await r).m()`', make: (r) => `(await ${r}).m();` },
  { id: 'generic `r.m<T>()`', make: (r) => `${r}.m<T>();` },
];

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

describe.each(RECEIVER_CASES)('call-shape matrix — receiver: $id', (receiverCase) => {
  it.each(WRAPPER_CASES)('wrapper: $id', (wrapperCase) => {
    const callExpr = wrapperCase.make(receiverCase.expr);
    const src = receiverCase.buildSource(callExpr);
    const { edges, tally } = runOnce(src);

    expect(tally, `source:\n${src}`).toEqual(receiverCase.expectedTally);

    if (receiverCase.expectedEdge === null) {
      expect(edges.some((e) => e.edgeType === 'POTENTIAL_CALL')).toBe(false);
    } else {
      const edge = edges.find(
        (e) => e.edgeType === 'POTENTIAL_CALL' && e.toName === receiverCase.expectedEdge!.toName,
      );
      expect(edge, `source:\n${src}`).toBeDefined();
      expect(edge!.resolution).toBe(receiverCase.expectedEdge!.resolution);
    }
  });
});

// ---------------------------------------------------------------------------
// Auxiliary cell — outside the 7x4 receiver grid (which has no *receiver-less*
// dimension), added so the closed union's fourth bucket has a cell where it
// is the PRIMARY subject under test, not an incidental side effect of another
// cell's setup (unannotated-local's `makeRepository()` above exercises it
// only incidentally).
// ---------------------------------------------------------------------------

describe('call-shape matrix — auxiliary: bare receiver-less call, unresolved (§10.3.1 bareCallables miss)', () => {
  it('a bare call to a name that is neither imported nor same-file yields bare_call_unresolved, no edge', () => {
    const src = `
      class Klass {
        async method(): Promise<void> {
          undefinedFn();
        }
      }
    `;
    const { edges, tally } = runOnce(src);
    expect(tally).toEqual({ edge_emitted: 0, unparseable_callee: 0, unresolved_receiver: 0, bare_call_unresolved: 1 });
    expect(edges.some((e) => e.edgeType === 'POTENTIAL_CALL')).toBe(false);
  });
});
