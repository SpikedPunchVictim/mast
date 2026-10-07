import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { expectEdges, makeProject, writeFiles } from './graph-fixture.js';

// ---------------------------------------------------------------------------
// `this.m()` where the class does not declare `m` and the class it extends
// does.
//
// The call is placed by the same evidence as `super.m()`: the name in the
// `extends` clause, traced through this file's imports or declarations. One
// step up only. A method declared two classes up has no edge yet: finding it
// means reading the parent's own `extends`, which this file does not hold
// (adr/proposals/graph-reference/spikes/RESULTS.md, "Inherited methods").
// ---------------------------------------------------------------------------

describe('a `this` call of an inherited method', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeProject('inherited-method');
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('reaches the method on the parent class, imported or in the same file', async () => {
    writeFiles(projectDir, {
      'src/base.ts': `export class Base { helper(): number { return 1; } }\n`,
      'src/z.ts': `import { Base } from './base.js';
export class Child extends Base { run(): number { return this.helper(); } }
class Local { own(): number { return 2; } }
export class LocalChild extends Local { run(): number { return this.own(); } }
`,
    });

    await expectEdges(projectDir, [
      'EXTENDS src/z.ts:Child -> src/base.ts:Base',
      'EXTENDS src/z.ts:LocalChild -> src/z.ts:Local',
      'POTENTIAL_CALL src/z.ts:Child.run -> src/base.ts:Base.helper',
      'POTENTIAL_CALL src/z.ts:LocalChild.run -> src/z.ts:Local.own',
    ]);
  });

  it('reaches it when the parent is imported through a re-exporting index', async () => {
    writeFiles(projectDir, {
      'src/lib/base.ts': `export class Base { helper(): number { return 1; } }\n`,
      'src/lib/index.ts': `export { Base } from './base.js';\n`,
      'src/z.ts': `import { Base } from './lib/index.js';
export class Child extends Base { run(): number { return this.helper(); } }
`,
    });

    await expectEdges(projectDir, [
      'EXTENDS src/z.ts:Child -> src/lib/base.ts:Base',
      'POTENTIAL_CALL src/z.ts:Child.run -> src/lib/base.ts:Base.helper',
    ]);
  });

  it('stays on the class\'s own method when it overrides the parent\'s', async () => {
    writeFiles(projectDir, {
      'src/base.ts': `export class Base { helper(): number { return 1; } }\n`,
      'src/z.ts': `import { Base } from './base.js';
export class Child extends Base {
  override helper(): number { return 2; }
  run(): number { return this.helper(); }
}
`,
    });

    await expectEdges(projectDir, [
      'EXTENDS src/z.ts:Child -> src/base.ts:Base',
      'POTENTIAL_CALL src/z.ts:Child.run -> src/z.ts:Child.helper',
    ]);
  });

  // The parent here is a name the file neither imports by name nor declares.
  // A class called `Base` with a `helper` exists elsewhere, and is not it.
  it('has no edge when the parent class cannot be placed', async () => {
    writeFiles(projectDir, {
      'src/0-decoy.ts': `export class Base { helper(): number { return 1; } }\n`,
      'src/z.ts': `import Base from 'some-package';
export class Child extends Base { run(): number { return this.helper(); } }
`,
    });

    await expectEdges(projectDir, [
    ]);
  });
});
