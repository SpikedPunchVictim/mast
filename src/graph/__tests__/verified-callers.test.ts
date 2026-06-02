import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveConfig } from '../../store/config.js';
import { runIndex } from '../../indexer/index.js';
import { openDatabase, type Db } from '../db.js';
import { querySymbolByName, queryVerifiedCallers } from '../queries.js';

// End-to-end: the real pipeline (Phase 1 parse → symbols → two-pass edges) must
// produce POTENTIAL_CALL edges so `verified_callers` is non-empty. This is the
// regression class for C2: before the resolver was wired in, this set was
// always empty.

const HANDLER_SRC = `export function handleLogin(): void {}\n`;
const ROUTES_SRC = `import { handleLogin } from './handler';
export function registerRoutes(): void {
  handleLogin();
}
`;

describe('verified_callers — end to end', () => {
  let tmpDir: string;
  let db: Db;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-callers-'));
    writeFileSync(join(tmpDir, 'handler.ts'), HANDLER_SRC);
    writeFileSync(join(tmpDir, 'routes.ts'), ROUTES_SRC);
    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
    db = openDatabase(config.resolved_state_dir);
  });

  afterAll(async () => {
    await db.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the importing caller for a cross-file call', async () => {
    const [target] = await querySymbolByName(db, 'handleLogin', 'handler.ts');
    expect(target).toBeDefined();

    const callers = await queryVerifiedCallers(db, target!.id, false);

    expect(callers.length).toBeGreaterThan(0);
    const caller = callers.find((c) => c.caller_symbol === 'registerRoutes');
    expect(caller).toBeDefined();
    expect(caller!.file_path).toBe('routes.ts');
    expect(caller!.resolution).toBe('import');
    expect(caller!.context).toContain('handleLogin()');
  });
});
