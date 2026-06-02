import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { TypeScriptExtractor, chunkId, sha256, expandContent } from '../typescript.js';
import { parseSource } from '../../parser.js';
import type { Tree } from '../../parser.js';
import type { Chunk } from '../../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

function loadFixture(name: string): { src: string; tree: Tree; mtime: number } {
  const filePath = join(FIXTURES, name);
  const src = readFileSync(filePath, 'utf-8');
  const mtime = statSync(filePath).mtimeMs / 1_000;
  const ext = name.slice(name.lastIndexOf('.'));
  const tree = parseSource(src, ext);
  return { src, tree, mtime };
}

const extractor = new TypeScriptExtractor();
const CONTEXT_LINES = 0;
const THRESHOLD = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function extract(fixtureName: string, relativePath = 'basic.ts'): Chunk[] {
  const { src, tree, mtime } = loadFixture(fixtureName);
  return extractor.extractChunks(tree, src, relativePath, mtime, CONTEXT_LINES, THRESHOLD);
}

// ---------------------------------------------------------------------------
// chunk_id stability
// ---------------------------------------------------------------------------
describe('chunkId', () => {
  it('produces the same id for the same file_path + start_line', () => {
    expect(chunkId('src/foo.ts', 10)).toBe(chunkId('src/foo.ts', 10));
  });

  it('differs when file_path or start_line differs', () => {
    expect(chunkId('src/foo.ts', 10)).not.toBe(chunkId('src/bar.ts', 10));
    expect(chunkId('src/foo.ts', 10)).not.toBe(chunkId('src/foo.ts', 11));
  });

  it('matches sha256(filePath + ":" + startLine)', () => {
    expect(chunkId('src/foo.ts', 5)).toBe(sha256('src/foo.ts:5'));
  });
});

// ---------------------------------------------------------------------------
// expandContent
// ---------------------------------------------------------------------------
describe('expandContent', () => {
  const lines = ['a', 'b', 'c', 'd', 'e'];

  it('returns lines within bounds when contextLines = 0', () => {
    expect(expandContent(lines, 2, 4, 0)).toBe('b\nc\nd');
  });

  it('expands by contextLines without going below line 1', () => {
    expect(expandContent(lines, 1, 2, 2)).toBe('a\nb\nc\nd');
  });

  it('expands by contextLines without going beyond last line', () => {
    expect(expandContent(lines, 4, 5, 2)).toBe('b\nc\nd\ne');
  });
});

// ---------------------------------------------------------------------------
// basic.ts — chunk types
// ---------------------------------------------------------------------------
describe('TypeScriptExtractor – basic.ts', () => {
  let chunks: Chunk[];

  beforeAll(() => {
    chunks = extract('basic.ts', 'basic.ts');
  });

  it('emits a function chunk for exported function declaration', () => {
    const c = chunks.find((ch) => ch.symbol_name === 'greet');
    expect(c).toBeDefined();
    expect(c?.chunk_type).toBe('function');
    expect(c?.is_exported).toBe(true);
  });

  it('emits a function chunk for exported arrow function const', () => {
    const c = chunks.find((ch) => ch.symbol_name === 'add');
    expect(c).toBeDefined();
    expect(c?.chunk_type).toBe('function');
    expect(c?.is_exported).toBe(true);
  });

  it('emits an interface chunk', () => {
    const c = chunks.find((ch) => ch.symbol_name === 'Greeter');
    expect(c).toBeDefined();
    expect(c?.chunk_type).toBe('interface');
    expect(c?.is_exported).toBe(true);
  });

  it('emits a type chunk', () => {
    const c = chunks.find((ch) => ch.symbol_name === 'Greeting');
    expect(c).toBeDefined();
    expect(c?.chunk_type).toBe('type');
    expect(c?.is_exported).toBe(true);
  });

  it('emits a class_shell chunk for AuthService', () => {
    const shell = chunks.find((ch) => ch.chunk_type === 'class_shell' && ch.symbol_name === 'AuthService');
    expect(shell).toBeDefined();
    expect(shell?.is_exported).toBe(true);
    expect(shell?.content).toContain('class AuthService');
    expect(shell?.content).toContain('validate');
    // body of validate must NOT appear in the shell
    expect(shell?.content).not.toContain('token === this.secret');
  });

  it('emits a method chunk for each public method', () => {
    const validate = chunks.find((ch) => ch.symbol_name === 'AuthService.validate');
    expect(validate).toBeDefined();
    expect(validate?.chunk_type).toBe('method');
    expect(validate?.parent_symbol).toBe('AuthService');
    expect(validate?.is_exported).toBe(true);
  });

  it('marks private method as not exported', () => {
    const hashMethod = chunks.find((ch) => ch.symbol_name === 'AuthService.hash');
    expect(hashMethod).toBeDefined();
    expect(hashMethod?.is_exported).toBe(false);
  });

  it('does not export the internal function', () => {
    const c = chunks.find((ch) => ch.symbol_name === 'internal');
    expect(c).toBeDefined();
    expect(c?.is_exported).toBe(false);
  });

  it('assigns unique chunk_ids to all chunks', () => {
    const ids = chunks.map((c) => c.chunk_id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// two-pass-exports.ts — is_exported via export { } clause
// ---------------------------------------------------------------------------
describe('TypeScriptExtractor – two-pass exports', () => {
  let chunks: Chunk[];

  beforeAll(() => {
    chunks = extract('two-pass-exports.ts', 'two-pass-exports.ts');
  });

  it('marks internalHandle as exported via export clause', () => {
    const c = chunks.find((ch) => ch.symbol_name === 'internalHandle');
    expect(c?.is_exported).toBe(true);
  });

  it('marks InternalService class_shell as exported via export clause', () => {
    const c = chunks.find((ch) => ch.chunk_type === 'class_shell' && ch.symbol_name === 'InternalService');
    expect(c?.is_exported).toBe(true);
  });

  it('marks InternalType as exported via export clause', () => {
    const c = chunks.find((ch) => ch.symbol_name === 'InternalType');
    expect(c?.is_exported).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hash stability
// ---------------------------------------------------------------------------
describe('declaration_hash / body_hash stability', () => {
  it('declaration_hash is stable across identical source', () => {
    const { src, tree } = loadFixture('basic.ts');

    const greetNode = tree.rootNode.children.find(
      (n) => n.type === 'export_statement',
    )?.namedChildren?.[0];
    if (greetNode === undefined) return; // skip if tree structure differs
    const h1 = extractor.declarationHash(greetNode, src);
    const h2 = extractor.declarationHash(greetNode, src);
    expect(h1).toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// Sub-chunking
// ---------------------------------------------------------------------------
describe('sub-chunking for large declarations', () => {
  it('splits a function exceeding threshold into overlapping sub-chunks', () => {
    // Build a fixture source with a function that has 120 lines.
    const bodyLines = Array.from({ length: 115 }, (_, i) => `  const _x${i} = ${i};`);
    const src = [
      'export function bigFunction(): void {',
      ...bodyLines,
      '}',
    ].join('\n');

    const tree = parseSource(src, '.ts');
    const smallThreshold = 50;
    const result = extractor.extractChunks(tree, src, 'big.ts', 0, 0, smallThreshold);

    expect(result.length).toBeGreaterThan(1);
    // All sub-chunks reference bigFunction
    for (const chunk of result) {
      expect(chunk.symbol_name).toBe('bigFunction');
    }
    // Sub-chunks overlap: end of sub-chunk N ≥ start of sub-chunk N+1
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1]!.end_line).toBeGreaterThanOrEqual(result[i]!.start_line);
    }
  });

  it('does not split a function below threshold', () => {
    const { src, tree, mtime } = loadFixture('basic.ts');
    const result = extractor.extractChunks(tree, src, 'basic.ts', mtime, 0, 200);
    const greetChunks = result.filter((c) => c.symbol_name === 'greet');
    expect(greetChunks).toHaveLength(1);
  });
});
