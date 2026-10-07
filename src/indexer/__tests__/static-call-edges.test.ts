import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { expectEdges, makeProject, writeFiles } from './graph-fixture.js';

// ---------------------------------------------------------------------------
// `X.make()` where X is a class this file imports or declares.
//
// The receiver is a name, not a value with a type, so the extractor cannot
// tell a class from an object or an enum. It records `X.make` whenever X is a
// name the file imports or declares, and the edge is written only if the file
// that declares X has a symbol of that name. So an object with a method of the
// same name gets no edge: its methods are not symbols.
// ---------------------------------------------------------------------------

describe('a static call on a class', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeProject('static-call');
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('reaches the static method, imported, through an index, or in the same file', async () => {
    writeFiles(projectDir, {
      'src/lib/factory.ts': `export class Factory { static make(): Factory { return new Factory(); } }\n`,
      'src/lib/other.ts': `export class Other { static make(): number { return 1; } }\n`,
      'src/lib/index.ts': `export { Other } from './other.js';\n`,
      'src/z.ts': `import { Factory } from './lib/factory.js';
import { Other } from './lib/index.js';
class Local { static make(): number { return 2; } }
export function run(): unknown { return [Factory.make(), Other.make(), Local.make()]; }
`,
    });

    await expectEdges(projectDir, [
      'POTENTIAL_CALL src/lib/factory.ts:Factory.make -> src/lib/factory.ts:Factory',
      'POTENTIAL_CALL src/z.ts:run -> src/lib/factory.ts:Factory.make',
      'POTENTIAL_CALL src/z.ts:run -> src/lib/other.ts:Other.make',
      'POTENTIAL_CALL src/z.ts:run -> src/z.ts:Local.make',
    ]);
  });

  it('has no edge for a method of an imported object, or of a name the file cannot place', async () => {
    writeFiles(projectDir, {
      'src/0-decoy.ts': `export class api { static get(): number { return 0; } }\nexport class Loose { static make(): number { return 0; } }\n`,
      'src/api.ts': `export const api = { get(): number { return 1; } };\n`,
      'src/z.ts': `import { api } from './api.js';
import Loose from 'some-package';
export function run(): unknown { return [api.get(), Loose.make(), Math.max(1, 2)]; }
`,
    });

    await expectEdges(projectDir, []);
  });

  it('reads a parameter of the name as the parameter, not as the class', async () => {
    writeFiles(projectDir, {
      'src/factory.ts': `export class Factory { static make(): number { return 1; } }\nexport class Thing { make(): number { return 2; } }\n`,
      'src/z.ts': `import { Factory, Thing } from './factory.js';
export function run(Factory: Thing): number { return Factory.make(); }
export const all = [Factory];
`,
    });

    await expectEdges(projectDir, ['POTENTIAL_CALL src/z.ts:run -> src/factory.ts:Thing.make']);
  });
});
