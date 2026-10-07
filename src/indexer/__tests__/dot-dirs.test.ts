// `include_dot_dirs` (ADR 018): dot directories are walked only when named.
//
// Two things decide whether a path is in scope: fast-glob, which `walkProject`
// hands patterns to, and the predicates in `scope.ts`, which watch mode asks
// about one path at a time. They are two producers of one value (shape S-05),
// so the parity block below checks the predicates against fast-glob's actual
// answer on a real tree rather than against a restatement of the rule.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveConfig } from '../../store/config.js';
import { globToRegex, walkProject } from '../walker.js';
import {
  InvalidDotDirError,
  isDirectoryInDotScope,
  isFileInDotScope,
  normalizeDotDirs,
} from '../scope.js';

const TREE = [
  'src/a.ts',
  'README.md',
  '.root.md',
  '.agents/a.md',
  '.agents/sub/b.md',
  '.agents/sub/skip.test.ts',
  '.agents/.cache/c.md',
  '.agents/.dotfile.md',
  // A sibling that shares a named directory's prefix, and a name of two dots:
  // `relative()` output for it starts with `..` without leaving the root.
  '.agents-old/stale.md',
  '..scratch/note.md',
  '.github/top.md',
  '.github/workflows/w.md',
  '.history/src/a.ts',
  'packages/x/.agents/p.md',
  'packages/x/src/q.ts',
  'node_modules/.pnpm/pkg/index.ts',
] as const;

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mast-dot-dirs-'));
  for (const rel of TREE) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), '# heading\n');
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeConfig(includeDotDirs: readonly string[] | undefined): void {
  const body = includeDotDirs === undefined ? {} : { include_dot_dirs: includeDotDirs };
  writeFileSync(join(root, 'mast.config.json'), JSON.stringify(body));
}

async function walked(includeDotDirs: readonly string[] | undefined): Promise<string[]> {
  writeConfig(includeDotDirs);
  const entries = await walkProject(resolveConfig({ projectRoot: root }));
  return entries.map((e) => e.relativePath);
}

function everyFileOnDisk(dir = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...everyFileOnDisk(rel));
    else out.push(rel);
  }
  return out;
}

describe('walkProject — include_dot_dirs', () => {
  it('walks no dot directory when none is named', async () => {
    expect(await walked(undefined)).toEqual(['README.md', 'packages/x/src/q.ts', 'src/a.ts']);
  });

  it('walks a named dot directory, recursively', async () => {
    const paths = await walked(['.agents']);

    expect(paths).toContain('.agents/a.md');
    expect(paths).toContain('.agents/sub/b.md');
  });

  it('leaves every dot directory that was not named out', async () => {
    const paths = await walked(['.agents']);

    expect(paths.filter((p) => p.startsWith('.github/') || p.startsWith('.history/'))).toEqual([]);
  });

  it('still applies exclude_patterns inside a named dot directory', async () => {
    expect(await walked(['.agents'])).not.toContain('.agents/sub/skip.test.ts');
  });

  it('does not descend into a dot directory nested inside a named one', async () => {
    expect(await walked(['.agents'])).not.toContain('.agents/.cache/c.md');
  });

  it('does not take a sibling that shares a named directory\'s prefix', async () => {
    expect(await walked(['.agents'])).not.toContain('.agents-old/stale.md');
  });

  it('walks a nested dot directory when it is named too', async () => {
    expect(await walked(['.agents', '.agents/.cache'])).toContain('.agents/.cache/c.md');
  });

  it('walks a dot directory below the root when named by its path', async () => {
    const paths = await walked(['packages/x/.agents']);

    expect(paths).toContain('packages/x/.agents/p.md');
    expect(paths).not.toContain('.agents/a.md');
  });

  it('walks only the named subdirectory of a dot directory', async () => {
    const paths = await walked(['.github/workflows']);

    expect(paths).toContain('.github/workflows/w.md');
    expect(paths).not.toContain('.github/top.md');
  });

  it('returns each file once when two entries overlap', async () => {
    const paths = await walked(['.github', '.github/workflows']);

    expect(paths.filter((p) => p === '.github/workflows/w.md')).toHaveLength(1);
  });
});

describe('the scope predicates agree with what walkProject walks', () => {
  const CASES: ReadonlyArray<readonly string[]> = [
    [],
    ['.agents'],
    ['.agents', '.agents/.cache'],
    ['.github/workflows'],
    ['packages/x/.agents', '.github'],
    ['..scratch'],
  ];

  it.each(CASES.map((c) => [c]))('include_dot_dirs = %j', async (dotDirs) => {
    const viaWalker = await walked(dotDirs);
    const config = resolveConfig({ projectRoot: root });
    const excludes = config.exclude_patterns.map(globToRegex);

    const viaPredicate = everyFileOnDisk()
      .filter((rel) => config.file_extensions.includes(extname(rel)))
      .filter((rel) => !excludes.some((rx) => rx.test(rel)))
      .filter((rel) => isFileInDotScope(rel, config.include_dot_dirs))
      .sort();

    expect(viaPredicate).toEqual([...viaWalker].sort());
  });

  it('never prunes a directory that holds a walked file', async () => {
    const dotDirs = ['.agents', '.github/workflows', 'packages/x/.agents'];

    for (const file of await walked(dotDirs)) {
      const segments = file.split('/').slice(0, -1);
      for (let i = 1; i <= segments.length; i++) {
        const directory = segments.slice(0, i).join('/');
        expect(isDirectoryInDotScope(directory, dotDirs), directory).toBe(true);
      }
    }
  });
});

/**
 * The watcher never reports a path inside the state directory, whatever it is
 * called. The walker used to keep it out only through the default pattern
 * `.mast/**`, so a state directory with another name was indexed and its edits
 * were never heard (D076).
 */
describe('walkProject — the state directory', () => {
  let project: string;

  beforeAll(() => {
    project = mkdtempSync(join(tmpdir(), 'mast-state-dir-'));
    for (const rel of ['src/a.ts', 'mast-state/notes.md', 'mast-state-old/kept.md']) {
      mkdirSync(join(project, dirname(rel)), { recursive: true });
      writeFileSync(join(project, rel), '# heading\n');
    }
    writeFileSync(join(project, 'mast.config.json'), JSON.stringify({ state_dir: 'mast-state' }));
  });

  afterAll(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it('is not walked when its name has no leading dot', async () => {
    const entries = await walkProject(resolveConfig({ projectRoot: project }));

    expect(entries.map((e) => e.relativePath)).toEqual(['mast-state-old/kept.md', 'src/a.ts']);
  });

  it('is not walked when it is given as an absolute path', async () => {
    const config = resolveConfig({ projectRoot: project, stateDirOverride: join(project, 'mast-state') });

    expect((await walkProject(config)).map((e) => e.relativePath)).not.toContain('mast-state/notes.md');
  });

  it('leaves the walk alone when it is outside the project', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'mast-state-outside-'));
    try {
      const config = resolveConfig({ projectRoot: project, stateDirOverride: outside });

      expect((await walkProject(config)).map((e) => e.relativePath)).toContain('mast-state/notes.md');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('isDirectoryInDotScope', () => {
  it('prunes a dot directory that was not named', () => {
    expect(isDirectoryInDotScope('.git', ['.agents'])).toBe(false);
  });

  it('prunes a dot directory nested inside a named one', () => {
    expect(isDirectoryInDotScope('.agents/.cache', ['.agents'])).toBe(false);
  });

  it('keeps the dot-leading parent of a named subdirectory, so the watcher can reach it', () => {
    expect(isDirectoryInDotScope('.github', ['.github/workflows'])).toBe(true);
  });

  it('prunes the siblings of a named subdirectory', () => {
    expect(isDirectoryInDotScope('.github/actions', ['.github/workflows'])).toBe(false);
  });

  it('keeps an ordinary directory', () => {
    expect(isDirectoryInDotScope('src/indexer', [])).toBe(true);
  });
});

describe('normalizeDotDirs', () => {
  it('strips a leading ./ and a trailing slash', () => {
    expect(normalizeDotDirs(['./.agents/', '.github/workflows//'])).toEqual(['.agents', '.github/workflows']);
  });

  it('drops a repeated entry', () => {
    expect(normalizeDotDirs(['.agents', './.agents'])).toEqual(['.agents']);
  });

  it.each([
    ['an absolute path', '/etc/.agents'],
    ['a path that leaves the project', '../.agents'],
    ['a path that leaves the project midway', '.agents/../../x'],
    ['a glob', '.agents/**'],
    ['a glob', '**/.agents'],
    ['an empty entry', ''],
    ['a directory with no dot-leading segment', 'docs/internal'],
    ['a backslash, which fast-glob reads as an escape', '.b\\c'],
    ['a pipe, which fast-glob reads as alternation', '.a|b'],
    ['leading whitespace', ' .agents'],
    // Trailing is the case only the whitespace rule rejects: a leading space also
    // leaves the entry with no dot-leading segment.
    ['trailing whitespace', '.agents '],
  ])('rejects %s (%j)', (_label, entry) => {
    expect(() => normalizeDotDirs([entry])).toThrow(InvalidDotDirError);
  });

  it('names the offending entry in the error', () => {
    expect(() => normalizeDotDirs(['.agents', '**/.x'])).toThrow(/"\*\*\/\.x"/);
  });
});
