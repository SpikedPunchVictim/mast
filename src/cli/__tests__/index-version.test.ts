// D138, the CLI half: `mast query`, `mast search` and `mast status` on an index
// another schema version built.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStatus, stampAdvice } from '../status.js';
import { runQuery } from '../query.js';
import { resolveConfig, CURRENT_SCHEMA_VERSION } from '../../store/config.js';
import { runIndex } from '../../indexer/index.js';
import { UserError } from '../../user-error.js';

async function indexedProject(): Promise<{ dir: string; stamp: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'mast-cli-version-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export function alpha(): number { return 1; }\n');
  await runIndex(resolveConfig({ projectRoot: dir }), { incremental: false });
  return { dir, stamp: join(dir, '.mast', 'index.json') };
}

function stampAs(stamp: string, version: string): void {
  const built = JSON.parse(readFileSync(stamp, 'utf8')) as Record<string, unknown>;
  writeFileSync(stamp, JSON.stringify({ ...built, schema_version: version }));
}

describe('mast query on an index another schema version built', () => {
  it.each(['1.3.0', '9.9.0'])('stops at a %s index with an error for the user, naming both versions', async (version) => {
    const { dir, stamp } = await indexedProject();
    stampAs(stamp, version);

    const refusal = runQuery('mast_search', '{"query":"alpha"}', { path: dir });

    await expect(refusal).rejects.toBeInstanceOf(UserError);
    await expect(refusal).rejects.toThrow(`schema ${version}`);
    await expect(refusal).rejects.toThrow(`schema ${CURRENT_SCHEMA_VERSION}`);
  });

  // The refusal belongs to the tools that answer from stored rows. Through
  // `mast query`, the tool that reports the version must still report it.
  it('still runs mast_status, which reports both versions', async () => {
    const { dir, stamp } = await indexedProject();
    stampAs(stamp, '1.3.0');

    const text = await runQuery('mast_status', '{}', { path: dir });

    expect(JSON.parse(text)).toMatchObject({ schema_version: CURRENT_SCHEMA_VERSION, index_schema_version: '1.3.0' });
  });

  it('answers after --reindex has rebuilt an older index', async () => {
    const { dir, stamp } = await indexedProject();
    stampAs(stamp, '1.3.0');

    const text = await runQuery('mast_search', '{"query":"alpha"}', { path: dir, reindex: true, warn: () => undefined });

    expect(text).toContain('alpha');
  });
});

describe('mast status on an index another schema version built', () => {
  it('reports the version that built the index beside the binary\'s, and is not fresh', async () => {
    const { dir, stamp } = await indexedProject();
    stampAs(stamp, '1.3.0');

    const status = await buildStatus({ path: dir });

    expect(status).toMatchObject({
      schema_version: CURRENT_SCHEMA_VERSION,
      index_schema_version: '1.3.0',
      index_fresh: false,
      freshness_cause: 'index_version',
    });
  });

  it('reports the same version twice and is fresh when they agree', async () => {
    const { dir } = await indexedProject();

    const status = await buildStatus({ path: dir });

    expect(status).toMatchObject({
      index_schema_version: CURRENT_SCHEMA_VERSION, index_fresh: true, freshness_cause: null,
    });
  });

  // It used to say NOT INITIALISED, nothing has been indexed, over a full database.
  it('says the stamp could not be read, not that nothing was indexed', async () => {
    const { dir, stamp } = await indexedProject();
    writeFileSync(stamp, '');

    const status = await buildStatus({ path: dir });

    expect(status).toMatchObject({
      initialised: true, index_schema_version: null, index_fresh: false, freshness_cause: 'stamp_unreadable',
    });
  });
});

describe('the advice mast status prints under the table', () => {
  it('names both versions and the command for an index of another version', () => {
    const lines = stampAdvice({ freshness_cause: 'index_version', schema_version: '1.4.0', index_schema_version: '1.3.0' });

    expect(lines.join('\n')).toMatch(/schema 1\.3\.0.*schema 1\.4\.0/);
    expect(lines.join('\n')).toContain('`mast index`');
  });

  it('says index.json could not be read', () => {
    const lines = stampAdvice({ freshness_cause: 'stamp_unreadable', schema_version: '1.4.0', index_schema_version: null });

    expect(lines.join('\n')).toContain('index.json could not be read');
  });

  it('is empty for any other cause', () => {
    expect(stampAdvice({ freshness_cause: 'phase1_stale', schema_version: '1.4.0', index_schema_version: '1.4.0' })).toEqual([]);
  });
});
