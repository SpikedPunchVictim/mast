import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveConfig } from '../../store/config.js';
import { runIndex } from '../../indexer/index.js';
import { openDatabase, type Db } from '../db.js';
import { querySymbolByName, queryVerifiedCallers } from '../queries.js';

// ---------------------------------------------------------------------------
// A mis-cased import must still produce its edge.
//
// The unit-level guard lives in indexer/__tests__/import-resolver.test.ts,
// which pins that the resolver returns the ON-DISK casing. This file pins the
// consequence that actually matters to a caller, and that no unit test reaches:
// the POTENTIAL_CALL edge survives the whole pipeline.
//
// Without canonicalisation the resolver echoes the specifier's casing, so
// `imports.resolved_path` reads `handler.ts` while the walker recorded
// `Handler.ts`. Every path-range join against `files.path`
// (resolveInFileOrReExportChain, insertReExportFiles, resolveTypeContext) then
// matches nothing, `verified_callers` comes back EMPTY, and a caller concludes
// the function has no callers — MAST's severity zero, reached with no error
// anywhere in the run.
// ---------------------------------------------------------------------------

const HANDLER_SRC = `export function handleLogin(): void {}\n`;
// './handler' — the file on disk is 'Handler.ts'.
const ROUTES_SRC = `import { handleLogin } from './handler';
export function registerRoutes(): void {
  handleLogin();
}
`;

/**
 * Whether `dir` is on a case-insensitive filesystem. Duplicated from
 * indexer/__tests__/import-resolver.test.ts rather than shared: an eight-line
 * probe is cheaper to read twice than a test-utility module is to introduce.
 */
function isCaseInsensitiveFs(dir: string): boolean {
  const probe = join(dir, 'CaseProbe.tmp');
  writeFileSync(probe, '');
  try {
    return statSync(join(dir, 'caseprobe.tmp')).isFile();
  } catch {
    return false;
  } finally {
    rmSync(probe, { force: true });
  }
}

describe('mis-cased import — end to end', () => {
  let tmpDir: string;
  let db: Db;
  let caseInsensitive: boolean;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-miscased-e2e-'));
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(join(tmpDir, 'src', 'Handler.ts'), HANDLER_SRC);
    writeFileSync(join(tmpDir, 'src', 'routes.ts'), ROUTES_SRC);
    caseInsensitive = isCaseInsensitiveFs(tmpDir);
    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
    db = openDatabase(config.resolved_state_dir);
  });

  afterAll(async () => {
    await db.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records the caller despite the specifier disagreeing with the on-disk casing', async () => {
    const [target] = await querySymbolByName(db, 'handleLogin', 'src/Handler.ts');
    expect(target).toBeDefined();

    const callers = await queryVerifiedCallers(db, target!.id, false);

    if (caseInsensitive) {
      const caller = callers.find((c) => c.caller_symbol === 'registerRoutes');
      expect(caller).toBeDefined();
      expect(caller!.file_path).toBe('src/routes.ts');
    } else {
      // On a case-sensitive filesystem './handler' names no file at all — tsc
      // rejects the import too — so no edge is the correct answer.
      expect(callers).toHaveLength(0);
    }
  });
});
