import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK_ENTRY = resolve(SRC, 'cli', 'hook.ts');
const BIN_ENTRY = resolve(SRC, 'cli', 'index.ts');

/**
 * Static specifiers of a module: `import … from 'x'`, `import 'x'`, `export … from 'x'`.
 * `import type` / `export type` are skipped because the compiler erases them, so they
 * cost nothing at startup. (Dynamic `import()` is deliberately not matched: it is the
 * mechanism by which the session-start branch defers its heavy modules.)
 * `[^'";]*?` lets a multi-line named import match without crossing into another statement.
 */
export function staticSpecifiers(source: string): string[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const re = /(?:^|[\n;])\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  const found: string[] = [];
  for (const m of withoutComments.matchAll(re)) {
    const specifier = m[2];
    if (m[1] === undefined && specifier !== undefined) found.push(specifier);
  }
  return found;
}

/** Every non-`node:` specifier reachable statically from `entry`, as "importer -> specifier". */
export function offenders(entry: string, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): string[] {
  const seen = new Set<string>();
  const bad: string[] = [];
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of staticSpecifiers(read(file))) {
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('.')) {
        visit(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
      } else {
        bad.push(`${relative(SRC, file)} -> ${spec}`);
      }
    }
  };
  visit(entry);
  return bad;
}

describe('the hook entry stays cheap to start (ADR 017 section 5)', () => {
  it('reaches only node: built-ins through its static imports', () => {
    expect(offenders(HOOK_ENTRY)).toEqual([]);
  });

  it('the checker sees an injected bare import (so the test above cannot pass vacuously)', () => {
    const injected = (p: string): string =>
      p === HOOK_ENTRY ? `import { z } from 'zod';\n${readFileSync(p, 'utf8')}` : readFileSync(p, 'utf8');
    expect(offenders(HOOK_ENTRY, injected)).toContain('cli/hook.ts -> zod');
  });

  it('the checker handles multi-line imports and skips import type', () => {
    expect(staticSpecifiers("import {\n  a,\n  b,\n} from 'x';\nimport type { T } from 'y';\nexport * from './z.js';"))
      .toEqual(['x', './z.js']);
  });

  it('the bin entry does not statically import the program', () => {
    expect(staticSpecifiers(readFileSync(BIN_ENTRY, 'utf8'))).not.toContain('./program.js');
  });

  it('the bin entry dispatches hook before importing the program', () => {
    const source = readFileSync(BIN_ENTRY, 'utf8');
    expect(source.indexOf("'hook'")).toBeGreaterThan(-1);
    expect(source.indexOf("'hook'")).toBeLessThan(source.indexOf("import('./program.js')"));
  });
});
