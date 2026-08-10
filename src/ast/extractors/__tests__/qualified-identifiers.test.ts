import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { extractFile } from '../../extract.js';

// ---------------------------------------------------------------------------
// F5 — qualified compounds in identifier_fts rows (Stage 3).
//
// `searchIdentifiers` (search/fts.ts) phrase-quotes its query term, and
// identifier_fts' unicode61 tokenizer treats '.' as a separator — so
// "Class.method" only matches a row whose identifiers column has the tokens
// `Class`, `method` at ADJACENT positions. The bare-identifier bag
// (extractIdentifiers, whitespace-joined, deduplicated) essentially never
// produces that adjacency for a method query, silently emptying
// mast_callers' potential set for any method. The fix: the extractor now
// also emits QUALIFIED compound strings ("Class.method") into the identifier
// row, so the literal text sits contiguous in the column and the existing
// phrase query matches it directly (see fts-query.test.ts for the FTS-level
// proof this text actually produces adjacent tokens under unicode61).
// ---------------------------------------------------------------------------

describe('extractFile — qualified identifier compounds (F5)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mast-qualified-ids-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a method chunk's own identifier row contains its qualified 'Class.method' name (declaration self-discoverability)", () => {
    const src = `export class AuthService {
  check(): void {}
}
`;
    writeFileSync(join(dir, 'service.ts'), src);
    const result = extractFile(join(dir, 'service.ts'), dir, 0, 100);

    const methodChunk = result.chunks.find((c) => c.symbol_name === 'AuthService.check');
    expect(methodChunk).toBeDefined();
    const row = result.identifierRows.find((r) => r.chunk_id === methodChunk!.chunk_id);
    expect(row).toBeDefined();
    expect(row!.identifiers.split(' ')).toContain('AuthService.check');
  });

  it("a constructor chunk's own identifier row contains its qualified 'Class.constructor' name", () => {
    const src = `export class AuthService {
  constructor(private readonly repo: UserRepository) {}
}
`;
    writeFileSync(join(dir, 'ctor.ts'), src);
    const result = extractFile(join(dir, 'ctor.ts'), dir, 0, 100);

    const ctorChunk = result.chunks.find((c) => c.symbol_name === 'AuthService.constructor');
    expect(ctorChunk).toBeDefined();
    const row = result.identifierRows.find((r) => r.chunk_id === ctorChunk!.chunk_id);
    expect(row).toBeDefined();
    expect(row!.identifiers.split(' ')).toContain('AuthService.constructor');
  });

  it("a calling chunk's identifier row contains the field_type-resolved 'ReceiverType.method' qualified mention", () => {
    const src = `export class AuthService {
  constructor(private readonly repo: UserRepository) {}
  check(): void { this.repo.findByEmail(); }
}
`;
    writeFileSync(join(dir, 'auth.ts'), src);
    const result = extractFile(join(dir, 'auth.ts'), dir, 0, 100);

    const callerChunk = result.chunks.find((c) => c.symbol_name === 'AuthService.check');
    expect(callerChunk).toBeDefined();
    const row = result.identifierRows.find((r) => r.chunk_id === callerChunk!.chunk_id);
    expect(row).toBeDefined();
    expect(row!.identifiers.split(' ')).toContain('UserRepository.findByEmail');
  });

  it("a genuinely-unresolvable (DI-container-style) receiver contributes NO qualified compound", () => {
    // §10.3.1's documented "does NOT catch" shape: a call chained off another
    // call's return value has no statically-known receiver type, so
    // LocalTypeEnvironment.resolveCall never runs for it — nothing to qualify.
    const src = `export class Bootstrap {
  start(): void { container.resolve('logger').write(); }
}
`;
    writeFileSync(join(dir, 'bootstrap.ts'), src);
    const result = extractFile(join(dir, 'bootstrap.ts'), dir, 0, 100);

    const callerChunk = result.chunks.find((c) => c.symbol_name === 'Bootstrap.start');
    expect(callerChunk).toBeDefined();
    const row = result.identifierRows.find((r) => r.chunk_id === callerChunk!.chunk_id);
    expect(row).toBeDefined();
    // The chunk's OWN qualified name ('Bootstrap.start') is always present
    // (declaration self-discoverability, unconditional for every method
    // chunk) — the assertion here is about the UNRESOLVABLE call site inside
    // it: no "X.write"/"X.resolve" mention compound was added for that.
    const otherQualified = row!.identifiers.split(' ').filter((t) => t.includes('.') && t !== 'Bootstrap.start');
    expect(otherQualified).toEqual([]);
  });
});
