import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getImportResolver, clearImportResolverCache, MISCASED_SAMPLE_LIMIT } from '../import-resolver.js';
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

  // D110. NodeNext source writes the output extension after an alias too.
  it('resolves an alias written with a .js extension to its TypeScript source', () => {
    write(root, 'tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } },
    }));
    write(root, 'src/audit.service.ts', 'export class AuditService {}');

    const r = getImportResolver(root).resolve('@app/audit.service.js', 'src/a.ts');

    expect(r).toEqual({ resolvedPath: 'src/audit.service.ts', isExternal: false });
  });

  it('does not resolve an alias written with a .js extension to a directory of that stem', () => {
    write(root, 'tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } },
    }));
    write(root, 'src/audit/index.ts', 'export class AuditService {}');

    const r = getImportResolver(root).resolve('@app/audit.js', 'src/a.ts');

    expect(r.resolvedPath).toBeNull();
  });

  // D087. A monorepo's root tsconfig.json often holds only `references`, and
  // each package declares its own aliases, usually the same `@/*`.
  it('resolves an alias declared only in the importing package\'s tsconfig.json', () => {
    write(root, 'tsconfig.json', JSON.stringify({ references: [{ path: './packages/app' }] }));
    write(root, 'packages/app/tsconfig.json', JSON.stringify({
      compilerOptions: { paths: { '@/*': ['./src/*'] } },
    }));
    write(root, 'packages/app/src/lib/a.ts', 'export const fn = 1;');

    const r = getImportResolver(root).resolve('@/lib/a', 'packages/app/src/zc.ts');

    expect(r).toEqual({ resolvedPath: 'packages/app/src/lib/a.ts', isExternal: false });
  });

  it('resolves the same alias to each package\'s own target', () => {
    for (const pkg of ['one', 'two']) {
      write(root, `packages/${pkg}/tsconfig.json`, JSON.stringify({
        compilerOptions: { paths: { '@/*': ['./src/*'] } },
      }));
      write(root, `packages/${pkg}/src/lib/a.ts`, 'export const fn = 1;');
    }
    const resolver = getImportResolver(root);

    const one = resolver.resolve('@/lib/a', 'packages/one/src/deep/zc.ts');
    const two = resolver.resolve('@/lib/a', 'packages/two/src/zc.ts');

    expect(one.resolvedPath).toBe('packages/one/src/lib/a.ts');
    expect(two.resolvedPath).toBe('packages/two/src/lib/a.ts');
  });

  it('uses the root alias for a file whose nearer tsconfig.json declares no paths', () => {
    write(root, 'tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } },
    }));
    write(root, 'src/tools/tsconfig.json', JSON.stringify({ compilerOptions: { strict: true } }));
    write(root, 'src/types.ts', 'export type T = number;');

    const r = getImportResolver(root).resolve('@app/types', 'src/tools/run.ts');

    expect(r).toEqual({ resolvedPath: 'src/types.ts', isExternal: false });
  });

  // Before D087 only the root tsconfig.json was read. Reading every one on the
  // way up must not let a broken fixture file take its directory out of the index.
  it('passes over a tsconfig.json that does not parse', () => {
    write(root, 'tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } },
    }));
    write(root, 'src/broken/tsconfig.json', '{ "compilerOptions": ');
    write(root, 'src/types.ts', 'export type T = number;');

    const r = getImportResolver(root).resolve('@app/types', 'src/broken/run.ts');

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

  // D100. A package's entry points name build output. The index holds the
  // sources, so an import must land on the source the entry was built from,
  // whether or not the build has been run.
  describe('a workspace package whose entry points are build output', () => {
    function workspacePackage(pkg: Record<string, unknown>): void {
      write(root, 'pnpm-workspace.yaml', "packages:\n  - 'pkgs/*'\n");
      write(root, 'pkgs/lib/package.json', JSON.stringify({ name: '@scope/lib', ...pkg }));
    }

    it('resolves `main` to its source once the package has been built', () => {
      workspacePackage({ main: 'dist/index.js', types: 'dist/index.d.ts' });
      write(root, 'pkgs/lib/src/index.ts', 'export const s = 1;');
      write(root, 'pkgs/lib/dist/index.js', 'exports.s = 1;');

      const r = getImportResolver(root).resolve('@scope/lib', 'app/a.ts');

      expect(r.resolvedPath).toBe('pkgs/lib/src/index.ts');
    });

    it('resolves an entry that is a built declaration file to its source, not to the declaration', () => {
      workspacePackage({ types: 'dist/index.d.ts' });
      write(root, 'pkgs/lib/src/index.ts', 'export const s = 1;');
      write(root, 'pkgs/lib/dist/index.d.ts', 'export declare const s: number;');

      const r = getImportResolver(root).resolve('@scope/lib', 'app/a.ts');

      expect(r.resolvedPath).toBe('pkgs/lib/src/index.ts');
    });

    it('resolves a `main` built into a format directory (dist/cjs) to its source', () => {
      workspacePackage({ main: 'dist/cjs/index.js', module: 'dist/esm/index.js' });
      write(root, 'pkgs/lib/src/index.ts', 'export const s = 1;');
      write(root, 'pkgs/lib/dist/cjs/index.js', 'exports.s = 1;');
      write(root, 'pkgs/lib/dist/esm/index.js', 'export const s = 1;');

      const r = getImportResolver(root).resolve('@scope/lib', 'app/a.ts');

      expect(r.resolvedPath).toBe('pkgs/lib/src/index.ts');
    });

    it('resolves a `main` that is not named index, built or not', () => {
      workspacePackage({ main: 'dist/di.js' });
      write(root, 'pkgs/lib/src/di.ts', 'export const s = 1;');
      const unbuilt = getImportResolver(root).resolve('@scope/lib', 'app/a.ts');

      write(root, 'pkgs/lib/dist/di.js', 'exports.s = 1;');
      const built = getImportResolver(root).resolve('@scope/lib', 'app/a.ts');

      expect([unbuilt.resolvedPath, built.resolvedPath]).toEqual(['pkgs/lib/src/di.ts', 'pkgs/lib/src/di.ts']);
    });

    it('resolves a subpath through `exports` to its source', () => {
      workspacePackage({
        main: 'dist/cjs/index.js',
        exports: {
          '.': { types: './dist/esm/index.d.ts', import: './dist/esm/index.js', require: './dist/cjs/index.js' },
          './sandbox': { types: './dist/esm/expression-sandboxing.d.ts', import: './dist/esm/expression-sandboxing.js' },
        },
      });
      write(root, 'pkgs/lib/src/index.ts', 'export const s = 1;');
      write(root, 'pkgs/lib/src/expression-sandboxing.ts', 'export const e = 1;');

      const r = getImportResolver(root).resolve('@scope/lib/sandbox', 'app/a.ts');

      expect(r.resolvedPath).toBe('pkgs/lib/src/expression-sandboxing.ts');
    });

    // D119. Only the directories the build adds may be dropped on the way to
    // `src/`; a directory that names the module may not, or every subpath
    // without a source under `src/` ends at the package's root entry.
    it('resolves a subpath whose source is outside `src/` to that source, not to the root entry', () => {
      workspacePackage({
        main: 'dist/index.js',
        exports: { '.': './dist/index.js', './testing': { types: './dist/testing/index.d.ts', default: './dist/testing/index.js' } },
      });
      write(root, 'pkgs/lib/src/index.ts', 'export const s = 1;');
      write(root, 'pkgs/lib/testing/index.ts', 'export const t = 1;');

      const r = getImportResolver(root).resolve('@scope/lib/testing', 'app/a.ts');

      expect(r.resolvedPath).toBe('pkgs/lib/testing/index.ts');
    });

    it('resolves a subpath that has no source to nothing, not to the root entry', () => {
      workspacePackage({ main: 'dist/index.js', exports: { '.': './dist/index.js', './testing': './dist/testing/index.js' } });
      write(root, 'pkgs/lib/src/index.ts', 'export const s = 1;');

      const r = getImportResolver(root).resolve('@scope/lib/testing', 'app/a.ts');

      expect(r.resolvedPath).toBeNull();
    });

    it('resolves a subpath built into the format directory of the root entry to its source', () => {
      workspacePackage({
        main: 'build/src/index.js',
        module: 'build/esm/index.js',
        exports: { '.': './build/src/index.js', './testing': { import: './build/esm/testing/index.js', require: './build/src/testing/index.js' } },
      });
      write(root, 'pkgs/lib/src/index.ts', 'export const s = 1;');
      write(root, 'pkgs/lib/src/testing/index.ts', 'export const t = 1;');

      const r = getImportResolver(root).resolve('@scope/lib/testing', 'app/a.ts');

      expect(r.resolvedPath).toBe('pkgs/lib/src/testing/index.ts');
    });

    it('resolves a deep import of build output to its source', () => {
      workspacePackage({ main: 'dist/index.js' });
      write(root, 'pkgs/lib/src/util/foo.ts', 'export const f = 1;');
      write(root, 'pkgs/lib/dist/util/foo.js', 'exports.f = 1;');

      const r = getImportResolver(root).resolve('@scope/lib/dist/util/foo', 'app/a.ts');

      expect(r.resolvedPath).toBe('pkgs/lib/src/util/foo.ts');
    });

    it('keeps a `main` that has no source counterpart', () => {
      workspacePackage({ main: 'lib/main.js' });
      write(root, 'pkgs/lib/lib/main.js', 'exports.s = 1;');

      const r = getImportResolver(root).resolve('@scope/lib', 'app/a.ts');

      expect(r.resolvedPath).toBe('pkgs/lib/lib/main.js');
    });
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

// ---------------------------------------------------------------------------
// On-disk case canonicalisation
// ---------------------------------------------------------------------------

/**
 * Whether `dir` lives on a case-insensitive filesystem (APFS/HFS+ as shipped on
 * macOS, NTFS on Windows). Probed, not inferred from `process.platform`: macOS
 * can format a case-sensitive volume and Linux can mount a case-insensitive
 * one, so the platform is not the property these tests turn on.
 */
function isCaseInsensitiveFs(dir: string): boolean {
  const probe = join(dir, 'CaseProbe.tmp');
  writeFileSync(probe, '');
  try {
    return statSync(join(dir, 'caseprobe.tmp')).isFile();
  } catch {
    return false;
  } finally {
    rmSync(probe, { force: true });
  }
}

describe('import resolver — on-disk case canonicalisation', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mast-case-'));
    clearImportResolverCache();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    clearImportResolverCache();
  });

  // A mis-cased import (`./utils/foo` naming `src/Utils/Foo.ts`) resolves on a
  // case-insensitive filesystem, and `statSync` cannot report that it matched
  // case-insensitively. If the resolver echoes the *specifier's* casing, the
  // stored `resolved_path` disagrees with the walker's `files.path` (fast-glob
  // reports the on-disk name), and every path-range join against `files.path`
  // — resolveInFileOrReExportChain, insertReExportFiles, resolveTypeContext —
  // matches nothing. The edge is dropped with no error.
  it('returns the on-disk casing for a mis-cased relative import', () => {
    write(root, 'src/Utils/Foo.ts', 'export const foo = 1;');
    const r = getImportResolver(root).resolve('./utils/foo', 'src/a.ts');

    if (isCaseInsensitiveFs(root)) {
      expect(r.resolvedPath).toBe('src/Utils/Foo.ts');
    } else {
      // On a case-sensitive filesystem the import is genuinely broken — tsc
      // rejects it too — so "no edge" is the correct answer, not a lookup.
      expect(r.resolvedPath).toBeNull();
    }
  });

  // The mis-casing may be in a directory segment alone, which the specifier
  // contributes just as it contributes the basename.
  it('canonicalises a mis-cased directory segment', () => {
    write(root, 'src/DeepDir/mod.ts', 'export const m = 1;');
    const r = getImportResolver(root).resolve('./deepdir/mod', 'src/a.ts');

    if (isCaseInsensitiveFs(root)) {
      expect(r.resolvedPath).toBe('src/DeepDir/mod.ts');
    } else {
      expect(r.resolvedPath).toBeNull();
    }
  });

  // The realpath call exists to collapse pnpm's symlinked package directories
  // so the result matches the walker's `files.path`. Canonicalising case must
  // not cost that.
  it('still collapses a symlinked directory to its real path', () => {
    write(root, 'real/mod.ts', 'export const m = 1;');
    symlinkSync(join(root, 'real'), join(root, 'link'), 'dir');
    const r = getImportResolver(root).resolve('./link/mod', 'a.ts');
    expect(r.resolvedPath).toBe('real/mod.ts');
  });

  // Guards the inverse error: canonicalisation must not rewrite a path that was
  // already correct, on either kind of filesystem.
  it('leaves a correctly-cased import untouched', () => {
    write(root, 'src/Utils/Foo.ts', 'export const foo = 1;');
    const r = getImportResolver(root).resolve('./Utils/Foo', 'src/a.ts');
    expect(r.resolvedPath).toBe('src/Utils/Foo.ts');
  });
});

describe('import resolver — mis-cased import reporting', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mast-miscase-'));
    clearImportResolverCache();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    clearImportResolverCache();
  });

  it('names the importing file, the specifier, and the on-disk path', () => {
    write(root, 'src/Utils/Foo.ts', 'export const foo = 1;');
    const resolver = getImportResolver(root);
    resolver.resolve('./utils/foo', 'src/a.ts');
    const report = resolver.drainMiscased();

    if (isCaseInsensitiveFs(root)) {
      expect(report.count).toBe(1);
      expect(report.samples[0]).toEqual({
        fromFile: 'src/a.ts',
        specifier: './utils/foo',
        onDiskPath: 'src/Utils/Foo.ts',
      });
    } else {
      // The import does not resolve at all on a case-sensitive filesystem, so
      // there is no case discrepancy to report — only an unresolved import.
      expect(report.count).toBe(0);
    }
  });

  it('reports nothing for a correctly-cased import', () => {
    write(root, 'src/Utils/Foo.ts', 'export const foo = 1;');
    const resolver = getImportResolver(root);
    resolver.resolve('./Utils/Foo', 'src/a.ts');
    expect(resolver.drainMiscased()).toEqual({ count: 0, samples: [] });
  });

  // A symlink collapse legitimately changes the path by more than case; if it
  // were reported, every pnpm workspace import would be a false positive.
  it('does not mistake a symlink collapse for mis-casing', () => {
    write(root, 'real/mod.ts', 'export const m = 1;');
    symlinkSync(join(root, 'real'), join(root, 'link'), 'dir');
    const resolver = getImportResolver(root);
    expect(resolver.resolve('./link/mod', 'a.ts').resolvedPath).toBe('real/mod.ts');
    expect(resolver.drainMiscased().count).toBe(0);
  });

  it('clears observations when drained, so each run reports only its own', () => {
    write(root, 'src/Utils/Foo.ts', 'export const foo = 1;');
    const resolver = getImportResolver(root);
    resolver.resolve('./utils/foo', 'src/a.ts');
    resolver.drainMiscased();
    expect(resolver.drainMiscased()).toEqual({ count: 0, samples: [] });
  });

  it('caps retained samples while keeping the count exact', () => {
    const overflow = MISCASED_SAMPLE_LIMIT + 5;
    for (let i = 0; i < overflow; i++) write(root, `src/Dir${i}/Mod.ts`, 'export const m = 1;');
    const resolver = getImportResolver(root);
    for (let i = 0; i < overflow; i++) resolver.resolve(`./dir${i}/mod`, 'src/a.ts');
    const report = resolver.drainMiscased();

    if (isCaseInsensitiveFs(root)) {
      expect(report.count).toBe(overflow);
      expect(report.samples).toHaveLength(MISCASED_SAMPLE_LIMIT);
    } else {
      expect(report.count).toBe(0);
    }
  });
});

// D047: a specifier written with a trailing slash names a directory and nothing
// else. `path.resolve` normalises the slash away before `probe` sees it, so a
// sibling file used to win over the directory the author explicitly asked for.
describe('import resolver — directory-only specifiers (trailing slash, D047)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mast-resolver-dir-'));
    clearImportResolverCache();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    clearImportResolverCache();
  });

  it('prefers the directory index over an identically-named sibling file', () => {
    write(root, 'src/app.ts', `import { handler } from './routes/';`);
    write(root, 'src/routes.ts', 'export const legacy = 1;');
    write(root, 'src/routes/index.ts', 'export const handler = 2;');

    const r = getImportResolver(root).resolve('./routes/', 'src/app.ts');

    expect(r.resolvedPath).toBe('src/routes/index.ts');
  });

  it('prefers the directory index over a sibling differing only by case', () => {
    // The shape that shipped: `Routes.ts` importing `./routes/` resolved to
    // itself on a case-insensitive filesystem, and reported a mis-cased import.
    write(root, 'src/Routes.ts', `import { UserRoutes } from './routes/';`);
    write(root, 'src/routes/index.ts', 'export const UserRoutes = 1;');

    const resolver = getImportResolver(root);
    const r = resolver.resolve('./routes/', 'src/Routes.ts');

    expect(r.resolvedPath).toBe('src/routes/index.ts');
    expect(resolver.drainMiscased().count).toBe(0);
  });

  it('returns null when only a sibling file exists and no such directory does', () => {
    // Node refuses this specifier outright (MODULE_NOT_FOUND); resolving it to
    // `routes.ts` would be inventing an edge the runtime does not have.
    write(root, 'src/app.ts', `import { legacy } from './routes/';`);
    write(root, 'src/routes.ts', 'export const legacy = 1;');

    const r = getImportResolver(root).resolve('./routes/', 'src/app.ts');

    expect(r).toEqual({ resolvedPath: null, isExternal: false });
  });

  it('still prefers a sibling file over a directory when no slash is written', () => {
    // The complement, pinned so the fix cannot invert ordinary precedence:
    // without a trailing slash, `./routes` is file-first, which is what tsc does.
    write(root, 'src/app.ts', `import { legacy } from './routes';`);
    write(root, 'src/routes.ts', 'export const legacy = 1;');
    write(root, 'src/routes/index.ts', 'export const handler = 2;');

    const r = getImportResolver(root).resolve('./routes', 'src/app.ts');

    expect(r.resolvedPath).toBe('src/routes.ts');
  });
});
