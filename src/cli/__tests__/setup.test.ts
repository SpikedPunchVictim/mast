import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { runSetup, createNodeSetupIo, type SetupEnv, type SetupIo, type SetupOptions } from '../setup-cmd.js';
import { decide, type HookFacts } from '../hook.js';
import { BEGIN_MARKER } from '../skill-install.js';

const ENTRY = '/opt/mast/dist/cli/index.js';
const SKILL = '# Using MAST\n\nBody line.\n';

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
        { installKind: 'global', home, cliEntry: ENTRY, skillText: SKILL, ...env },
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

  it('finds a project dependency installed below the project root, and --check then passes', () => {
    const nested = join(sb.root, 'typescript', 'node_modules');
    put(join(nested, '.bin', 'mast'), '');
    const env = { installKind: 'local' as const, cliEntry: join(nested, '@spikedpunch', 'mast', 'dist', 'cli', 'index.js') };

    const installed = sb.run('claude', {}, env);
    const checked = sb.run('claude', { check: true }, env);

    expect({ installed, checked }).toEqual({ installed: 0, checked: 0 });
    expect(sb.read(file)).toContain('\\"${CLAUDE_PROJECT_DIR}\\"/typescript/node_modules/.bin/mast hook claude search');
  });

  it('names every place it looked when a project dependency has no binary', () => {
    const env = { installKind: 'local' as const, cliEntry: join(sb.root, 'typescript', 'node_modules', '@spikedpunch', 'mast', 'dist', 'cli', 'index.js') };

    sb.run('claude', {}, env);

    expect(sb.err.join('\n')).toContain(join('typescript', 'node_modules', '.bin', 'mast'));
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

    expect(sb.run('emacs')).toBe(2);

    expect(sb.err.join('\n')).toContain('claude, cursor, vscode, windsurf, zed, desktop');
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

describe('mast setup cursor: the rules file', () => {
  let sb: Sandbox;
  let rules: string;
  let hooks: string;
  beforeEach(() => {
    sb = sandbox();
    rules = join(sb.root, '.cursor', 'rules', 'mast.mdc');
    hooks = join(sb.root, '.cursor', 'hooks.json');
  });

  it('writes .cursor/rules/mast.mdc beside the hooks, one line per file', () => {
    expect(sb.run('cursor')).toBe(0);

    expect(sb.read(rules)).toContain('alwaysApply: true');
    expect(sb.read(rules)).toContain('Body line.');
    expect(sb.out.filter((l) => l.startsWith(sb.root))).toEqual([`${hooks}: installed`, `${rules}: installed`]);
  });

  it('is a byte-level no-op the second time and does not write the rules file', () => {
    sb.run('cursor');
    sb.writes.length = 0;

    expect(sb.run('cursor')).toBe(0);

    expect(sb.writes).toEqual([]);
    expect(sb.out).toContain(`${rules}: already up to date`);
  });

  it('--check is 0 only when both files are current', () => {
    sb.run('cursor');
    expect(sb.run('cursor', { check: true })).toBe(0);
  });

  it('--check is 1 when the hooks are current and the rules file is missing', () => {
    sb.run('cursor');
    rmSync(rules);

    expect(sb.run('cursor', { check: true })).toBe(1);
    expect(sb.out).toContain(`${rules}: not installed`);
  });

  it('--check is 1 when the rules file is current and the hooks are missing', () => {
    sb.run('cursor');
    rmSync(hooks);

    expect(sb.run('cursor', { check: true })).toBe(1);
  });

  it('--remove deletes the rules file as well as the hooks', () => {
    sb.run('cursor');

    expect(sb.run('cursor', { remove: true })).toBe(0);

    expect(existsSync(rules)).toBe(false);
    expect(sb.out).toContain(`${rules}: removed`);
  });

  it('--global handles the hooks, writes no rules file, and says Cursor has no user-level one', () => {
    expect(sb.run('cursor', { global: true })).toBe(0);

    expect(existsSync(join(sb.home, '.cursor', 'hooks.json'))).toBe(true);
    expect(existsSync(rules)).toBe(false);
    expect(existsSync(join(sb.home, '.cursor', 'rules'))).toBe(false);
    expect(sb.out.join('\n')).toMatch(/no user-level rules file/);
  });

  it('--dry-run writes neither file', () => {
    expect(sb.run('cursor', { dryRun: true })).toBe(0);

    expect(sb.writes).toEqual([]);
    expect(sb.out).toContain(`${rules}: installed (dry run, nothing written)`);
  });
});

describe('mast setup windsurf', () => {
  let sb: Sandbox;
  let rules: string;
  beforeEach(() => {
    sb = sandbox();
    rules = join(sb.root, '.windsurf', 'rules', 'mast.md');
  });

  it('says first that there is no hook system, then installs the rules file', () => {
    expect(sb.run('windsurf')).toBe(0);

    expect(sb.out[0]).toMatch(/no hook system.*only static instructions/);
    expect(sb.read(rules)).toMatch(/^---\ntrigger: always_on\n---\n/);
    expect(sb.out).toContain(`${rules}: installed`);
  });

  it('writes under .devin/rules when a .devin directory exists', () => {
    mkdirSync(join(sb.root, '.devin'));

    sb.run('windsurf');

    expect(existsSync(join(sb.root, '.devin', 'rules', 'mast.md'))).toBe(true);
    expect(existsSync(rules)).toBe(false);
  });

  it('refuses --global with exit 1 and writes nothing', () => {
    expect(sb.run('windsurf', { global: true })).toBe(1);

    expect(sb.writes).toEqual([]);
    expect(sb.err.join('\n')).toMatch(/no user-level rules file/);
  });

  it('is a byte-level no-op the second time', () => {
    sb.run('windsurf');
    sb.writes.length = 0;

    expect(sb.run('windsurf')).toBe(0);

    expect(sb.writes).toEqual([]);
    expect(sb.out).toContain(`${rules}: already up to date`);
  });

  it('overwrites an out-of-date file and reports updated', () => {
    put(rules, 'stale\n');

    sb.run('windsurf');

    expect(sb.read(rules)).toContain('Body line.');
    expect(sb.out).toContain(`${rules}: updated`);
  });

  it('--check exits 1 when absent or different, 0 when current', () => {
    expect(sb.run('windsurf', { check: true })).toBe(1);
    put(rules, 'stale\n');
    expect(sb.run('windsurf', { check: true })).toBe(1);
    expect(sb.out).toContain(`${rules}: out of date`);
    sb.run('windsurf');
    expect(sb.run('windsurf', { check: true })).toBe(0);
  });

  it('--remove deletes the file, and is a no-op that exits 0 when it is absent', () => {
    sb.run('windsurf');

    expect(sb.run('windsurf', { remove: true })).toBe(0);
    expect(existsSync(rules)).toBe(false);
    sb.out.length = 0;
    expect(sb.run('windsurf', { remove: true })).toBe(0);
    expect(sb.out).toContain(`${rules}: not installed`);
  });

  it('--remove deletes the file from the other location too', () => {
    const devin = join(sb.root, '.devin', 'rules', 'mast.md');
    put(devin, 'x\n');

    sb.run('windsurf', { remove: true });

    expect(existsSync(devin)).toBe(false);
  });

  it('--dry-run writes nothing', () => {
    expect(sb.run('windsurf', { dryRun: true })).toBe(0);

    expect(existsSync(rules)).toBe(false);
    expect(sb.out).toContain(`${rules}: installed (dry run, nothing written)`);
  });
});

describe('mast setup zed', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = sandbox();
  });

  it('writes nothing and exits 1 when no rules file exists, saying to create .rules', () => {
    expect(sb.run('zed')).toBe(1);

    expect(sb.out[0]).toMatch(/no hook system.*only static instructions/);
    expect(readdirSync(sb.root)).toEqual([]);
    expect(sb.err.join('\n')).toMatch(/create .*\.rules.* and run/i);
  });

  it('splices the marked block into the first existing candidate, keeping its text', () => {
    put(join(sb.root, 'AGENTS.md'), 'Mine.\n');
    put(join(sb.root, 'CLAUDE.md'), 'Other.\n');

    expect(sb.run('zed')).toBe(0);

    const agents = sb.read(join(sb.root, 'AGENTS.md'));
    expect(agents.startsWith('Mine.\n\n' + BEGIN_MARKER)).toBe(true);
    expect(sb.read(join(sb.root, 'CLAUDE.md'))).toBe('Other.\n');
    expect(sb.out).toContain(`${join(sb.root, 'AGENTS.md')}: installed`);
  });

  it('prefers .rules over AGENTS.md', () => {
    put(join(sb.root, '.rules'), 'R\n');
    put(join(sb.root, 'AGENTS.md'), 'A\n');

    sb.run('zed');

    expect(sb.read(join(sb.root, 'AGENTS.md'))).toBe('A\n');
    expect(sb.read(join(sb.root, '.rules'))).toContain(BEGIN_MARKER);
  });

  it('refuses --global with exit 1', () => {
    put(join(sb.root, '.rules'), 'R\n');

    expect(sb.run('zed', { global: true })).toBe(1);

    expect(sb.read(join(sb.root, '.rules'))).toBe('R\n');
    expect(sb.err.join('\n')).toMatch(/no user-level rules file/);
  });

  it('is a byte-level no-op the second time', () => {
    const file = join(sb.root, '.rules');
    put(file, 'R\n');
    sb.run('zed');
    sb.writes.length = 0;

    expect(sb.run('zed')).toBe(0);

    expect(sb.writes).toEqual([]);
    expect(sb.out).toContain(`${file}: already up to date`);
  });

  it('--check exits 1 with the block absent, 1 when stale, 0 when current', () => {
    const file = join(sb.root, '.rules');
    put(file, 'R\n');
    expect(sb.run('zed', { check: true })).toBe(1);
    sb.run('zed');
    expect(sb.run('zed', { check: true })).toBe(0);
    writeFileSync(file, sb.read(file).replace('Body line.', 'changed'));
    expect(sb.run('zed', { check: true })).toBe(1);
  });

  it('--check exits 1 when there is no rules file at all', () => {
    expect(sb.run('zed', { check: true })).toBe(1);
  });

  it('--remove takes out the block and leaves the file and its other text', () => {
    const file = join(sb.root, '.rules');
    put(file, 'R\n');
    sb.run('zed');

    expect(sb.run('zed', { remove: true })).toBe(0);

    expect(sb.read(file)).toBe('R\n');
    expect(sb.out).toContain(`${file}: removed`);
  });

  it('--remove finds the block in a file that is no longer the first candidate', () => {
    put(join(sb.root, 'AGENTS.md'), 'A\n');
    sb.run('zed');
    put(join(sb.root, '.rules'), 'R\n');

    sb.run('zed', { remove: true });

    expect(sb.read(join(sb.root, 'AGENTS.md'))).toBe('A\n');
  });

  it('--remove with no rules file is a no-op that exits 0', () => {
    expect(sb.run('zed', { remove: true })).toBe(0);
  });

  it('--dry-run writes nothing', () => {
    put(join(sb.root, '.rules'), 'R\n');

    expect(sb.run('zed', { dryRun: true })).toBe(0);

    expect(sb.read(join(sb.root, '.rules'))).toBe('R\n');
    expect(sb.out.join('\n')).toContain('dry run, nothing written');
  });
});

describe('mast setup desktop', () => {
  it.each([{}, { check: true }, { remove: true }, { dryRun: true }])('explains the handshake, writes nothing and exits 0 for %j', (flags) => {
    const sb = sandbox();

    expect(sb.run('desktop', flags)).toBe(0);

    expect(sb.out[0]).toMatch(/no hook system/);
    expect(sb.out.join('\n')).toMatch(/instructions string.*mast serve.*handshake/s);
    expect(sb.writes).toEqual([]);
    expect(readdirSync(sb.root)).toEqual([]);
  });
});
