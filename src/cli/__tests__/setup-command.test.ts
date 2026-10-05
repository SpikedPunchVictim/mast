import { describe, it, expect } from 'vitest';
import { buildHookCommand, isMastCommand, localBinCandidates } from '../setup-command.js';
import type { Harness, HookEvent } from '../hook.js';
import type { InstallKind } from '../upgrade-cmd.js';

const ENTRY = '/opt/mast/dist/cli/index.js';

describe('buildHookCommand', () => {
  it.each<[Harness, HookEvent, InstallKind, 'project' | 'global', string]>([
    ['claude', 'session-start', 'global', 'project', 'mast hook claude session-start'],
    ['cursor', 'search', 'global', 'global', 'mast hook cursor search'],
    ['vscode', 'session-start', 'global', 'project', 'mast hook vscode session-start'],
    ['claude', 'search', 'source', 'project', `node "${ENTRY}" hook claude search`],
    ['cursor', 'session-start', 'source', 'global', `node "${ENTRY}" hook cursor session-start`],
    ['claude', 'session-start', 'local', 'project', '"${CLAUDE_PROJECT_DIR}"/node_modules/.bin/mast hook claude session-start'],
    ['claude', 'search', 'local', 'project', '"${CLAUDE_PROJECT_DIR}"/node_modules/.bin/mast hook claude search'],
    ['cursor', 'search', 'local', 'project', 'node_modules/.bin/mast hook cursor search'],
    ['vscode', 'session-start', 'local', 'project', 'node_modules/.bin/mast hook vscode session-start'],
  ])('%s %s, %s install, %s scope', (harness, event, installKind, scope, expected) => {
    expect(buildHookCommand({ harness, event, installKind, scope, cliEntry: ENTRY })).toEqual({ ok: true, command: expected });
  });

  it('refuses a project-dependency install at user scope, and says what to do', () => {
    const result = buildHookCommand({ harness: 'claude', event: 'search', installKind: 'local', scope: 'global', cliEntry: ENTRY });
    expect(result).toMatchObject({ ok: false, problem: expect.stringContaining('Install mast globally') });
  });
});

describe('buildHookCommand for a project dependency installed below the project root', () => {
  it.each<[Harness, string, string]>([
    ['claude', 'typescript/node_modules/.bin/mast', '"${CLAUDE_PROJECT_DIR}"/typescript/node_modules/.bin/mast hook claude search'],
    ['cursor', 'typescript/node_modules/.bin/mast', 'typescript/node_modules/.bin/mast hook cursor search'],
    ['claude', 'my pkg/node_modules/.bin/mast', '"${CLAUDE_PROJECT_DIR}/my pkg/node_modules/.bin/mast" hook claude search'],
    ['cursor', 'my pkg/node_modules/.bin/mast', '"my pkg/node_modules/.bin/mast" hook cursor search'],
  ])('%s with the binary at %s', (harness, localBin, expected) => {
    const result = buildHookCommand({ harness, event: 'search', installKind: 'local', scope: 'project', cliEntry: ENTRY, localBin });

    expect(result).toEqual({ ok: true, command: expected });
  });
});

describe('localBinCandidates', () => {
  it.each([
    ['npm, installed in a subdirectory',
      '/p/typescript/node_modules/@spikedpunch/mast/dist/cli/index.js',
      ['typescript/node_modules/.bin/mast', 'node_modules/.bin/mast']],
    ['pnpm, installed in a subdirectory (outermost node_modules first)',
      '/p/typescript/node_modules/.pnpm/@spikedpunch+mast@0.4.0/node_modules/@spikedpunch/mast/dist/cli/index.js',
      ['typescript/node_modules/.bin/mast', 'typescript/node_modules/.pnpm/@spikedpunch+mast@0.4.0/node_modules/.bin/mast', 'node_modules/.bin/mast']],
    ['installed at the project root',
      '/p/node_modules/@spikedpunch/mast/dist/cli/index.js',
      ['node_modules/.bin/mast']],
    ['running from outside the project',
      '/opt/mast/dist/cli/index.js',
      ['node_modules/.bin/mast']],
  ])('%s', (_name, cliEntry, expected) => {
    expect(localBinCandidates(cliEntry, '/p')).toEqual(expected);
  });
});

describe('isMastCommand', () => {
  it.each([
    ['mast hook claude search', true],
    ['node "/x/index.js" hook claude search', true],
    ['mast hook cursor search', false],
    ['mast hook claude session-start', false],
    ['./my-hook.sh', false],
    [undefined, false],
  ])('%j -> %s', (command, expected) => {
    expect(isMastCommand(command, 'claude', 'search')).toBe(expected);
  });
});
