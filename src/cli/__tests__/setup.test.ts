import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { runSetup, createNodeSetupIo, type SetupEnv, type SetupIo, type SetupOptions } from '../setup-cmd.js';
import { decide, type HookFacts } from '../hook.js';

const ENTRY = '/opt/mast/dist/cli/index.js';

interface Sandbox {
  root: string;
  home: string;
  writes: string[];
  out: string[];
  err: string[];
  io: SetupIo;
  run(harness: string, flags?: Partial<SetupOptions>, env?: Partial<SetupEnv>): number;
  read(path: string): string;
}

function sandbox(): Sandbox {
  const base = mkdtempSync(join(tmpdir(), 'mast-setup-'));
  const root = join(base, 'project');
  const home = join(base, 'home');
  mkdirSync(root);
  mkdirSync(home);
  const real = createNodeSetupIo();
  const writes: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const io: SetupIo = {
    ...real,
    writeFileAtomic: (path, content) => { writes.push(path); real.writeFileAtomic(path, content); },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return {
    root, home, writes, out, err, io,
    run: (harness, flags = {}, env = {}) =>
      runSetup(
        { harness, projectRoot: root, global: false, check: false, remove: false, dryRun: false, ...flags },
        { installKind: 'global', home, cliEntry: ENTRY, ...env },
        io,
      ),
    read: (path) => readFileSync(path, 'utf8'),
  };
}

const put = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

describe('mast setup claude', () => {
  let sb: Sandbox;
  let file: string;
  beforeEach(() => {
    sb = sandbox();
    file = join(sb.root, '.claude', 'settings.json');
  });

  it('creates the settings file with both hooks', () => {
    expect(sb.run('claude')).toBe(0);

    expect(json(file)).toEqual({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'mast hook claude session-start', timeout: 30 }] }],
        PreToolUse: [{ matcher: 'Grep|Glob', hooks: [{ type: 'command', command: 'mast hook claude search', timeout: 5 }] }],
      },
    });
    expect(sb.read(file).endsWith('\n')).toBe(true);
    expect(sb.out[0]).toBe(`${file}: installed`);
  });

  const foreign = {
    permissions: { allow: ['Bash(ls)'] },
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'say done', extra: 1 }] }],
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: './check.sh', timeout: 9, note: 'keep' }], tag: 'x' },
      ],
    },
    zzz: [1, 2],
  };

  it('keeps every key it does not own, in order, when merging', () => {
    put(file, JSON.stringify(foreign, null, 2) + '\n');

    sb.run('claude');

    const merged = json(file) as typeof foreign;
    expect(merged.permissions).toEqual(foreign.permissions);
    expect(merged.hooks.Stop).toEqual(foreign.hooks.Stop);
    expect(merged.hooks.PreToolUse[0]).toEqual(foreign.hooks.PreToolUse[0]);
    expect(merged.hooks.PreToolUse).toHaveLength(2);
    expect(Object.keys(merged)).toEqual(['permissions', 'hooks', 'zzz']);
  });

  it('is a byte-level no-op the second time, and does not write', () => {
    put(file, JSON.stringify(foreign, null, 2) + '\n');
    sb.run('claude');
    const before = sb.read(file);
    const past = new Date(2020, 0, 1);
    utimesSync(file, past, past);
    sb.writes.length = 0;
    sb.out.length = 0;

    expect(sb.run('claude')).toBe(0);

    expect(sb.read(file)).toBe(before);
    expect(sb.writes).toEqual([]);
    expect(statSync(file).mtimeMs).toBe(past.getTime());
    expect(sb.out[0]).toBe(`${file}: already up to date`);
  });

  it('replaces its own entry in place when the install kind changes, without duplicating', () => {
    sb.run('claude', {}, { installKind: 'source' });

    sb.run('claude', {}, { installKind: 'global' });

    const hooks = (json(file) as { hooks: { SessionStart: { hooks: { command: string }[] }[] } }).hooks;
    expect(hooks.SessionStart).toEqual([{ hooks: [{ type: 'command', command: 'mast hook claude session-start', timeout: 30 }] }]);
    expect(sb.out.at(-1)).toBe(`${file}: updated`);
  });

  it('drops a second copy of its own entry', () => {
    const mastHandler = { type: 'command', command: 'mast hook claude search', timeout: 5 };
    put(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Grep|Glob', hooks: [mastHandler] }, { matcher: 'Grep|Glob', hooks: [mastHandler] }] } }));
    sb.run('claude');

    const groups = (json(file) as { hooks: { PreToolUse: { matcher: string }[] } }).hooks.PreToolUse;
    expect(groups).toHaveLength(1);
  });

  it('removes only its own handler, keeping a foreign handler in the same group', () => {
    put(
      file,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'mast hook claude session-start', timeout: 30 }] }],
          PreToolUse: [
            { matcher: 'Grep|Glob', hooks: [{ type: 'command', command: './mine.sh' }, { type: 'command', command: 'mast hook claude search', timeout: 5 }] },
          ],
        },
        keep: true,
      }),
    );

    expect(sb.run('claude', { remove: true })).toBe(0);

    expect(json(file)).toEqual({
      hooks: { PreToolUse: [{ matcher: 'Grep|Glob', hooks: [{ type: 'command', command: './mine.sh' }] }] },
      keep: true,
    });
    expect(sb.out[0]).toBe(`${file}: removed`);
  });

  it('leaves the file in place, with an empty hooks object, when remove empties it', () => {
    sb.run('claude');

    sb.run('claude', { remove: true });

    expect(json(file)).toEqual({ hooks: {} });
  });

  it('treats remove with nothing installed as a no-op that exits 0 and creates nothing', () => {
    expect(sb.run('claude', { remove: true })).toBe(0);

    expect(existsSync(file)).toBe(false);
    expect(sb.out[0]).toBe(`${file}: not installed`);
  });

  it.each([
    ['not valid JSON', '{ "hooks": '],
    ['a hooks value of the wrong shape', '{ "hooks": { "PreToolUse": {} } }'],
    ['a top-level array', '[]'],
  ])('leaves a file with %s byte-for-byte alone and exits 1', (_name, text) => {
    put(file, text);

    expect(sb.run('claude')).toBe(1);

    expect(sb.read(file)).toBe(text);
    expect(sb.err.join('\n')).toContain(file);
    expect(sb.writes).toEqual([]);
  });

  it('leaves a malformed file alone on --remove too', () => {
    put(file, 'nope');

    expect(sb.run('claude', { remove: true })).toBe(1);
    expect(sb.read(file)).toBe('nope');
  });

  describe('--check', () => {
    it('exits 1 and names the file when nothing is installed', () => {
      expect(sb.run('claude', { check: true })).toBe(1);
      expect(sb.out[0]).toBe(`${file}: not installed`);
      expect(existsSync(file)).toBe(false);
    });

    it('exits 0 when current', () => {
      sb.run('claude');
      expect(sb.run('claude', { check: true })).toBe(0);
    });

    it('exits 1 and says which hook is out of date', () => {
      sb.run('claude', {}, { installKind: 'source' });
      sb.out.length = 0;

      expect(sb.run('claude', { check: true })).toBe(1);

      expect(sb.out).toContain('  out of date: SessionStart');
    });

    it('exits 1 and says which hook is missing', () => {
      put(file, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'mast hook claude session-start', timeout: 30 }] }] } }));

      expect(sb.run('claude', { check: true })).toBe(1);

      expect(sb.out).toContain('  missing: PreToolUse');
    });
  });

  it('--dry-run prints the content and writes nothing', () => {
    expect(sb.run('claude', { dryRun: true })).toBe(0);

    expect(existsSync(file)).toBe(false);
    expect(sb.out.join('\n')).toContain('"SessionStart"');
  });

  it('--dry-run with --remove writes nothing', () => {
    sb.run('claude');
    const before = sb.read(file);

    sb.run('claude', { remove: true, dryRun: true });

    expect(sb.read(file)).toBe(before);
  });

  it.each([
    ['four spaces', '    ', true],
    ['a tab', '\t', true],
    ['two spaces and no trailing newline', '  ', false],
  ])('keeps the indentation and trailing newline of the existing file: %s', (_name, indent, newline) => {
    put(file, JSON.stringify({ keep: { a: 1 } }, null, indent) + (newline ? '\n' : ''));

    sb.run('claude');

    const text = sb.read(file);
    expect(text).toContain(`\n${indent}"keep": {\n${indent}${indent}"a": 1`);
    expect(text.endsWith('\n')).toBe(newline);
  });

  it('--global writes under the home directory and not the project', () => {
    sb.run('claude', { global: true });

    expect(existsSync(join(sb.home, '.claude', 'settings.json'))).toBe(true);
    expect(existsSync(join(sb.root, '.claude'))).toBe(false);
  });

  it('refuses --global for a project-dependency install, writing nothing', () => {
    expect(sb.run('claude', { global: true }, { installKind: 'local' })).toBe(1);

    expect(readdirSync(sb.home)).toEqual([]);
    expect(sb.err.join('\n')).toContain('Install mast globally');
  });

  it('writes the local-install command and fails when node_modules/.bin/mast is absent', () => {
    expect(sb.run('claude', {}, { installKind: 'local' })).toBe(1);
    expect(existsSync(file)).toBe(false);

    put(join(sb.root, 'node_modules', '.bin', 'mast'), '');
    expect(sb.run('claude', {}, { installKind: 'local' })).toBe(0);
    expect(JSON.stringify(json(file))).toContain('node_modules/.bin/mast hook claude session-start');
    expect(sb.read(file)).toContain('\\"${CLAUDE_PROJECT_DIR}\\"/node_modules/.bin/mast');
  });

  it('notes that a source-checkout path is machine-specific', () => {
    sb.run('claude', {}, { installKind: 'source' });

    expect(sb.out.join('\n')).toContain('do not commit this file');
  });
});

describe('mast setup cursor', () => {
  let sb: Sandbox;
  let file: string;
  beforeEach(() => {
    sb = sandbox();
    file = join(sb.root, '.cursor', 'hooks.json');
  });

  it('creates hooks.json with a version and both hooks', () => {
    sb.run('cursor');

    expect(json(file)).toEqual({
      version: 1,
      hooks: {
        sessionStart: [{ command: 'mast hook cursor session-start', type: 'command', timeout: 30 }],
        postToolUse: [{ command: 'mast hook cursor search', type: 'command', matcher: 'Grep', timeout: 5 }],
      },
    });
  });

  it('keeps foreign hooks and unknown fields when merging, and when removing', () => {
    const foreign = { version: 1, extra: { a: 1 }, hooks: { postToolUse: [{ command: './audit.sh', matcher: 'Write', unknown: true }], stop: [{ command: './s.sh' }] } };
    put(file, JSON.stringify(foreign, null, 2) + '\n');

    sb.run('cursor');
    const merged = json(file) as { hooks: { postToolUse: { command: string }[] } };
    expect(merged.hooks.postToolUse[0]).toEqual(foreign.hooks.postToolUse[0]);
    expect(merged.hooks.postToolUse).toHaveLength(2);

    sb.run('cursor', { remove: true });
    expect(json(file)).toEqual(foreign);
  });

  it('replaces a changed command in place', () => {
    sb.run('cursor', {}, { installKind: 'source' });
    sb.run('cursor');

    const hooks = (json(file) as { hooks: { sessionStart: { command: string }[] } }).hooks;
    expect(hooks.sessionStart).toEqual([{ command: 'mast hook cursor session-start', type: 'command', timeout: 30 }]);
  });

  it('is a byte-level no-op the second time', () => {
    sb.run('cursor');
    sb.writes.length = 0;

    sb.run('cursor');

    expect(sb.writes).toEqual([]);
  });
});

describe('mast setup vscode', () => {
  let sb: Sandbox;
  beforeEach(() => { sb = sandbox(); });

  it('installs the session primer only, and says why there is no search hook', () => {
    sb.run('vscode');

    expect(json(join(sb.root, '.github', 'hooks', 'mast.json'))).toEqual({
      hooks: { SessionStart: [{ type: 'command', command: 'mast hook vscode session-start', timeout: 30 }] },
    });
    expect(sb.out.join('\n')).toContain('Only the session primer is installed');
  });

  it('--global writes ~/.copilot/hooks/mast.json', () => {
    sb.run('vscode', { global: true });

    expect(existsSync(join(sb.home, '.copilot', 'hooks', 'mast.json'))).toBe(true);
  });

  it('--remove deletes the file when nothing else is in it', () => {
    sb.run('vscode');

    sb.run('vscode', { remove: true });

    expect(existsSync(join(sb.root, '.github', 'hooks', 'mast.json'))).toBe(false);
  });

  it('--remove keeps the file when it holds something that is not mast\'s', () => {
    const file = join(sb.root, '.github', 'hooks', 'mast.json');
    put(file, JSON.stringify({ hooks: { SessionStart: [{ type: 'command', command: './other.sh' }, { type: 'command', command: 'mast hook vscode session-start', timeout: 30 }] } }));

    sb.run('vscode', { remove: true });

    expect(json(file)).toEqual({ hooks: { SessionStart: [{ type: 'command', command: './other.sh' }] } });
  });

  it('notes that the relative local command is unverified', () => {
    put(join(sb.root, 'node_modules', '.bin', 'mast'), '');
    sb.run('vscode', {}, { installKind: 'local' });

    expect(sb.out.join('\n')).toContain('unverified');
  });
});

describe('mast setup usage errors', () => {
  it('rejects an unknown harness with exit 2, naming the supported ones', () => {
    const sb = sandbox();

    expect(sb.run('windsurf')).toBe(2);

    expect(sb.err.join('\n')).toContain('claude, cursor, vscode');
  });

  it.each([{ remove: true }, { dryRun: true }])('rejects --check with %j', (flags) => {
    const sb = sandbox();

    expect(sb.run('claude', { check: true, ...flags })).toBe(2);
  });
});

describe('installer and hook entry agree', () => {
  const facts: HookFacts = { indexExists: true, primeText: 'P', searchPathIsDirectory: false, indexedExtensions: ['.ts'] };

  const commandsIn = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.flatMap(commandsIn);
    if (typeof value !== 'object' || value === null) return [];
    return Object.entries(value).flatMap(([k, v]) => (k === 'command' && typeof v === 'string' ? [v] : commandsIn(v)));
  };

  it.each(['claude', 'cursor', 'vscode'])('every %s command is one `mast hook` accepts', (harness) => {
    const sb = sandbox();
    sb.run(harness);
    const file = { claude: '.claude/settings.json', cursor: '.cursor/hooks.json', vscode: '.github/hooks/mast.json' }[harness];
    if (file === undefined) throw new Error('unreachable');

    const commands = commandsIn(json(join(sb.root, file)));

    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      const m = /^mast hook (\S+) (\S+)$/.exec(command);
      expect(m, command).not.toBeNull();
      expect(decide(m?.[1] ?? '', m?.[2] ?? '', { tool_name: 'Grep', tool_input: { pattern: 'x' } }, facts), command).not.toBeNull();
    }
  });
});
