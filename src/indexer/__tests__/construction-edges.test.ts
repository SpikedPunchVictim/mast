import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { expectEdges, makeProject, writeFiles } from './graph-fixture.js';

// ---------------------------------------------------------------------------
// `new X()` is a call of X's constructor.
//
// The edge goes to the class's `constructor` symbol when the class declares
// one, and to the class otherwise (decided by the user, 2026-10-07,
// adr/proposals/graph-reference). Which of the two exists is only known once
// the class's file has been indexed, so the choice is made when the edge is
// stored, and this test reads the stored graph.
// ---------------------------------------------------------------------------

describe('construction edges', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeProject('construction');
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('points `new X()` at the constructor when the class declares one, in another file or the same', async () => {
    writeFiles(projectDir, {
      'src/a.ts': `export class WithCtor { constructor(readonly n: number) {} }\n`,
      'src/z.ts': `import { WithCtor } from './a.js';
class Local { constructor(readonly n: number) {} }
export function build(): unknown { return [new WithCtor(1), new Local(2)]; }
`,
    });

    await expectEdges(projectDir, [
      'POTENTIAL_CALL src/z.ts:build -> src/a.ts:WithCtor.constructor',
      'POTENTIAL_CALL src/z.ts:build -> src/z.ts:Local.constructor',
    ]);
  });

  // The fallback to the class must mean "the class has no constructor", not
  // "the constructor could not be found from here". On n8n core 122 edges
  // took the class of an import that came through an index file.
  it('points `new X()` at the constructor of a class imported through a re-exporting index', async () => {
    writeFiles(projectDir, {
      'src/errors/a.ts': `export class WithCtor { constructor(readonly n: number) {} }\n`,
      'src/errors/index.ts': `export { WithCtor } from './a.js';\nexport * from './b.js';\n`,
      'src/errors/b.ts': `export class Starred { constructor(readonly n: number) {} }\n`,
      'src/z.ts': `import { WithCtor, Starred } from './errors/index.js';
export function build(): unknown { return [new WithCtor(1), new Starred(2)]; }
`,
    });

    await expectEdges(projectDir, [
      'POTENTIAL_CALL src/z.ts:build -> src/errors/a.ts:WithCtor.constructor',
      'POTENTIAL_CALL src/z.ts:build -> src/errors/b.ts:Starred.constructor',
    ]);
  });

  it('points `new X()` at the class when it declares no constructor', async () => {
    writeFiles(projectDir, {
      'src/a.ts': `export class Plain { n = 1; }\n`,
      'src/z.ts': `import { Plain } from './a.js';
export function build(): Plain { return new Plain(); }
`,
    });

    await expectEdges(projectDir, ['POTENTIAL_CALL src/z.ts:build -> src/a.ts:Plain']);
  });

  it('stores no edge for a class with no import or declaration to place it by', async () => {
    writeFiles(projectDir, {
      'src/a.ts': `export class Elsewhere { constructor() {} }\n`,
      'src/z.ts': `export function build(): unknown { return new Map<string, Elsewhere>(); }\n`,
    });

    await expectEdges(projectDir, []);
  });
});
