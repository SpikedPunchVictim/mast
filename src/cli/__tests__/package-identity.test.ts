import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { CLI_VERSION, PACKAGE_NAME } from '../version.js';
import { DOC_TOPICS } from '../docs-cmd.js';

const require = createRequire(import.meta.url);
const pkg = require('../../../package.json') as {
  name: string;
  version: string;
  private?: boolean;
  bin?: Record<string, string>;
  files?: readonly string[];
  scripts?: Record<string, string>;
  publishConfig?: { access?: string };
};

/**
 * The CLI used to carry its own literal `.version('0.1.0')` beside package.json's
 * `"version"`. That is S-05 — two producers of one value — and the failure mode is
 * silent: `mast --version` reports a release the binary is not. These tests make
 * package.json the single producer.
 */
describe('package identity', () => {
  it('reports the same version the manifest declares', () => {
    expect(CLI_VERSION).toBe(pkg.version);
  });

  it('reports the same name the manifest declares', () => {
    expect(PACKAGE_NAME).toBe(pkg.name);
  });
});

/**
 * D8 was the installed binary drifting three days behind `src/`. The publish path
 * has the same shape one layer out: `dist/` is gitignored, so a publish from a
 * clean checkout ships whatever `dist/` happens to contain — which is nothing.
 * These assert the manifest cannot be published in a state that reproduces it.
 */
describe('publishability', () => {
  it('is not marked private', () => {
    expect(pkg.private ?? false).toBe(false);
  });

  it('publishes the scope publicly', () => {
    expect(pkg.publishConfig?.access).toBe('public');
  });

  it('builds dist before publishing, so a clean checkout cannot ship a stale one', () => {
    expect(pkg.scripts?.prepublishOnly).toMatch(/\bbuild\b/);
  });

  /**
   * `mast docs` reads files out of the installed package. A topic whose file is not
   * in `files` resolves fine from the repo and 404s for every consumer — the failure
   * only appears after publishing, which is the worst place to find it.
   */
  it('ships the file behind every docs topic', () => {
    const shipped = pkg.files ?? [];
    for (const topic of DOC_TOPICS) {
      const top = topic.file.split('/')[0];
      // npm always includes README.md regardless of `files`.
      if (top === 'README.md') continue;
      expect(shipped, `${topic.name} -> ${topic.file}`).toContain(top);
    }
  });

  it('ships every path the bin entries point into', () => {
    const shipped = pkg.files ?? [];
    for (const target of Object.values(pkg.bin ?? {})) {
      const top = target.replace(/^\.\//, '').split('/')[0];
      expect(shipped).toContain(top);
    }
  });
});
