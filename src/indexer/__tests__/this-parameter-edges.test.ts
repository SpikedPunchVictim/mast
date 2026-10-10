import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { expectEdges, makeProject, writeFiles } from './graph-fixture.js';

// ---------------------------------------------------------------------------
// A function may say what its `this` is: `function run(this: Context) {}`.
// `this.m()` in it is then a call on a receiver of that type, as a call on any
// other annotated parameter is (adr/proposals/checker-widening, "A `this`
// parameter").
// ---------------------------------------------------------------------------

const CONTEXT = `export interface Context {
  getInput(): string;
  helpers: { request(): void };
}
`;

describe('a call on `this` in a function with a `this` parameter', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeProject('this-parameter-edges');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('goes to the method of the parameter\'s type, from a function and from an arrow in it', async () => {
    writeFiles(dir, {
      'src/context.ts': CONTEXT,
      'src/use.ts': `import type { Context } from './context.js';
export function run(this: Context): void { this.getInput(); }
export function later(this: Context): void { [1].forEach(() => this.getInput()); }
`,
    });

    await expectEdges(
      dir,
      ['POTENTIAL_CALL src/use.ts:later -> src/context.ts:Context.getInput', 'POTENTIAL_CALL src/use.ts:run -> src/context.ts:Context.getInput'],
      ['POTENTIAL_CALL'],
    );
  });

  it('goes to the parameter\'s type and not to the class the method is written in', async () => {
    writeFiles(dir, {
      'src/context.ts': CONTEXT,
      'src/node.ts': `import type { Context } from './context.js';
export class Node {
  getInput(): string { return ''; }
  execute(this: Context): void { this.getInput(); }
  plain(): void { this.getInput(); }
  // a type with no name: the receiver is still not the class
  loose(this: { getInput(): string }): void { this.getInput(); }
}
`,
    });

    await expectEdges(
      dir,
      ['POTENTIAL_CALL src/node.ts:Node.execute -> src/context.ts:Context.getInput', 'POTENTIAL_CALL src/node.ts:Node.plain -> src/node.ts:Node.getInput'],
      ['POTENTIAL_CALL'],
    );
  });

  it('does not read a field of the class the method is written in', async () => {
    writeFiles(dir, {
      'src/context.ts': CONTEXT,
      'src/node.ts': `import type { Context } from './context.js';
export class Client { request(): void {} }
export class Node {
  private helpers = new Client();
  constructor(private readonly other: Client) {}
  execute(this: Context): void { this.helpers.request(); }
  plain(): void { this.other.request(); }
}
`,
    });

    await expectEdges(
      dir,
      ['POTENTIAL_CALL src/node.ts:Node -> src/node.ts:Client', 'POTENTIAL_CALL src/node.ts:Node.plain -> src/node.ts:Client.request'],
      ['POTENTIAL_CALL'],
    );
  });

  // typeorm's `static count<T>(this: { new (): T } & typeof BaseEntity)`: the type has
  // no one name, and says the receiver is the class.
  it('leaves `this` as the class when the parameter\'s type is written with `typeof` the class', async () => {
    writeFiles(dir, {
      'src/entity.ts': `export class Entity {
  static repo(): string { return ''; }
  static count<T extends Entity>(this: { new (): T } & typeof Entity): string { return this.repo(); }
}
`,
    });

    await expectEdges(dir, ['POTENTIAL_CALL src/entity.ts:Entity.count -> src/entity.ts:Entity.repo'], ['POTENTIAL_CALL']);
  });

  it('is not read in a nested function, whose `this` is its own, nor for a member of a member', async () => {
    writeFiles(dir, {
      'src/context.ts': CONTEXT,
      'src/use.ts': `import type { Context } from './context.js';
export function run(this: Context): void {
  function inner(): void { this.getInput(); }
  inner();
  this.helpers.request();
}
`,
    });

    await expectEdges(dir, [], ['POTENTIAL_CALL']);
  });

  it('is not read as a class when the function has no `this` parameter', async () => {
    writeFiles(dir, {
      'src/context.ts': CONTEXT,
      'src/use.ts': `export function run(): void { this.getInput(); }\n`,
    });

    await expectEdges(dir, [], ['POTENTIAL_CALL']);
  });
});
