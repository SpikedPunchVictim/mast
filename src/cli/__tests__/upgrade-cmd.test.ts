import { describe, it, expect } from 'vitest';
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
  currentSchema: '1.3.0', indexedSchema: '1.3.0', chunkCount: 152969, ...over,
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
