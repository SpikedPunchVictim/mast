import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../../store/config.js';
import { resolveStateDirLight } from '../hook-state-dir.js';

/**
 * The hook cannot import `resolveConfig` (it pulls in zod), so it carries a second
 * resolver for one fact. This parity test is what keeps the two from drifting.
 */
describe('resolveStateDirLight agrees with resolveConfig', () => {
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
    const actual = resolveStateDirLight(root, process.env);

    expect(actual).toBe(expected);
  });
});
