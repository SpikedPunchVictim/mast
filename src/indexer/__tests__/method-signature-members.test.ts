import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { expectEdges, makeProject, writeFiles } from './graph-fixture.js';

// ---------------------------------------------------------------------------
// D107 — a method of a class written with no body. An abstract one always had
// a symbol; an optional one (`m?(): T;`) did not. An overload is not a member of its own: the implementation is.
// ---------------------------------------------------------------------------

describe('methods of a class that have no body', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeProject('method-signature-members');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('are members, abstract or optional', async () => {
    writeFiles(dir, {
      'src/a.ts': `export abstract class A {
  before(): number { return 1; }
  abstract shape(x: number): void;
  maybe?(body: unknown): string | undefined;
  after(): number { return 2; }
}
`,
    });

    await expectEdges(
      dir,
      [
        'PARENT_OF src/a.ts:A -> src/a.ts:A.after',
        'PARENT_OF src/a.ts:A -> src/a.ts:A.before',
        'PARENT_OF src/a.ts:A -> src/a.ts:A.maybe',
        'PARENT_OF src/a.ts:A -> src/a.ts:A.shape',
      ],
      ['PARENT_OF'],
    );
  });

  it('are one member with the implementation when they are its overloads', async () => {
    writeFiles(dir, {
      'src/a.ts': `export class A {
  over(a: string): void;
  over(a: number): void;
  over(a: unknown): void {}
}
export function use(a: A): void { a.over(1); }
`,
    });

    await expectEdges(
      dir,
      ['PARENT_OF src/a.ts:A -> src/a.ts:A.over', 'POTENTIAL_CALL src/a.ts:use -> src/a.ts:A.over'],
      ['PARENT_OF', 'POTENTIAL_CALL'],
    );
  });

  it('link a call to an optional method', async () => {
    writeFiles(dir, {
      'src/a.ts': `export abstract class A {\n  maybe?(body: unknown): string | undefined;\n}\n`,
      'src/b.ts': `import { A } from './a.js';\nexport function use(a: A): unknown { return a.maybe(1); }\n`,
    });

    await expectEdges(dir, ['POTENTIAL_CALL src/b.ts:use -> src/a.ts:A.maybe'], ['POTENTIAL_CALL']);
  });
});
