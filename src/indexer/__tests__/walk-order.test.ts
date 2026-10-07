import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { expectEdges, makeProject, writeFiles } from './graph-fixture.js';

// ---------------------------------------------------------------------------
// T4 — a full index gives the same edges whatever order the files are walked
// in (D083; adr/proposals/incremental-graph-correctness).
//
// Pass 2 resolves each file's edges and writes its star rows in walk order, so
// a caller that sorts before the barrel it imports through finds neither the
// barrel's re-export edge nor its star row. The project below is the same in
// every row; only the file names, and so the order, change.
// ---------------------------------------------------------------------------

const LEAF_SRC = `export class Base { hello(): void {} }
export interface Shape { area(): number }
export function make(): void {}
`;

function consumerSrc(entry: string): string {
  return `import { Base, Shape, make } from './${entry}.js';
export class Child extends Base implements Shape {
  area(): number { return 1; }
}
export function go(): void { make(); }
`;
}

const NAMED = (from: string): string => `export { Base, Shape, make } from './${from}.js';\n`;
const STAR = (from: string): string => `export * from './${from}.js';\n`;

interface Layout {
  readonly name: string;
  readonly consumer: string;
  readonly leaf: string;
  /** Barrel file names, nearest the consumer first. */
  readonly barrels: readonly string[];
  readonly kind: (from: string) => string;
}

const LAYOUTS: readonly Layout[] = [
  { name: 'named barrel, caller sorts after it', consumer: 'z-consumer', leaf: 'a-leaf', barrels: ['m-barrel'], kind: NAMED },
  { name: 'named barrel, caller sorts before it', consumer: 'a-consumer', leaf: 'z-leaf', barrels: ['m-barrel'], kind: NAMED },
  { name: 'star barrel, caller sorts after it', consumer: 'z-consumer', leaf: 'a-leaf', barrels: ['m-barrel'], kind: STAR },
  { name: 'star barrel, caller sorts before it', consumer: 'a-consumer', leaf: 'z-leaf', barrels: ['m-barrel'], kind: STAR },
  { name: 'three named barrels, each sorting after the one it re-exports from', consumer: 'z-consumer', leaf: 'a-leaf', barrels: ['d-barrel', 'c-barrel', 'b-barrel'], kind: NAMED },
  { name: 'three named barrels, each sorting before the one it re-exports from', consumer: 'z-consumer', leaf: 'y-leaf', barrels: ['b-barrel', 'c-barrel', 'd-barrel'], kind: NAMED },
  { name: 'three star barrels, caller sorting before all of them', consumer: 'a-consumer', leaf: 'y-leaf', barrels: ['b-barrel', 'c-barrel', 'd-barrel'], kind: STAR },
];

describe('a full index does not depend on walk order', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeProject('walk-order');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(LAYOUTS)('$name', async (layout) => {
    const files: Record<string, string> = {
      [`src/${layout.leaf}.ts`]: LEAF_SRC,
      [`src/${layout.consumer}.ts`]: consumerSrc(layout.barrels[0]!),
    };
    layout.barrels.forEach((barrel, i) => {
      files[`src/${barrel}.ts`] = layout.kind(layout.barrels[i + 1] ?? layout.leaf);
    });
    writeFiles(dir, files);

    await expectEdges(
      dir,
      [`POTENTIAL_CALL src/${layout.consumer}.ts:go -> src/${layout.leaf}.ts:make`],
      ['POTENTIAL_CALL'],
    );
  });

  it('a barrel mixing a named and a star re-export serves callers on both sides of it', async () => {
    writeFiles(dir, {
      'src/barrel.ts': `export { g } from './impl.js';\nexport * from './star.js';\n`,
      'src/impl.ts': `export function g(): void {}\n`,
      'src/star.ts': `export function z(): void {}\n`,
      'src/a_first.ts': `import { g, z } from './barrel.js';\nexport function early(): void { g(); z(); }\n`,
      'src/zz_last.ts': `import { g, z } from './barrel.js';\nexport function late(): void { g(); z(); }\n`,
    });

    await expectEdges(
      dir,
      [
        'POTENTIAL_CALL src/a_first.ts:early -> src/impl.ts:g',
        'POTENTIAL_CALL src/a_first.ts:early -> src/star.ts:z',
        'POTENTIAL_CALL src/zz_last.ts:late -> src/impl.ts:g',
        'POTENTIAL_CALL src/zz_last.ts:late -> src/star.ts:z',
      ],
      ['POTENTIAL_CALL'],
    );
  });
  // TypeScript gives a name the file re-exports by name that export alone; an
  // `export *` beside it does not supply the name as well. The outer barrel
  // sorts first, so its record is resolved while the inner barrel's own edge
  // is still unwritten, and a search that went on to the star would settle on
  // `other.ts`.
  it('a named re-export is not replaced by a same-named declaration behind a star beside it', async () => {
    writeFiles(dir, {
      'src/a-outer.ts': `export { make } from './m-barrel.js';\n`,
      'src/m-barrel.ts': `export { make } from './real.js';\nexport * from './other.js';\n`,
      'src/other.ts': `export function make(): void {}\n`,
      'src/real.ts': `export function make(): void {}\n`,
      'src/z-consumer.ts': `import { make } from './a-outer.js';\nexport function go(): void { make(); }\n`,
    });

    await expectEdges(
      dir,
      [
        'POTENTIAL_CALL src/z-consumer.ts:go -> src/real.ts:make',
        'RE_EXPORTS src/a-outer.ts:make -> src/real.ts:make',
        'RE_EXPORTS src/m-barrel.ts:make -> src/real.ts:make',
      ],
      ['POTENTIAL_CALL', 'RE_EXPORTS'],
    );
  });
});
