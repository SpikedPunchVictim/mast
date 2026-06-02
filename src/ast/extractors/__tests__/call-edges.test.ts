import { describe, it, expect } from 'vitest';
import { parseSource } from '../../parser.js';
import { extractEdges } from '../typescript.js';
import type { EdgeRecord } from '../../types.js';

// Parse `src` and return its edge records. `extractEdges` takes the raw source
// so it can attach the call-site line + context to POTENTIAL_CALL edges.
function edgesOf(src: string): EdgeRecord[] {
  const tree = parseSource(src, '.ts');
  return extractEdges(tree, 'sample.ts', src);
}

function potentialCalls(edges: readonly EdgeRecord[]): EdgeRecord[] {
  return edges.filter((e) => e.edgeType === 'POTENTIAL_CALL');
}

// ---------------------------------------------------------------------------
// POTENTIAL_CALL — §10.3.1 resolver patterns
// ---------------------------------------------------------------------------

describe('extractEdges — POTENTIAL_CALL', () => {
  it('resolves a same-file function call', () => {
    const edges = potentialCalls(edgesOf(`
      function helper(): number { return 1; }
      export function run(): number { return helper(); }
    `));
    const edge = edges.find((e) => e.toName === 'helper');
    expect(edge).toBeDefined();
    expect(edge!.fromName).toBe('run');
    expect(edge!.resolution).toBe('same_file');
  });

  it('resolves a call to a named import', () => {
    const edges = potentialCalls(edgesOf(`
      import { handleLogin } from './handler';
      export function route(): void { handleLogin(); }
    `));
    const edge = edges.find((e) => e.toName === 'handleLogin');
    expect(edge).toBeDefined();
    expect(edge!.fromName).toBe('route');
    expect(edge!.resolution).toBe('import');
  });

  it('resolves this.field.method() via a constructor parameter property', () => {
    const edges = potentialCalls(edgesOf(`
      export class AuthService {
        constructor(private readonly repo: UserRepository) {}
        check(): void { this.repo.findByEmail(); }
      }
    `));
    const edge = edges.find((e) => e.toName === 'UserRepository.findByEmail');
    expect(edge).toBeDefined();
    expect(edge!.fromName).toBe('AuthService.check');
    expect(edge!.resolution).toBe('field_type');
  });

  it('resolves a method call on a `new` expression binding', () => {
    const edges = potentialCalls(edgesOf(`
      export function build(): void {
        const repo = new UserRepository();
        repo.save();
      }
    `));
    const edge = edges.find((e) => e.toName === 'UserRepository.save');
    expect(edge).toBeDefined();
    expect(edge!.resolution).toBe('new_expression');
  });

  it('attaches the call-site line and source context', () => {
    const src = `function helper(): void {}
export function run(): void {
  helper();
}`;
    const edge = potentialCalls(extractEdges(parseSource(src, '.ts'), 'sample.ts', src))
      .find((e) => e.toName === 'helper');
    expect(edge).toBeDefined();
    expect(edge!.callLine).toBe(3);
    expect(edge!.context).toContain('helper()');
  });

  it('does not resolve dynamic/unknown receivers (no false positives)', () => {
    const edges = potentialCalls(edgesOf(`
      export function run(): void {
        getService().doThing();
        registry['key'].doThing();
      }
    `));
    expect(edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// EXTENDS
// ---------------------------------------------------------------------------

describe('extractEdges — EXTENDS', () => {
  it('emits an EXTENDS edge for a class extends clause', () => {
    const edges = edgesOf(`export class Derived extends Base {}`);
    const edge = edges.find((e) => e.edgeType === 'EXTENDS');
    expect(edge).toBeDefined();
    expect(edge!.fromName).toBe('Derived');
    expect(edge!.toName).toBe('Base');
  });
});
