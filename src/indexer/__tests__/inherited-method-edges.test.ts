import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { expectEdges, makeProject, writeFiles } from './graph-fixture.js';

// ---------------------------------------------------------------------------
// A call of a method the receiver's class inherits
// (adr/proposals/inherited-call-edges). The edge goes to the nearest class
// above the receiver's that declares the method, found along the stored
// `EXTENDS` edges, however many steps up. No edge when the chain leaves the
// index, loops, or forks.
// ---------------------------------------------------------------------------

const BASE = `export class Base {
  find(): void {}
  top(): void {}
  static create(): void {}
}
`;
const MID = `import { Base } from './base.js';
export class Mid extends Base { midOnly(): void {} }
`;
const LEAF = `import { Mid } from './mid.js';
export class Leaf extends Mid {
  own(): void { this.find(); super.top(); }
}
`;
const DEEP = `import { Leaf } from './leaf.js';
export class Deep extends Leaf {}
`;

describe('a call of an inherited method', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeProject('inherited-method-edges');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('links to the declaring class one, two and three classes up, through a field, a parameter and a local', async () => {
    writeFiles(dir, {
      'src/base.ts': BASE,
      'src/mid.ts': MID,
      'src/leaf.ts': LEAF,
      'src/deep.ts': DEEP,
      'src/use.ts': `import { Mid } from './mid.js';
import { Leaf } from './leaf.js';
import { Deep } from './deep.js';
export class Svc {
  constructor(private readonly repo: Mid) {}
  run(): void { this.repo.find(); }
}
export function byParam(leaf: Leaf): void { leaf.find(); }
export function byLocal(): void { const deep = new Deep(); deep.find(); }
export function byStatic(): void { Leaf.create(); }
`,
    });

    await expectEdges(
      dir,
      [
        'POTENTIAL_CALL src/leaf.ts:Leaf.own -> src/base.ts:Base.find',
        'POTENTIAL_CALL src/leaf.ts:Leaf.own -> src/base.ts:Base.top',
        'POTENTIAL_CALL src/use.ts:Svc.run -> src/base.ts:Base.find',
        'POTENTIAL_CALL src/use.ts:byLocal -> src/base.ts:Base.find',
        'POTENTIAL_CALL src/use.ts:byLocal -> src/deep.ts:Deep',
        'POTENTIAL_CALL src/use.ts:byParam -> src/base.ts:Base.find',
        'POTENTIAL_CALL src/use.ts:byStatic -> src/base.ts:Base.create',
      ],
      ['POTENTIAL_CALL'],
    );
  });

  it('links to the nearest class that declares the method, not the furthest', async () => {
    writeFiles(dir, {
      'src/base.ts': BASE,
      'src/mid.ts': `import { Base } from './base.js';\nexport class Mid extends Base { find(): void {} }\n`,
      'src/leaf.ts': `import { Mid } from './mid.js';\nexport class Leaf extends Mid {}\n`,
      'src/use.ts': `import { Leaf } from './leaf.js';\nexport function byParam(leaf: Leaf): void { leaf.find(); leaf.top(); }\n`,
    });

    await expectEdges(
      dir,
      [
        'POTENTIAL_CALL src/use.ts:byParam -> src/base.ts:Base.top',
        'POTENTIAL_CALL src/use.ts:byParam -> src/mid.ts:Mid.find',
      ],
      ['POTENTIAL_CALL'],
    );
  });

  it('links nothing when the class above is not in the index', async () => {
    writeFiles(dir, {
      'src/mid.ts': `import { EventEmitter } from 'node:events';\nexport class Mid extends EventEmitter {}\n`,
      'src/use.ts': `import { Mid } from './mid.js';\nexport function byParam(mid: Mid): void { mid.emit('x'); }\n`,
    });

    await expectEdges(dir, [], ['POTENTIAL_CALL']);
  });

  it('links nothing when the class above is a default import', async () => {
    writeFiles(dir, {
      'src/base.ts': `export default class Base { find(): void {} }\n`,
      'src/mid.ts': `import Base from './base.js';\nexport class Mid extends Base {}\n`,
      'src/use.ts': `import { Mid } from './mid.js';\nexport function byParam(mid: Mid): void { mid.find(); }\n`,
    });

    await expectEdges(dir, [], ['POTENTIAL_CALL']);
  });

  it('links nothing, and ends, when two classes extend each other', async () => {
    writeFiles(dir, {
      'src/a.ts': `import { B } from './b.js';\nexport class A extends B {}\n`,
      'src/b.ts': `import { A } from './a.js';\nexport class B extends A {}\n`,
      'src/use.ts': `import { A } from './a.js';\nexport function byParam(a: A): void { a.find(); }\n`,
    });

    await expectEdges(dir, [], ['POTENTIAL_CALL']);
  });

  // A class and an interface of one name are one symbol with two parents.
  // Which of them declares the method is not decided here.
  it('links nothing when the receiver has two stored parents', async () => {
    writeFiles(dir, {
      'src/parents.ts': `export class A { a(): void {} }\nexport class B { b(): void {} }\n`,
      'src/x.ts': `import { A, B } from './parents.js';\nexport interface X extends B {}\nexport class X extends A {}\n`,
      'src/use.ts': `import { X } from './x.js';\nexport function byParam(x: X): void { x.a(); }\n`,
    });

    await expectEdges(dir, [], ['POTENTIAL_CALL']);
  });

  // D083 for this walk: a caller resolved before the classes between it and
  // the declaring class have their `extends` stored finds no chain to follow.
  it.each([
    { name: 'the caller sorting before every class', use: 'a-use', leaf: 'b-leaf', mid: 'c-mid', base: 'd-base' },
    { name: 'the caller sorting after every class', use: 'z-use', leaf: 'c-leaf', mid: 'b-mid', base: 'a-base' },
    { name: 'the middle class sorting last', use: 'b-use', leaf: 'a-leaf', mid: 'z-mid', base: 'c-base' },
  ])('links the same edges with $name', async ({ use, leaf, mid, base }) => {
    writeFiles(dir, {
      [`src/${base}.ts`]: BASE,
      [`src/${mid}.ts`]: `import { Base } from './${base}.js';\nexport class Mid extends Base {}\n`,
      [`src/${leaf}.ts`]: `import { Mid } from './${mid}.js';\nexport class Leaf extends Mid { own(): void { this.top(); } }\n`,
      [`src/${use}.ts`]: `import { Leaf } from './${leaf}.js';\nexport function byParam(leaf: Leaf): void { leaf.find(); }\n`,
    });

    await expectEdges(
      dir,
      [
        `POTENTIAL_CALL src/${leaf}.ts:Leaf.own -> src/${base}.ts:Base.top`,
        `POTENTIAL_CALL src/${use}.ts:byParam -> src/${base}.ts:Base.find`,
      ],
      ['POTENTIAL_CALL'],
    );
  });
});

// ---------------------------------------------------------------------------
// `this.m()` where the class does not declare `m` and the class it extends
// does. These were written for the first form of the rule, which placed the
// parent by the name in the file's own `extends` clause and went one step up.
// The stored `EXTENDS` edge is placed by that same name, so they hold for the
// walk as they are.
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

// D115. A field, a `declare`d property and a constructor parameter property
// have no symbol row, and a class that has one of the name declares the name:
// the call runs whatever the field holds, not the method above it.
describe('a call of a name the class redeclares as a field', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeProject('inherited-field-shadow');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const BASE_M = `export class Base {
  handle(): void {}
  render(): void {}
  log(): void {}
  keep(): void {}
  kept(): void {}
}
`;

  it('has no edge to the parent\'s method, on `this` or on a receiver typed as the class', async () => {
    writeFiles(dir, {
      'src/base.ts': BASE_M,
      'src/child.ts': `import { Base } from './base.js';
export class Child extends Base {
  handle = (): void => {};
  declare render: () => void;
  constructor(public log: () => void, readonly keep: () => void) { super(); }
  go(): void { this.handle(); this.render(); this.log(); this.keep(); this.kept(); }
}
`,
      'src/use.ts': `import { Child } from './child.js';
export function outer(c: Child): void { c.handle(); c.kept(); }
`,
    });

    await expectEdges(
      dir,
      [
        'POTENTIAL_CALL src/child.ts:Child.go -> src/base.ts:Base.kept',
        'POTENTIAL_CALL src/use.ts:outer -> src/base.ts:Base.kept',
      ],
      ['POTENTIAL_CALL'],
    );
  });

  it('has no edge when a class between the receiver\'s and the method\'s has the field', async () => {
    writeFiles(dir, {
      'src/base.ts': BASE_M,
      'src/mid.ts': `import { Base } from './base.js';
export class Mid extends Base { handle = (): void => {}; }
`,
      'src/leaf.ts': `import { Mid } from './mid.js';
export class Leaf extends Mid { go(): void { this.handle(); this.kept(); } }
`,
    });

    await expectEdges(dir, ['POTENTIAL_CALL src/leaf.ts:Leaf.go -> src/base.ts:Base.kept'], ['POTENTIAL_CALL']);
  });

  // A static field and an instance method of one name are two members.
  it('is not stopped by a static field on an instance receiver, nor by an instance field on the class itself', async () => {
    writeFiles(dir, {
      'src/base.ts': `export class Base {
  handle(): void {}
  static make(): void {}
}
`,
      'src/child.ts': `import { Base } from './base.js';
export class Child extends Base {
  static handle = (): void => {};
  make = (): void => {};
}
export function onInstance(c: Child): void { c.handle(); }
export function onClass(): void { Child.make(); }
`,
    });

    await expectEdges(
      dir,
      [
        'POTENTIAL_CALL src/child.ts:onClass -> src/base.ts:Base.make',
        'POTENTIAL_CALL src/child.ts:onInstance -> src/base.ts:Base.handle',
      ],
      ['POTENTIAL_CALL'],
    );
  });

  it('is stopped by a static field on a call written on the class', async () => {
    writeFiles(dir, {
      'src/base.ts': `export class Base { static make(): void {} static other(): void {} }
`,
      'src/child.ts': `import { Base } from './base.js';
export class Child extends Base { static make = (): void => {}; }
export function onClass(): void { Child.make(); Child.other(); }
`,
    });

    await expectEdges(dir, ['POTENTIAL_CALL src/child.ts:onClass -> src/base.ts:Base.other'], ['POTENTIAL_CALL']);
  });
});
