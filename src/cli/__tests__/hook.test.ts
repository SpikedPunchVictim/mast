import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, runHook, SEARCH_REMINDER, type HookIo } from '../hook.js';

const DEFAULT_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.md'];
const withIndex = { indexExists: true, primeText: 'PRIMER', searchPathIsDirectory: false, indexedExtensions: DEFAULT_EXTS };
const noIndex = { ...withIndex, indexExists: false };

describe('decide: envelope shape per harness and event', () => {
  it.each([
    ['claude', 'session-start', { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'PRIMER' } }],
    ['vscode', 'session-start', { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'PRIMER' } }],
    ['cursor', 'session-start', { additional_context: 'PRIMER' }],
    ['claude', 'search', { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: SEARCH_REMINDER } }],
    ['vscode', 'search', { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: SEARCH_REMINDER } }],
    ['cursor', 'search', { additional_context: SEARCH_REMINDER }],
  ])('%s %s', (harness, event, expected) => {
    expect(decide(harness, event, { tool_input: { pattern: 'x' } }, withIndex)).toEqual(expected);
  });

  it('emits session-start even when no index exists', () => {
    expect(decide('cursor', 'session-start', {}, noIndex)).toEqual({ additional_context: 'PRIMER' });
  });

  it.each([['nope', 'search'], ['claude', 'nope'], ['', '']])('is quiet for harness %j event %j', (h, e) => {
    expect(decide(h, e, {}, withIndex)).toBeNull();
  });

  it('keeps the reminder to one line that names mast_search', () => {
    expect(SEARCH_REMINDER).not.toContain('\n');
    expect(SEARCH_REMINDER).toContain('mast_search');
  });
});

describe('decide: search reminder is quiet when it would be wrong', () => {
  const grep = (tool_input: unknown, tool_name = 'Grep'): unknown => ({ tool_name, tool_input });

  it('is quiet when no index exists', () => {
    expect(decide('claude', 'search', grep({ pattern: 'x' }), noIndex)).toBeNull();
  });

  it.each([
    ['type py', { pattern: 'x', type: 'py' }, false],
    ['type ts', { pattern: 'x', type: 'ts' }, true],
    ['type js', { pattern: 'x', type: 'js' }, true],
    ['type md', { pattern: 'x', type: 'md' }, true],
    ['unknown type', { pattern: 'x', type: 'zzz' }, false],
    ['glob *.py', { pattern: 'x', glob: '*.py' }, false],
    ['glob **/*.{go,rs}', { pattern: 'x', glob: '**/*.{go,rs}' }, false],
    ['glob *.{ts,py}', { pattern: 'x', glob: '*.{ts,py}' }, true],
    ['glob src/**', { pattern: 'x', glob: 'src/**' }, true],
    ['glob *.[jt]s (undeterminable)', { pattern: 'x', glob: '*.[jt]s' }, true],
    ['path scripts/build.py', { pattern: 'x', path: 'scripts/build.py' }, false],
    ['path src', { pattern: 'x', path: 'src' }, true],
    ['path src/index.ts', { pattern: 'x', path: 'src/index.ts' }, true],
    ['path v1.2 (numeric suffix is not an extension)', { pattern: 'x', path: 'pkg/v1.2' }, true],
    ['a regex pattern ending in .py is not scoping', { pattern: '\\.py$' }, true],
    ['non-string scoping fields are ignored', { pattern: 'x', type: 3, glob: [], path: null }, true],
    ['type ts but glob *.py', { pattern: 'x', type: 'ts', glob: '*.py' }, false],
  ])('Grep %s', (_name, toolInput, emitted) => {
    const out = decide('claude', 'search', grep(toolInput), withIndex);
    expect(out !== null).toBe(emitted);
  });

  it.each([
    ['glob *.mjs', { pattern: 'x', glob: '*.mjs' }],
    ['path scripts/build.mjs', { pattern: 'x', path: 'scripts/build.mjs' }],
    ['type vue (no ripgrep mapping, read as the extension)', { pattern: 'x', type: 'vue' }],
  ])('follows the project\'s own extension list: %s', (_name, toolInput) => {
    const custom = { ...withIndex, indexedExtensions: [...DEFAULT_EXTS, '.mjs', '.vue'] };

    expect({
      withDefaults: decide('claude', 'search', grep(toolInput), withIndex) !== null,
      withCustom: decide('claude', 'search', grep(toolInput), custom) !== null,
    }).toEqual({ withDefaults: false, withCustom: true });
  });

  it('does not read a dotted directory name as a file extension (next.js, site.io)', () => {
    const facts = { ...withIndex, searchPathIsDirectory: true };

    expect(decide('claude', 'search', grep({ pattern: 'x', path: '/work/site.io' }), facts)).not.toBeNull();
  });

  it.each([
    ['**/*.rs', false],
    ['src/**/*.ts', true],
    ['**/*', true],
  ])('Glob tool pattern %s', (pattern, emitted) => {
    expect((decide('claude', 'search', grep({ pattern }, 'Glob'), withIndex) !== null)).toBe(emitted);
  });

  it.each([
    ['no tool_input', { tool_name: 'Grep' }],
    ['tool_input not an object', { tool_name: 'Grep', tool_input: 'x' }],
    ['input not an object', 'garbage'],
    ['input null', null],
  ])('treats %s as not scoped and emits', (_name, input) => {
    expect(decide('cursor', 'search', input, withIndex)).not.toBeNull();
  });
});

function makeIo(over: Partial<HookIo> & { stdin?: string } = {}): { io: HookIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: HookIo = {
    readStdin: () => Promise.resolve(over.stdin ?? ''),
    write: (t) => { out.push(t); },
    warn: (l) => { err.push(l); },
    env: {},
    cwd: () => '/nonexistent-cwd',
    fileExists: () => false,
    isDirectory: () => false,
    prime: () => Promise.resolve('PRIMER\n'),
    ...over,
  };
  return { io, out, err };
}

describe('runHook shell', () => {
  it.each([
    ['empty stdin', ''],
    ['not json', 'garbage{'],
    ['json of the wrong shape', '[1,2]'],
  ])('writes nothing to stdout for %s', async (_n, stdin) => {
    const { io, out, err } = makeIo({ stdin });
    await runHook('claude', 'session-start', io);
    expect(out).toEqual([]);
    expect(err.length).toBe(1);
  });

  it('writes nothing for an unknown harness, with a stderr line', async () => {
    const { io, out, err } = makeIo({ stdin: '{}' });
    await runHook('emacs', 'search', io);
    expect(out).toEqual([]);
    expect(err[0]).toContain('emacs');
  });

  it('writes nothing for a search in a directory with no index, and says nothing on stderr', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mast-hook-'));
    try {
      const { io, out, err } = makeIo({
        stdin: JSON.stringify({ cwd: dir, tool_name: 'Grep', tool_input: { pattern: 'x' } }),
        fileExists: (p) => p === join(dir, 'never'),
      });
      await runHook('claude', 'search', io);
      expect(out).toEqual([]);
      expect(err).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('emits for a search whose path is a dotted directory, resolved against the project root', async () => {
    const asked: string[] = [];
    const { io, out } = makeIo({
      stdin: JSON.stringify({ cwd: '/work', tool_name: 'Grep', tool_input: { pattern: 'x', path: 'apps/site.io' } }),
      fileExists: () => true,
      isDirectory: (p) => { asked.push(p); return true; },
    });

    await runHook('claude', 'search', io);

    expect({ emitted: out.length, asked }).toEqual({ emitted: 1, asked: ['/work/apps/site.io'] });
  });

  it('reminds for an .mjs search in a project whose mast.config.json indexes .mjs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mast-hook-'));
    try {
      writeFileSync(join(dir, 'mast.config.json'), JSON.stringify({ file_extensions: ['.ts', '.mjs'] }));
      const { io, out } = makeIo({
        stdin: JSON.stringify({ cwd: dir, tool_name: 'Grep', tool_input: { pattern: 'x', glob: '**/*.mjs' } }),
        fileExists: () => true,
      });

      await runHook('claude', 'search', io);

      expect(out.length).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('looks for the index under the state dir of the project root taken from workspace_roots (cursor)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mast-hook-'));
    try {
      mkdirSync(join(dir, '.mast'));
      writeFileSync(join(dir, '.mast', 'index.json'), '{}');
      const { io, out } = makeIo({
        stdin: JSON.stringify({ workspace_roots: [dir], tool_name: 'Grep', tool_input: { pattern: 'x' } }),
        fileExists: (p) => p === join(dir, '.mast', 'index.json'),
      });
      await runHook('cursor', 'search', io);
      expect(JSON.parse(out.join(''))).toEqual({ additional_context: SEARCH_REMINDER });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('passes the primer for the stdin cwd into the session-start envelope', async () => {
    const seen: string[] = [];
    const { io, out } = makeIo({
      stdin: JSON.stringify({ cwd: '/work/p' }),
      prime: (root) => { seen.push(root); return Promise.resolve('PRIMER-TEXT\n'); },
    });
    await runHook('claude', 'session-start', io);
    expect(seen).toEqual(['/work/p']);
    expect(JSON.parse(out.join(''))).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'PRIMER-TEXT\n' },
    });
  });

  it('stays quiet on stdout when the primer throws, and reports it on stderr', async () => {
    const { io, out, err } = makeIo({
      stdin: '{"cwd":"/work/p"}',
      prime: () => Promise.reject(new Error('boom')),
    });
    await runHook('claude', 'session-start', io);
    expect(out).toEqual([]);
    expect(err[0]).toContain('boom');
  });
});
