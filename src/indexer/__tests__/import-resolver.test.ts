import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getImportResolver, clearImportResolverCache } from '../import-resolver.js';
import { extractFile } from '../../ast/extract.js';

function write(root: string, rel: string, content = ''): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

describe('import resolver (§13.7)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mast-resolver-'));
    clearImportResolverCache();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    clearImportResolverCache();
  });

  it('resolves a relative import to the real file, with extension', () => {
    write(root, 'src/a.ts', `import { b } from './b';`);
    write(root, 'src/b.ts', 'export const b = 1;');
    const r = getImportResolver(root).resolve('./b', 'src/a.ts');
    expect(r).toEqual({ resolvedPath: 'src/b.ts', isExternal: false });
  });

  it('resolves a relative import to a directory index file', () => {
    write(root, 'src/a.ts', `import { x } from './lib';`);
    write(root, 'src/lib/index.ts', 'export const x = 1;');
    const r = getImportResolver(root).resolve('./lib', 'src/a.ts');
    expect(r.resolvedPath).toBe('src/lib/index.ts');
    expect(r.isExternal).toBe(false);
  });

  it('resolves a tsconfig path alias', () => {
    write(root, 'tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } },
    }));
    write(root, 'src/types.ts', 'export type T = number;');
    const r = getImportResolver(root).resolve('@app/types', 'src/a.ts');
    expect(r).toEqual({ resolvedPath: 'src/types.ts', isExternal: false });
  });

  it('resolves a pnpm workspace package (bare and subpath)', () => {
    write(root, 'pnpm-workspace.yaml', "packages:\n  - 'pkgs/*'\n");
    write(root, 'pkgs/shared/package.json', JSON.stringify({ name: '@scope/shared' }));
    write(root, 'pkgs/shared/src/index.ts', 'export const s = 1;');
    write(root, 'pkgs/shared/util.ts', 'export const u = 1;');

    const resolver = getImportResolver(root);
    expect(resolver.resolve('@scope/shared', 'app/a.ts').resolvedPath).toBe('pkgs/shared/src/index.ts');
    expect(resolver.resolve('@scope/shared/util', 'app/a.ts').resolvedPath).toBe('pkgs/shared/util.ts');
  });

  it('marks node built-ins and unknown packages external', () => {
    write(root, 'src/a.ts', '');
    const resolver = getImportResolver(root);
    expect(resolver.resolve('node:fs', 'src/a.ts')).toEqual({ resolvedPath: null, isExternal: true });
    expect(resolver.resolve('lodash', 'src/a.ts')).toEqual({ resolvedPath: null, isExternal: true });
  });

  // NodeNext / ESM writes `import { x } from './x.js'` even though the on-disk
  // source is `./x.ts`. tsc resolves such a specifier against the TypeScript
  // source ahead of a literal `.js` (Modules Reference, "File extension
  // substitution": lookup order is x.ts, x.tsx, ... then x.js).
  it('resolves a NodeNext ./x.js specifier to its TypeScript source (x.ts)', () => {
    write(root, 'src/a.ts', `import { b } from './b.js';`);
    write(root, 'src/b.ts', 'export const b = 1;');
    const r = getImportResolver(root).resolve('./b.js', 'src/a.ts');
    expect(r).toEqual({ resolvedPath: 'src/b.ts', isExternal: false });
  });

  it('resolves a ./x.js specifier to x.tsx when that is the source', () => {
    write(root, 'src/comp.tsx', 'export const C = 1;');
    const r = getImportResolver(root).resolve('./comp.js', 'src/a.ts');
    expect(r.resolvedPath).toBe('src/comp.tsx');
  });

  it('resolves ./x.mjs to x.mts and ./x.cjs to x.cts', () => {
    write(root, 'src/m.mts', 'export const m = 1;');
    write(root, 'src/c.cts', 'export const c = 1;');
    const resolver = getImportResolver(root);
    expect(resolver.resolve('./m.mjs', 'src/a.ts').resolvedPath).toBe('src/m.mts');
    expect(resolver.resolve('./c.cjs', 'src/a.ts').resolvedPath).toBe('src/c.cts');
  });

  it('resolves ./x.js to a real x.js when no TypeScript source exists (tsc fallback)', () => {
    write(root, 'src/legacy.js', 'export const l = 1;');
    const r = getImportResolver(root).resolve('./legacy.js', 'src/a.ts');
    expect(r.resolvedPath).toBe('src/legacy.js');
  });

  it('prefers the TypeScript source over a real x.js when both exist (NodeNext precedence)', () => {
    write(root, 'src/dual.ts', 'export const d = 1;');
    write(root, 'src/dual.js', 'export const d = 2;');
    const r = getImportResolver(root).resolve('./dual.js', 'src/a.ts');
    expect(r.resolvedPath).toBe('src/dual.ts');
  });

  it('returns null (not external) for an intra-repo import with no file on disk', () => {
    write(root, 'src/a.ts', '');
    const r = getImportResolver(root).resolve('./missing', 'src/a.ts');
    expect(r).toEqual({ resolvedPath: null, isExternal: false });
  });

  it('extractFile fills resolved_path for a relative import (integration)', () => {
    write(root, 'src/handler.ts', `import { Repo } from './repo';\nexport function h(r: Repo): void {}`);
    write(root, 'src/repo.ts', 'export interface Repo { id: string }');
    clearImportResolverCache();

    const { imports } = extractFile(join(root, 'src/handler.ts'), root, 0, 100);
    const imp = imports.find((i) => i.module === './repo');
    expect(imp?.resolvedPath).toBe('src/repo.ts');
    expect(imp?.isExternal).toBe(false);
  });
});
