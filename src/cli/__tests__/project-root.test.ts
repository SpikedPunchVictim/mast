import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerIndexCommand } from '../index-cmd.js';
import { registerInitCommand } from '../init.js';
import { runCli } from '../program.js';

/**
 * A mistyped project path used to be indexed as an empty project: `mast index`
 * and `mast init` printed a zero-file result, exited 0, and created the
 * directory with a state directory inside it (D075).
 */
describe.each([
  ['index', registerIndexCommand],
  ['init', registerInitCommand],
] as const)('mast %s on a path that does not exist', (name, register) => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  async function runOnMissingPath(): Promise<{ missing: string; outcome: Promise<unknown> }> {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-missing-root-'));
    const missing = join(tmpDir, 'no-such-dir');
    const program = new Command().exitOverride();
    register(program);
    return { missing, outcome: program.parseAsync(['node', 'mast', name, missing]) };
  }

  it('refuses the path', async () => {
    const { outcome } = await runOnMissingPath();

    await expect(outcome).rejects.toThrow(/no-such-dir is not a directory/);
  });

  it('does not create the path', async () => {
    const { missing, outcome } = await runOnMissingPath();
    await outcome.catch(() => {});

    expect(existsSync(missing)).toBe(false);
  });
});

/**
 * `runCli` is what `cli/index.ts` runs. A config the user can fix is one line
 * on stderr and exit 1 in every command; an error mast did not anticipate
 * keeps its stack trace, because that is a bug report, not a usage message.
 */
describe('runCli', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it.each(['index', 'init'])(
    'prints one line and returns 1 when mast %s is given a path that does not exist',
    async (command) => {
      tmpDir = mkdtempSync(join(tmpdir(), 'mast-run-cli-'));
      const lines: string[] = [];

      const exitCode = await runCli(['node', 'mast', command, join(tmpDir, 'no-such-dir')], (text) => lines.push(text));

      expect({ exitCode, lines }).toEqual({
        exitCode: 1,
        lines: [expect.stringMatching(/^mast: project root .*no-such-dir is not a directory\n$/)],
      });
    },
  );

  it.each(['status', 'index', 'init', 'prime', 'metrics'])(
    'prints one line and returns 1 when mast %s meets a config it rejects',
    async (command) => {
      tmpDir = mkdtempSync(join(tmpdir(), 'mast-run-cli-'));
      writeFileSync(join(tmpDir, 'mast.config.json'), JSON.stringify({ include_dot_dirs: ['.agents/*'] }));
      const lines: string[] = [];

      const exitCode = await runCli(['node', 'mast', command, tmpDir], (text) => lines.push(text));

      expect({ exitCode, lines }).toEqual({
        exitCode: 1,
        lines: [expect.stringMatching(/^mast: .*mast\.config\.json: include_dot_dirs: "\.agents\/\*" .*\n$/)],
      });
    },
  );

  /**
   * `mast serve` takes no path: it serves the working directory. A rejected
   * entry has to stop it with a message an MCP client's log can show.
   */
  it('prints one line and returns 1 when mast serve starts in a project whose config it rejects', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-run-cli-'));
    writeFileSync(join(tmpDir, 'mast.config.json'), JSON.stringify({ include_dot_dirs: ['.agents/*'] }));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    const lines: string[] = [];

    try {
      const exitCode = await runCli(['node', 'mast', 'serve'], (text) => lines.push(text));

      expect({ exitCode, lines }).toEqual({
        exitCode: 1,
        lines: [expect.stringMatching(/^mast: .*include_dot_dirs: "\.agents\/\*" .*\n$/)],
      });
    } finally {
      cwd.mockRestore();
    }
  });

  it('prints one line and returns 1 when mast metrics is run where there is no index', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-run-cli-'));
    const lines: string[] = [];

    const exitCode = await runCli(['node', 'mast', 'metrics', tmpDir], (text) => lines.push(text));

    expect({ exitCode, lines }).toEqual({
      exitCode: 1,
      lines: [expect.stringMatching(/^mast: no index found at .*\.mast; run `mast init` first\n$/)],
    });
  });

  // Opening the database creates it, so an empty one would answer "no metrics"
  // for a project that was never indexed and leave a graph.db behind.
  it('does not create a database when mast metrics finds a state directory with none', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-run-cli-'));
    mkdirSync(join(tmpDir, '.mast'));

    await runCli(['node', 'mast', 'metrics', tmpDir], () => {});

    expect(existsSync(join(tmpDir, '.mast', 'graph.db'))).toBe(false);
  });

  it('returns no exit code when the command succeeds, leaving the command\'s own in place', async () => {
    const program = new Command().exitOverride();
    program.command('fine').action(() => {});

    expect(await runCli(['node', 'mast', 'fine'], () => {}, program)).toBeUndefined();
  });

  it('lets an error that is not a UserError through', async () => {
    const program = new Command().exitOverride();
    program.command('boom').action(() => {
      throw new TypeError('a bug');
    });

    await expect(runCli(['node', 'mast', 'boom'], () => {}, program)).rejects.toThrow(TypeError);
  });
});
