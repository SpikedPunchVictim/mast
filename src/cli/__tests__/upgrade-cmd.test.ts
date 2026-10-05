import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findInstalledArtifacts, NO_INSTALLED_ARTIFACTS, type InstalledArtifacts } from '../installed-artifacts.js';
import { BEGIN_MARKER } from '../skill-install.js';
import { readFileOrNull } from '../installed-artifacts.js';
import {
  detectInstallKind, upgradeCommandFor, compareVersions, buildUpgradeReport,
  type InstallKind, type UpgradeFacts,
} from '../upgrade-cmd.js';

describe('compareVersions', () => {
  it.each([
    ['0.1.0', '0.2.0', -1], ['0.2.0', '0.1.0', 1], ['0.1.0', '0.1.0', 0],
    ['0.9.0', '0.10.0', -1],   // string compare would get this backwards
    ['1.0.0', '1.0.0-rc.1', 1], // a prerelease is older than its release
  ])('%s vs %s', (a, b, expected) => {
    expect(Math.sign(compareVersions(a, b))).toBe(expected);
  });
});

describe('detectInstallKind', () => {
  it('recognises a dependency of the project being indexed', () => {
    expect(detectInstallKind('/proj/node_modules/@spikedpunch/mast/dist/cli', '/proj')).toBe('local');
  });

  it('recognises a global install', () => {
    expect(detectInstallKind('/usr/local/lib/node_modules/@spikedpunch/mast/dist/cli', '/proj')).toBe('global');
  });

  /**
   * Running from a clone is how every contributor runs it, and telling them to
   * `pnpm add` their own checkout would be actively wrong.
   */
  it('recognises a source checkout', () => {
    expect(detectInstallKind('/home/me/projects/mast/dist/cli', '/proj')).toBe('source');
  });
});

describe('upgradeCommandFor', () => {
  it.each<[InstallKind, RegExp]>([
    ['local', /add|up/], ['global', /-g|--global/], ['source', /git pull/],
  ])('gives %s an executable instruction', (kind, shape) => {
    expect(upgradeCommandFor(kind, 'pnpm')).toMatch(shape);
  });

  it('uses the package manager it was told about', () => {
    expect(upgradeCommandFor('local', 'npm')).toContain('npm');
    expect(upgradeCommandFor('local', 'pnpm')).toContain('pnpm');
  });
});

const FACTS = (over: Partial<UpgradeFacts> = {}): UpgradeFacts => ({
  current: '0.1.0', latest: '0.2.0', installKind: 'local', packageManager: 'pnpm',
  currentSchema: '1.3.0', indexedSchema: '1.3.0', chunkCount: 152969, installed: NO_INSTALLED_ARTIFACTS, ...over,
});

describe('buildUpgradeReport', () => {
  it('says so plainly when already current', () => {
    expect(buildUpgradeReport(FACTS({ latest: '0.1.0' }))).toMatch(/up to date|current/i);
  });

  it('shows both versions and the command when behind', () => {
    const out = buildUpgradeReport(FACTS());
    expect(out).toContain('0.1.0');
    expect(out).toContain('0.2.0');
    expect(out).toMatch(/pnpm/);
  });

  /**
   * The whole reason this command exists rather than deferring to the package
   * manager: npm cannot tell you that upgrading discards your index. A user with
   * 152,969 chunks must learn that BEFORE upgrading, not from a silent two-minute
   * stall on their next `serve`.
   */
  it('warns that a schema change forces a full reindex, with the corpus size', () => {
    const out = buildUpgradeReport(FACTS({ indexedSchema: '1.2.0' }));
    expect(out).toMatch(/reindex/i);
    expect(out).toContain('152,969');
  });

  it('does not threaten a reindex when the schema is unchanged', () => {
    expect(buildUpgradeReport(FACTS())).not.toMatch(/reindex/i);
  });

  /**
   * Offline, or behind a proxy, the command must still be useful — it still knows
   * the install kind and the schema state. Reporting "you are up to date" when the
   * check failed would be a lie in the dangerous direction.
   */
  it('reports an unknown latest version as unknown, never as up to date', () => {
    const out = buildUpgradeReport(FACTS({ latest: null }));
    expect(out).toMatch(/could not|unknown|unavailable/i);
    expect(out).not.toMatch(/up to date/i);
  });
});

const FOUND = (over: Partial<InstalledArtifacts> = {}): InstalledArtifacts => ({ ...NO_INSTALLED_ARTIFACTS, ...over });

describe('buildUpgradeReport: the After upgrading block', () => {
  it('prints nothing about re-checking when nothing of mast\'s is installed', () => {
    expect(buildUpgradeReport(FACTS())).not.toMatch(/after upgrading/i);
  });

  it('lists a --check command for each harness with project hooks, and the skill command for a skill block', () => {
    const out = buildUpgradeReport(FACTS({
      installed: FOUND({ projectHooks: ['claude', 'cursor'], skillBlockFiles: ['CLAUDE.md', 'AGENTS.md'] }),
    }));

    expect(out).toMatch(/after upgrading/i);
    expect(out).toContain('mast setup claude --check');
    expect(out).toContain('mast setup cursor --check');
    expect(out).toContain('mast skill --install');
    expect(out).toContain('CLAUDE.md, AGENTS.md');
    expect(out).not.toContain('mast setup vscode');
  });

  it('adds a --global command for user-level hook files', () => {
    const out = buildUpgradeReport(FACTS({ installed: FOUND({ globalHooks: ['claude'] }) }));

    expect(out).toContain('mast setup claude --global --check');
    expect(out).not.toContain('mast skill --install');
  });

  it('names a harness once when it has both hooks and a rules file', () => {
    const out = buildUpgradeReport(FACTS({ installed: FOUND({ projectHooks: ['cursor'], rulesHarnesses: ['cursor'] }) }));

    expect(out.split('mast setup cursor --check').length - 1).toBe(1);
  });

  it('lists windsurf for a rules file, and zed for a block in a file the skill command does not reach', () => {
    const out = buildUpgradeReport(FACTS({ installed: FOUND({ rulesHarnesses: ['windsurf'], zedOnlyBlockFiles: ['.rules'] }) }));

    expect(out).toContain('mast setup windsurf --check');
    expect(out).toContain('mast setup zed --check');
  });
});

describe('findInstalledArtifacts', () => {
  const sandbox = (): { root: string; home: string; put(path: string, text: string): void } => {
    const base = mkdtempSync(join(tmpdir(), 'mast-upgrade-'));
    const root = join(base, 'project');
    const home = join(base, 'home');
    mkdirSync(root);
    mkdirSync(home);
    return { root, home, put: (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); } };
  };
  const hookJson = (harness: string): string => JSON.stringify({ hooks: { x: [{ command: `mast hook ${harness} search` }] } });

  it('finds nothing in an empty project and an empty home', () => {
    const sb = sandbox();

    expect(findInstalledArtifacts(sb.root, sb.home, readFileOrNull)).toEqual(NO_INSTALLED_ARTIFACTS);
  });

  it('finds project hooks, user-level hooks, rules files and skill blocks, each under its own key', () => {
    const sb = sandbox();
    sb.put(join(sb.root, '.claude', 'settings.json'), hookJson('claude'));
    sb.put(join(sb.home, '.cursor', 'hooks.json'), hookJson('cursor'));
    sb.put(join(sb.root, '.cursor', 'rules', 'mast.mdc'), 'x');
    sb.put(join(sb.root, '.devin', 'rules', 'mast.md'), 'x');
    sb.put(join(sb.root, 'CLAUDE.md'), `${BEGIN_MARKER}\nx\n`);
    sb.put(join(sb.root, '.rules'), `${BEGIN_MARKER}\nx\n`);

    expect(findInstalledArtifacts(sb.root, sb.home, readFileOrNull)).toEqual({
      projectHooks: ['claude'],
      globalHooks: ['cursor'],
      rulesHarnesses: ['cursor', 'windsurf'],
      zedOnlyBlockFiles: ['.rules'],
      skillBlockFiles: ['CLAUDE.md'],
    });
  });

  it('does not count a settings file that holds no mast hook', () => {
    const sb = sandbox();
    sb.put(join(sb.root, '.claude', 'settings.json'), '{"permissions":{}}');

    expect(findInstalledArtifacts(sb.root, sb.home, readFileOrNull).projectHooks).toEqual([]);
  });
});
