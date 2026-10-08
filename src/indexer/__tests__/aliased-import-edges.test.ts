import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { expectEdges, makeProject, writeFiles } from './graph-fixture.js';

// ---------------------------------------------------------------------------
// D106 — `import { X as Y }`. The file binds `Y`, not `X`: a call of `Y`
// reaches the module's `X`, and anything else the file calls `X` does not.
// ---------------------------------------------------------------------------

const LIB_SRC = `export class Agent {
  constructor(readonly name: string) {}
  run(): void {}
  static make(): Agent { return new Agent('a'); }
}
export interface Shape { area(): number }
export function go(): void {}
`;
const LIB_OWN_EDGE = 'POTENTIAL_CALL src/a-lib.ts:Agent.make -> src/a-lib.ts:Agent.constructor';

describe('edges through a named import with an alias', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeProject('aliased-import');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reach the declaration the alias names', async () => {
    writeFiles(dir, {
      'src/a-lib.ts': LIB_SRC,
      'src/z-consumer.ts': `import { Agent as Runtime, Shape as Form, go as start } from './a-lib.js';
export class Child extends Runtime implements Form {
  area(): number { return 1; }
  again(): void { super.run(); }
}
export function build(): unknown { return new Runtime('a'); }
export function use(r: Runtime): void { r.run(); }
export function viaStatic(): unknown { return Runtime.make(); }
export function begin(): void { start(); }
`,
    });

    await expectEdges(dir, [
      LIB_OWN_EDGE,
      'EXTENDS src/z-consumer.ts:Child -> src/a-lib.ts:Agent',
      'IMPLEMENTS src/z-consumer.ts:Child -> src/a-lib.ts:Shape',
      'POTENTIAL_CALL src/z-consumer.ts:Child.again -> src/a-lib.ts:Agent.run',
      'POTENTIAL_CALL src/z-consumer.ts:begin -> src/a-lib.ts:go',
      'POTENTIAL_CALL src/z-consumer.ts:build -> src/a-lib.ts:Agent.constructor',
      'POTENTIAL_CALL src/z-consumer.ts:use -> src/a-lib.ts:Agent.run',
      'POTENTIAL_CALL src/z-consumer.ts:viaStatic -> src/a-lib.ts:Agent.make',
    ]);
  });

  it('store nothing for the exported name when the file binds only the alias', async () => {
    writeFiles(dir, {
      'src/a-lib.ts': LIB_SRC,
      'src/z-consumer.ts': `import { Agent as Runtime, go as start } from './a-lib.js';
declare const Agent: { new (name: string): unknown; make(): unknown };
declare const go: () => void;
export function f(): unknown[] { return [new Agent('a'), Agent.make(), go()]; }
export const keep = [Runtime, start];
`,
    });

    await expectEdges(dir, [LIB_OWN_EDGE]);
  });

  it('keep a declaration of the file apart from an import that exports the same name', async () => {
    writeFiles(dir, {
      'src/a-lib.ts': LIB_SRC,
      'src/z-consumer.ts': `import { Agent as Runtime, go as start } from './a-lib.js';
export class Agent {
  run(): void {}
}
export function go(): void {}
export function own(a: Agent): void { a.run(); go(); }
export function theirs(r: Runtime): void { r.run(); start(); }
`,
    });

    await expectEdges(dir, [
      LIB_OWN_EDGE,
      'POTENTIAL_CALL src/z-consumer.ts:own -> src/z-consumer.ts:Agent.run',
      'POTENTIAL_CALL src/z-consumer.ts:own -> src/z-consumer.ts:go',
      'POTENTIAL_CALL src/z-consumer.ts:theirs -> src/a-lib.ts:Agent.run',
      'POTENTIAL_CALL src/z-consumer.ts:theirs -> src/a-lib.ts:go',
    ]);
  });

  it('follow each binding to its own module when two modules export the name', async () => {
    writeFiles(dir, {
      'src/a-lib.ts': LIB_SRC,
      'src/b-other.ts': `export class Agent {\n  run(): void {}\n}\n`,
      'src/z-consumer.ts': `import { Agent } from './b-other.js';
import { Agent as Runtime } from './a-lib.js';
export function first(a: Agent): void { a.run(); }
export function second(r: Runtime): void { r.run(); }
`,
    });

    await expectEdges(dir, [
      LIB_OWN_EDGE,
      'POTENTIAL_CALL src/z-consumer.ts:first -> src/b-other.ts:Agent.run',
      'POTENTIAL_CALL src/z-consumer.ts:second -> src/a-lib.ts:Agent.run',
    ]);
  });
});
