import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { buildWalkReport, formatWalkReport, registerWalkCommand } from '../walk-cmd.js';
import { resolveConfig, writeStateConfig } from '../../store/config.js';

function project(files: readonly string[], config?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mast-walk-'));
  for (const rel of files) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), '# heading\n');
  }
  if (config !== undefined) writeFileSync(join(dir, 'mast.config.json'), JSON.stringify(config));
  return dir;
}

const FILES = [
  'README.md',
  'src/a.ts',
  'src/cli/b.ts',
  'src/cli/c.ts',
  'src/cli/c.test.ts',
  '.agents/notes/plan.md',
  '.history/src/a.ts',
  'image.png',
] as const;

/**
 * `mast walk` exists so a config change can be checked before an index is built
 * from it. It reports through `walkProject`, the function `mast index` and
 * `mast status` walk with, so what it prints is what would be indexed.
 */
describe('buildWalkReport', () => {
  it('lists each directory that holds a walked file, with its file count', async () => {
    const report = await buildWalkReport({ path: project(FILES) });

    expect(report.directories).toEqual([
      { directory: '.', files: 1 },
      { directory: 'src', files: 1 },
      { directory: 'src/cli', files: 2 },
    ]);
  });

  it('counts the files it walked', async () => {
    const report = await buildWalkReport({ path: project(FILES) });

    expect(report.total_files).toBe(4);
  });

  it('lists a dot directory once include_dot_dirs names it', async () => {
    const report = await buildWalkReport({ path: project(FILES, { include_dot_dirs: ['.agents'] }) });

    expect(report.directories.map((d) => d.directory)).toContain('.agents/notes');
    expect(report.directories.map((d) => d.directory)).not.toContain('.history/src');
  });

  it('reports how many files each include_dot_dirs entry contributed', async () => {
    const report = await buildWalkReport({ path: project(FILES, { include_dot_dirs: ['.agents'] }) });

    expect(report.include_dot_dirs).toEqual([{ directory: '.agents', status: 'walked', files: 1 }]);
  });

  it('does not count a sibling directory that shares the entry\'s prefix', async () => {
    const dir = project([...FILES, '.agents-old/stale.md'], { include_dot_dirs: ['.agents', '.agents-old'] });

    const report = await buildWalkReport({ path: dir });

    expect(report.include_dot_dirs[0]).toEqual({ directory: '.agents', status: 'walked', files: 1 });
  });

  /**
   * Two entries can sit above the same file. Only the one that makes the walk
   * reach it is `walked`; the outer one would otherwise look like it works, and
   * turn `empty` the day the inner entry is removed.
   */
  it('does not credit an entry with files only a deeper entry brings in', async () => {
    const dir = project(['.a/mid/.deep/n.md'], { include_dot_dirs: ['.a/mid/.deep', '.a/mid'] });

    const report = await buildWalkReport({ path: dir });

    expect(report.include_dot_dirs).toEqual([
      { directory: '.a/mid/.deep', status: 'walked', files: 1 },
      { directory: '.a/mid', status: 'empty', files: 0 },
    ]);
  });

  it('says when an include_dot_dirs entry is not a directory on disk', async () => {
    const report = await buildWalkReport({ path: project(FILES, { include_dot_dirs: ['.agnets'] }) });

    expect(report.include_dot_dirs).toEqual([{ directory: '.agnets', status: 'missing', files: 0 }]);
  });

  it('tells an existing dot directory with nothing walkable apart from a missing one', async () => {
    const dir = project([...FILES, '.assets/logo.png'], { include_dot_dirs: ['.assets'] });

    const report = await buildWalkReport({ path: dir });

    expect(report.include_dot_dirs).toEqual([{ directory: '.assets', status: 'empty', files: 0 }]);
  });

  /**
   * Zero files has more causes than "nothing matches", and each wants a different
   * fix. On a case-insensitive filesystem `.Agents` stats as existing while the
   * walk, which matches names exactly, finds nothing under it.
   */
  it('reports an entry whose case differs from the directory on disk as missing', async () => {
    const report = await buildWalkReport({ path: project(FILES, { include_dot_dirs: ['.Agents'] }) });

    expect(report.include_dot_dirs).toEqual([{ directory: '.Agents', status: 'missing', files: 0 }]);
  });

  it('says when an entry is a symbolic link, which the walk does not follow', async () => {
    const dir = project(FILES, { include_dot_dirs: ['.linked'] });
    symlinkSync(join(dir, '.agents'), join(dir, '.linked'));

    const report = await buildWalkReport({ path: dir });

    expect(report.include_dot_dirs).toEqual([{ directory: '.linked', status: 'symlink', files: 0 }]);
  });

  it('says when an entry names a file', async () => {
    const report = await buildWalkReport({ path: project(FILES, { include_dot_dirs: ['.agents/notes/plan.md'] }) });

    expect(report.include_dot_dirs[0]?.status).toBe('not_a_directory');
  });

  it('refuses a project root that is not a directory, so a mistyped path is not a clean zero', async () => {
    await expect(buildWalkReport({ path: join(project(FILES), 'no-such-dir') })).rejects.toThrow(/is not a directory/);
  });

  it('rolls directories up to --depth, keeping every file in the count', async () => {
    const report = await buildWalkReport({ path: project(FILES), depth: 1 });

    expect(report.directories).toEqual([
      { directory: '.', files: 1 },
      { directory: 'src', files: 3 },
    ]);
  });

  it('names the config file it read, and null when there is none', async () => {
    const withConfig = project(FILES, {});
    const without = project(FILES);

    expect((await buildWalkReport({ path: withConfig })).config_file).toBe(join(withConfig, 'mast.config.json'));
    expect((await buildWalkReport({ path: without })).config_file).toBeNull();
  });

  /**
   * A key deleted from `mast.config.json` keeps applying from the config a
   * previous `mast init` saved. The report has to name that file, or a dot
   * directory that is still walked has no visible cause.
   */
  it('names the saved state config when one supplies a setting', async () => {
    const dir = project(FILES);
    const saved = resolveConfig({ projectRoot: dir });
    writeStateConfig(saved.resolved_state_dir, { ...saved, include_dot_dirs: ['.agents'] });

    const report = await buildWalkReport({ path: dir });

    expect(report.config_file).toBeNull();
    expect(report.saved_config_file).toBe(join(saved.resolved_state_dir, 'config.json'));
    expect(report.include_dot_dirs.map((d) => d.directory)).toEqual(['.agents']);
  });

  it('reports no saved state config when there is none', async () => {
    expect((await buildWalkReport({ path: project(FILES) })).saved_config_file).toBeNull();
  });

  it('lists the walked files', async () => {
    const report = await buildWalkReport({ path: project(FILES) });

    expect(report.files).toEqual(['README.md', 'src/a.ts', 'src/cli/b.ts', 'src/cli/c.ts']);
  });
});

describe('formatWalkReport', () => {
  it('prints one line per directory', async () => {
    const report = await buildWalkReport({ path: project(FILES, { include_dot_dirs: ['.agents'] }) });

    const text = formatWalkReport(report, { files: false });

    expect(text).toMatch(/^\s+1 {2}\.agents\/notes$/m);
    expect(text).toMatch(/^\s+2 {2}src\/cli$/m);
  });

  it('flags an include_dot_dirs entry that matched nothing because it does not exist', async () => {
    const report = await buildWalkReport({ path: project(FILES, { include_dot_dirs: ['.agnets'] }) });

    expect(formatWalkReport(report, { files: false })).toContain('! .agnets: no directory of exactly this name');
  });

  it.each([
    ['.assets', 'a directory, but nothing in it was walked'],
    ['.linked', 'reached through a symbolic link'],
    ['.agents/notes/plan.md', 'a file, not a directory'],
  ])('explains why %s contributed nothing', async (entry, explanation) => {
    const dir = project([...FILES, '.assets/logo.png'], { include_dot_dirs: [entry] });
    symlinkSync(join(dir, '.agents'), join(dir, '.linked'));

    const text = formatWalkReport(await buildWalkReport({ path: dir }), { files: false });

    expect(text).toContain(`! ${entry}: ${explanation}`);
  });

  it('prints files instead of directories when asked', async () => {
    const report = await buildWalkReport({ path: project(FILES) });

    const text = formatWalkReport(report, { files: true });

    expect(text).toMatch(/^src\/cli\/b\.ts$/m);
  });
});

/**
 * The documented exit codes, driven through the registered command: 2 for a
 * usage error, 1 for a config or path the walk cannot use.
 */
describe('mast walk exit codes', () => {
  async function run(args: readonly string[]): Promise<{ exitCode: typeof process.exitCode; stderr: string }> {
    const stderrWrite = process.stderr.write.bind(process.stderr);
    const previous = process.exitCode;
    let stderr = '';
    process.exitCode = undefined;
    process.stderr.write = (chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    };
    try {
      const program = new Command().exitOverride();
      registerWalkCommand(program);
      await program.parseAsync(['node', 'mast', 'walk', ...args]);
      return { exitCode: process.exitCode, stderr };
    } finally {
      process.stderr.write = stderrWrite;
      process.exitCode = previous;
    }
  }

  it('exits 2 for a --depth that is not a whole number of 1 or more', async () => {
    expect((await run([project(FILES), '--depth', '0'])).exitCode).toBe(2);
  });

  it('exits 1 for a config it rejects', async () => {
    expect((await run([project(FILES, { include_dot_dirs: ['.agents/*'] })])).exitCode).toBe(1);
  });

  it('says on stderr, in one line, why it rejected the config', async () => {
    const { stderr } = await run([project(FILES, { include_dot_dirs: ['.agents/*'] })]);

    expect(stderr).toMatch(/^mast walk: .*include_dot_dirs: "\.agents\/\*" contains a glob character.*\n$/);
  });

  it('exits 1 for a project path that does not exist', async () => {
    expect((await run([join(project(FILES), 'no-such-dir')])).exitCode).toBe(1);
  });
});
