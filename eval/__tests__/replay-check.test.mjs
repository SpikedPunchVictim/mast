import { describe, it, expect } from 'vitest';
import { diffDumps, verdictOf, classifyImportedName, parseArgs } from '../replay-check.mjs';

describe('diffDumps', () => {
  it('reports nothing when the replayed graph holds the same lines as the full index', () => {
    const diff = diffDumps(['b', 'a'], ['a', 'b']);

    expect(diff).toEqual({ missing: [], extra: [] });
  });

  it('reports a line only the full index holds as missing', () => {
    const diff = diffDumps(['a'], ['a', 'b']);

    expect(diff).toEqual({ missing: ['b'], extra: [] });
  });

  it('reports a line only the replayed graph holds as extra', () => {
    const diff = diffDumps(['a', 'stale'], ['a']);

    expect(diff).toEqual({ missing: [], extra: ['stale'] });
  });

  it('counts a repeated line once', () => {
    const diff = diffDumps(['a'], ['a', 'b', 'b']);

    expect(diff.missing).toEqual(['b']);
  });
});

describe('verdictOf', () => {
  const clean = { missing: 0, extra: 0, pendingRepairs: 0, staleFiles: 0, steps: 3 };

  it('passes when nothing differs and nothing is left waiting', () => {
    expect(verdictOf(clean)).toEqual({ pass: true, reasons: [] });
  });

  it('fails on a missing line', () => {
    expect(verdictOf({ ...clean, missing: 2 }).pass).toBe(false);
  });

  // Stricter than T12's wording ("nothing missing"): a line a full index does not
  // have is a stale edge, and a stale edge is a wrong answer too.
  it('fails on an extra line', () => {
    expect(verdictOf({ ...clean, extra: 1 }).pass).toBe(false);
  });

  it('fails when repairs are still pending, since the graphs were compared too early', () => {
    expect(verdictOf({ ...clean, pendingRepairs: 4 }).pass).toBe(false);
  });

  // A replay of no commits compares a full index with a full index and proves nothing.
  it('fails when no commit was replayed', () => {
    const verdict = verdictOf({ ...clean, steps: 0 });

    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toEqual(['no commit was replayed']);
  });

  it('names every reason it failed', () => {
    const verdict = verdictOf({ ...clean, missing: 1, extra: 1 });

    expect(verdict.reasons).toEqual([
      '1 line of the full index is missing after the replay',
      '1 line after the replay is not in the full index',
    ]);
  });
});

describe('classifyImportedName', () => {
  it('is found when an edge to that name is stored', () => {
    expect(classifyImportedName({ importRow: { resolvedPath: 'src/a.ts' }, edgeStored: true })).toBe('found');
  });

  it('is not found when the import resolved to a file and no edge is stored', () => {
    expect(classifyImportedName({ importRow: { resolvedPath: 'src/a.ts' }, edgeStored: false })).toBe('not_found');
  });

  it('is a package or unresolved specifier when the import row has no path', () => {
    expect(classifyImportedName({ importRow: { resolvedPath: null }, edgeStored: false })).toBe('package_or_unresolved');
  });

  it('is without an import row when no import of the file lists the name', () => {
    expect(classifyImportedName({ importRow: null, edgeStored: false })).toBe('no_import_row');
  });

  // An edge found some other way (a same-file declaration) is still an edge.
  it('is found when an edge is stored although no import row lists the name', () => {
    expect(classifyImportedName({ importRow: null, edgeStored: true })).toBe('found');
  });
});

describe('parseArgs', () => {
  it('defaults to 100 commits of this repository', () => {
    const args = parseArgs([]);

    expect(args.commits).toBe(100);
    expect(args.repo).toBeNull();
    expect(args.name).toBe('mast');
  });

  it('reads --repo, --commits and --name', () => {
    const args = parseArgs(['--repo', '/tmp/x', '--commits', '20', '--name', 'n8n']);

    expect(args).toMatchObject({ repo: '/tmp/x', commits: 20, name: 'n8n' });
  });

  it('refuses a commit count that is not a positive whole number', () => {
    expect(() => parseArgs(['--commits', '0'])).toThrow(/--commits/);
    expect(() => parseArgs(['--commits', 'ten'])).toThrow(/--commits/);
  });

  it('refuses another repository without a name for its result file', () => {
    expect(() => parseArgs(['--repo', '/tmp/x'])).toThrow(/--name/);
  });

  it('refuses an argument it does not know', () => {
    expect(() => parseArgs(['--comits', '5'])).toThrow(/--comits/);
  });
});
