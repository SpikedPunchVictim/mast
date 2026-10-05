import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../../store/config.js';
import { resolveHookConfigLight } from '../hook-state-dir.js';

/**
 * The hook cannot import `resolveConfig` (it pulls in zod), so it carries a second
 * resolver for two facts: the state dir and the indexed extensions. This parity test is what keeps the two from drifting.
 */
describe('resolveHookConfigLight agrees with resolveConfig', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    delete process.env['MAST_STATE_DIR'];
  });

  const project = (configJson?: object): string => {
    const d = mkdtempSync(join(tmpdir(), 'mast-sd-'));
    dirs.push(d);
    if (configJson !== undefined) writeFileSync(join(d, 'mast.config.json'), JSON.stringify(configJson));
    return d;
  };

  it.each([
    ['default', undefined, undefined],
    ['env relative', undefined, 'envdir'],
    ['env absolute', undefined, join(tmpdir(), 'abs-mast-state')],
    ['config file relative', { state_dir: 'cfgdir' }, undefined],
    ['config file absolute', { state_dir: join(tmpdir(), 'abs-cfg-state') }, undefined],
    ['config file and env: env wins', { state_dir: 'cfgdir' }, 'envdir'],
    ['config file without state_dir', { rrf_k: 10 }, undefined],
  ])('%s', (_name, configJson, env) => {
    const root = project(configJson);
    if (env !== undefined) process.env['MAST_STATE_DIR'] = env;

    const expected = resolveConfig({ projectRoot: root }).resolved_state_dir;
    const actual = resolveHookConfigLight(root, process.env).stateDir;

    expect(actual).toBe(expected);
  });

  // `stateJson` is the persisted `<state_dir>/config.json` that `mast init --extensions` writes.
  it.each([
    ['defaults', undefined, undefined],
    ['mast.config.json sets them', { file_extensions: ['.ts', '.mjs'] }, undefined],
    ['persisted state config sets them', undefined, { file_extensions: ['.ts', '.mjs', '.cjs'] }],
    ['both: mast.config.json wins', { file_extensions: ['.ts'] }, { file_extensions: ['.mjs'] }],
    ['persisted value of the wrong shape is dropped', undefined, { file_extensions: 'mjs' }],
    ['persisted under a custom state_dir', { state_dir: 'cfgdir' }, { file_extensions: ['.mjs'] }],
  ])('file extensions: %s', (_name, configJson, stateJson) => {
    const root = project(configJson);
    if (stateJson !== undefined) {
      const stateDir = resolveConfig({ projectRoot: root }).resolved_state_dir;
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'config.json'), JSON.stringify(stateJson));
    }

    const expected = resolveConfig({ projectRoot: root }).file_extensions;
    const actual = resolveHookConfigLight(root, process.env).fileExtensions;

    expect(actual).toEqual(expected);
  });
});
