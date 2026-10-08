import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'vitest';
import {
  editFile,
  expectEdges,
  expectGraphEqualsFullIndex,
  expectStoredEdges,
  indexFull,
  indexIncremental,
  makeProject,
  writeFiles,
} from './graph-fixture.js';

// ---------------------------------------------------------------------------
// `const { X } = await import('./x')`. `X` is a local, and a local hides the
// file's imports (D104); but this local is bound to a module as surely as a
// static import is. n8n `packages/cli` had 19 right edges that depended on it.
// ---------------------------------------------------------------------------

const LIB_SRC = `export class Agent {
  constructor(readonly name: string) {}
  run(): void {}
  static make(): Agent { return new Agent('a'); }
}
export function go(): void {}
`;
const LIB_OWN_EDGE = 'POTENTIAL_CALL src/a-lib.ts:Agent.make -> src/a-lib.ts:Agent.constructor';
const WHOLE = `export async function build(): Promise<unknown> {
  const { Agent, go: start } = await import('./a-lib.js');
  const agent = new Agent('a');
  agent.run();
  Agent.make();
  start();
  return agent;
}
`;
const WHOLE_EDGES = [
  LIB_OWN_EDGE,
  'POTENTIAL_CALL src/z-consumer.ts:build -> src/a-lib.ts:Agent.constructor',
  'POTENTIAL_CALL src/z-consumer.ts:build -> src/a-lib.ts:Agent.make',
  'POTENTIAL_CALL src/z-consumer.ts:build -> src/a-lib.ts:Agent.run',
  'POTENTIAL_CALL src/z-consumer.ts:build -> src/a-lib.ts:go',
];

describe('edges through a local taken from a dynamic import', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeProject('dynamic-import');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reach the module the import names, with no static import of it', async () => {
    writeFiles(dir, { 'src/a-lib.ts': LIB_SRC, 'src/z-consumer.ts': WHOLE });

    await expectEdges(dir, WHOLE_EDGES);
  });

  it('reach it beside a type import of the same name under an alias', async () => {
    writeFiles(dir, {
      'src/a-lib.ts': LIB_SRC,
      'src/z-consumer.ts': `import type { Agent as RuntimeAgent } from './a-lib.js';\nexport type Kept = RuntimeAgent;\n${WHOLE}`,
    });

    await expectEdges(dir, WHOLE_EDGES);
  });

  it('hide a static import of the same name from another module, in that function only', async () => {
    writeFiles(dir, {
      'src/a-lib.ts': LIB_SRC,
      'src/b-other.ts': `export function go(): void {}\n`,
      'src/z-consumer.ts': `import { go } from './b-other.js';
export async function dynamic(): Promise<void> {
  const { go } = await import('./a-lib.js');
  go();
}
export function fixed(): void { go(); }
`,
    });

    await expectEdges(dir, [
      LIB_OWN_EDGE,
      'POTENTIAL_CALL src/z-consumer.ts:dynamic -> src/a-lib.ts:go',
      'POTENTIAL_CALL src/z-consumer.ts:fixed -> src/b-other.ts:go',
    ]);
  });

  it('store nothing for a local destructured from anything else', async () => {
    writeFiles(dir, {
      'src/a-lib.ts': LIB_SRC,
      'src/z-consumer.ts': `import { go } from './a-lib.js';
declare function load(): Promise<{ go: () => void }>;
export async function f(): Promise<void> {
  const { go } = await load();
  go();
}
export const keep = go;
`,
    });

    // `load` is a function of this file (D109) and `f` calls it. `go` is its own local.
    await expectEdges(dir, [LIB_OWN_EDGE, 'POTENTIAL_CALL src/z-consumer.ts:f -> src/z-consumer.ts:load']);
  });

  it('follow an edit to the module on an incremental run', async () => {
    writeFiles(dir, { 'src/a-lib.ts': LIB_SRC, 'src/z-consumer.ts': WHOLE });
    await indexFull(dir);

    editFile(dir, 'src/a-lib.ts', LIB_SRC.replace('export function go(): void {}\n', ''));
    await indexIncremental(dir);
    await expectGraphEqualsFullIndex(dir);

    editFile(dir, 'src/a-lib.ts', LIB_SRC);
    await indexIncremental(dir);
    await expectGraphEqualsFullIndex(dir);
    await expectStoredEdges(dir, WHOLE_EDGES);
  });
});
