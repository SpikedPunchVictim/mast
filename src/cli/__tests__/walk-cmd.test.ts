import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildWalkReport, formatWalkReport } from '../walk-cmd.js';
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

    expect(report.include_dot_dirs).toEqual([{ directory: '.agents', exists: true, files: 1 }]);
  });

  it('says when an include_dot_dirs entry is not a directory on disk', async () => {
    const report = await buildWalkReport({ path: project(FILES, { include_dot_dirs: ['.agnets'] }) });

    expect(report.include_dot_dirs).toEqual([{ directory: '.agnets', exists: false, files: 0 }]);
  });

  it('tells an existing dot directory with nothing walkable apart from a missing one', async () => {
    const dir = project([...FILES, '.assets/logo.png'], { include_dot_dirs: ['.assets'] });

    const report = await buildWalkReport({ path: dir });

    expect(report.include_dot_dirs).toEqual([{ directory: '.assets', exists: true, files: 0 }]);
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

    expect(formatWalkReport(report, { files: false })).toContain('! .agnets: no such directory');
  });

  it('prints files instead of directories when asked', async () => {
    const report = await buildWalkReport({ path: project(FILES) });

    const text = formatWalkReport(report, { files: true });

    expect(text).toMatch(/^src\/cli\/b\.ts$/m);
  });
});
