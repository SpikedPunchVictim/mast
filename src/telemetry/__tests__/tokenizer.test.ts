import { mkdtempSync, writeFileSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  countTokens,
  estimateFullFileBound,
  FULL_FILE_BOUND_CACHE_LIMIT,
  type FullFileReader,
} from '../tokenizer.js';

// ---------------------------------------------------------------------------
// estimateFullFileBound (§14.2 — the "naive Read of every result file" bound)
//
// Every test gets its own temp directory so absolute paths never collide with
// another test's entries in the module-level token cache.
// ---------------------------------------------------------------------------

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mast-fullfilebound-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('estimateFullFileBound', () => {
  it('sums tokenizer counts over the full contents of the referenced files', () => {
    const aContent = 'export const a = 1;\n';
    const bContent = 'export function b(): number {\n  return 2;\n}\n';
    writeFileSync(join(dir, 'a.ts'), aContent);
    writeFileSync(join(dir, 'b.ts'), bContent);

    const bound = estimateFullFileBound(['a.ts', 'b.ts'], dir);

    expect(bound).toBe(countTokens(aContent) + countTokens(bContent));
    expect(bound).toBeGreaterThan(0);
  });

  it('counts a repeated file path once (dedup)', () => {
    const content = 'export const a = 1;\n';
    writeFileSync(join(dir, 'a.ts'), content);

    const once = estimateFullFileBound(['a.ts'], dir);
    const repeated = estimateFullFileBound(['a.ts', 'a.ts', 'a.ts'], dir);

    expect(repeated).toBe(once);
  });

  it('contributes 0 for a missing file without throwing, while still counting the rest', () => {
    const content = 'export const a = 1;\n';
    writeFileSync(join(dir, 'a.ts'), content);

    const bound = estimateFullFileBound(['a.ts', 'does-not-exist.ts'], dir);

    expect(bound).toBe(countTokens(content));
  });

  it('never throws even when every referenced file is missing', () => {
    expect(() => estimateFullFileBound(['nope-a.ts', 'nope-b.ts'], dir)).not.toThrow();
    expect(estimateFullFileBound(['nope-a.ts', 'nope-b.ts'], dir)).toBe(0);
  });

  it('skips re-reading a file on a second call when its mtime is unchanged (cache hit)', () => {
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    const fixedMtime = statSync(join(dir, 'a.ts')).mtimeMs / 1_000;

    let readCalls = 0;
    let statCalls = 0;
    const reader: FullFileReader = {
      readFile: (p) => {
        readCalls++;
        return readFileSync(p, 'utf8');
      },
      statMtime: (_p) => {
        statCalls++;
        return fixedMtime;
      },
    };

    estimateFullFileBound(['a.ts'], dir, reader);
    estimateFullFileBound(['a.ts'], dir, reader);

    // The mtime is checked on every call (to detect edits) but the file
    // content is only ever read — and tokenized — once while the mtime holds.
    expect(statCalls).toBe(2);
    expect(readCalls).toBe(1);
  });

  it('re-reads a file whose mtime changed since the cached entry', () => {
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');

    let mtime = 1_000;
    let readCalls = 0;
    const reader: FullFileReader = {
      readFile: (p) => {
        readCalls++;
        return readFileSync(p, 'utf8');
      },
      statMtime: (_p) => mtime,
    };

    estimateFullFileBound(['a.ts'], dir, reader);
    mtime = 2_000; // simulate an on-disk edit between calls
    estimateFullFileBound(['a.ts'], dir, reader);

    expect(readCalls).toBe(2);
  });

  it('evicts the oldest entry once the cache exceeds its bound', () => {
    const paths: string[] = [];
    for (let i = 0; i < FULL_FILE_BOUND_CACHE_LIMIT + 1; i++) {
      const name = `f${i}.ts`;
      writeFileSync(join(dir, name), `export const v${i} = ${i};\n`);
      paths.push(name);
    }

    const readCountByPath = new Map<string, number>();
    const reader: FullFileReader = {
      readFile: (p) => {
        readCountByPath.set(p, (readCountByPath.get(p) ?? 0) + 1);
        return readFileSync(p, 'utf8');
      },
      statMtime: (p) => statSync(p).mtimeMs / 1_000,
    };

    // Populate the cache past its limit in one pass.
    estimateFullFileBound(paths, dir, reader);

    // The first path inserted should have been evicted by now — requesting it
    // again forces a second read rather than serving a stale cache slot.
    const firstPath = paths[0]!;
    estimateFullFileBound([firstPath], dir, reader);

    expect(readCountByPath.get(join(dir, firstPath))).toBe(2);
  });
});
