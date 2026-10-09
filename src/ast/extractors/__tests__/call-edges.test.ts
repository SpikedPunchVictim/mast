import { describe, it, expect } from 'vitest';
import { parseSource } from '../../parser.js';
import { extractEdges } from '../typescript.js';
import type { EdgeRecord } from '../../types.js';

// Parse `src` and return its edge records. `extractEdges` takes the raw source
// so it can attach the call-site line + context to POTENTIAL_CALL edges.
function edgesOf(src: string): EdgeRecord[] {
  const tree = parseSource(src, '.ts');
  return extractEdges(tree, 'sample.ts', src);
}

function potentialCalls(edges: readonly EdgeRecord[]): EdgeRecord[] {
  return edges.filter((e) => e.edgeType === 'POTENTIAL_CALL');
}

// ---------------------------------------------------------------------------
// POTENTIAL_CALL — §10.3.1 resolver patterns
// ---------------------------------------------------------------------------

describe('extractEdges — POTENTIAL_CALL', () => {
  describe('a decorator written as a call', () => {
    const pairs = (src: string): string[] =>
      potentialCalls(edgesOf(src)).map((e) => `${e.fromName} -> ${e.toName}`);

    it('is a call from the class it is on', () => {
      const edges = potentialCalls(edgesOf(`
        import { Service } from './di';
        @Service()
        class Mailer {}
      `));

      expect(edges.map((e) => `${e.fromName} -> ${e.toName} (${e.resolution ?? ''}) line ${String(e.callLine)}`)).toEqual([
        'Mailer -> Service (import) line 3',
      ]);
    });

    it('is the class\'s when it is written before export', () => {
      expect(pairs(`
        import { Service } from './di';
        @Service()
        export class Mailer {}
      `)).toEqual(['Mailer -> Service']);
    });

    it('is the class\'s when it is on a field, which has no symbol', () => {
      expect(pairs(`
        import { Column } from './orm';
        export class User {
          @Column()
          name = '';
          @Column()
          email: string;
        }
      `)).toEqual(['User -> Column', 'User -> Column']);
    });

    it('is the method\'s when it is on a method', () => {
      expect(pairs(`
        import { Get } from './http';
        export class Users {
          @Get('/users')
          list(): void {}
        }
      `)).toEqual(['Users.list -> Get']);
    });

    it('is the accessor\'s when it is on an accessor', () => {
      expect(pairs(`
        import { Memo } from './memo';
        export class Users {
          @Memo()
          get count(): number { return 1; }
        }
      `)).toEqual(['Users.count -> Memo']);
    });

    it('is the method\'s or the constructor\'s when it is on a parameter', () => {
      expect(pairs(`
        import { Inject, Param } from './http';
        export class Users {
          constructor(@Inject('db') private readonly db: unknown) {}
          one(@Param('id') id: string): void { void id; }
        }
      `)).toEqual(['Users.constructor -> Inject', 'Users.one -> Param']);
    });

    it('gives a call inside its arguments to the same caller', () => {
      expect(pairs(`
        import { Column, Get } from './lib';
        function now(): number { return 1; }
        function limiter(): number { return 1; }
        export class User {
          @Column({ default: () => now() })
          created = 0;
          @Get('/x', limiter())
          list(): void {}
        }
      `)).toEqual(['User -> Column', 'User -> now', 'User.list -> Get', 'User.list -> limiter']);
    });

    it('is the method\'s when a comment is written between the two', () => {
      expect(pairs(`
        import { Post, Scope, Licensed } from './http';
        export class Projects {
          @Post('/')
          @Scope('project:create')
          // every plan with projects allows admins
          @Licensed('admin')
          /* and a block comment */
          create(): void {}
        }
      `)).toEqual(['Projects.create -> Post', 'Projects.create -> Scope', 'Projects.create -> Licensed']);
    });

    it('is not a call when it has no parentheses', () => {
      expect(pairs(`
        import { Injectable, Body } from './lib';
        @Injectable
        export class Users {
          @Injectable
          list(@Body body: string): void { void body; }
        }
      `)).toEqual([]);
    });

    it('is not read when it is parenthesised or reached through a namespace import', () => {
      expect(pairs(`
        import * as orm from './orm';
        import { Make } from './lib';
        @(Make())
        @orm.Entity()
        export class User {}
      `)).toEqual([]);
    });

    it('does not read this in its arguments as the instance', () => {
      expect(pairs(`
        import { Check } from './lib';
        export class Users {
          helper(): number { return 1; }
          @Check(() => this.helper())
          list(): void {}
        }
      `)).toEqual(['Users.list -> Check']);
    });
  });

  it('does not give a function the calls made inside a class it declares', () => {
    const edges = potentialCalls(edgesOf(`
      function helper(): number { return 1; }
      export function outer(): void {
        class Inner { m(): number { return helper(); } }
        void Inner;
      }
    `));

    // `Inner.m` has no symbol, so the call has no caller to be stored under.
    expect(edges.map((e) => `${e.fromName} -> ${e.toName}`)).toEqual([]);
  });

  it('resolves a same-file function call', () => {
    const edges = potentialCalls(edgesOf(`
      function helper(): number { return 1; }
      export function run(): number { return helper(); }
    `));
    const edge = edges.find((e) => e.toName === 'helper');
    expect(edge).toBeDefined();
    expect(edge!.fromName).toBe('run');
    expect(edge!.resolution).toBe('same_file');
  });

  it('resolves a call to a named import', () => {
    const edges = potentialCalls(edgesOf(`
      import { handleLogin } from './handler';
      export function route(): void { handleLogin(); }
    `));
    const edge = edges.find((e) => e.toName === 'handleLogin');
    expect(edge).toBeDefined();
    expect(edge!.fromName).toBe('route');
    expect(edge!.resolution).toBe('import');
  });

  it('resolves this.field.method() via a constructor parameter property', () => {
    const edges = potentialCalls(edgesOf(`
      export class AuthService {
        constructor(private readonly repo: UserRepository) {}
        check(): void { this.repo.findByEmail(); }
      }
    `));
    const edge = edges.find((e) => e.toName === 'UserRepository.findByEmail');
    expect(edge).toBeDefined();
    expect(edge!.fromName).toBe('AuthService.check');
    expect(edge!.resolution).toBe('field_type');
  });

  it('resolves a method call on a `new` expression binding', () => {
    const edges = potentialCalls(edgesOf(`
      export function build(): void {
        const repo = new UserRepository();
        repo.save();
      }
    `));
    const edge = edges.find((e) => e.toName === 'UserRepository.save');
    expect(edge).toBeDefined();
    expect(edge!.resolution).toBe('new_expression');
  });

  it('attaches the call-site line and source context', () => {
    const src = `function helper(): void {}
export function run(): void {
  helper();
}`;
    const edge = potentialCalls(extractEdges(parseSource(src, '.ts'), 'sample.ts', src))
      .find((e) => e.toName === 'helper');
    expect(edge).toBeDefined();
    expect(edge!.callLine).toBe(3);
    expect(edge!.context).toContain('helper()');
  });

  it('does not resolve dynamic/unknown receivers (no false positives)', () => {
    const edges = potentialCalls(edgesOf(`
      export function run(): void {
        getService().doThing();
        registry['key'].doThing();
      }
    `));
    expect(edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// F3 — await unwrapping
// ---------------------------------------------------------------------------

describe('extractEdges — POTENTIAL_CALL await unwrapping (F3)', () => {
  it('resolves `(await x).m()` — parenthesized await wrapping an annotated-parameter receiver', () => {
    const edges = potentialCalls(edgesOf(`
      export async function run(repo: UserRepository): Promise<void> {
        (await repo).findById(id);
      }
    `));
    const edge = edges.find((e) => e.toName === 'UserRepository.findById');
    expect(edge).toBeDefined();
    expect(edge!.resolution).toBe('parameter_type');
  });

  it('resolves `await this.users.create(x)` — await wrapping a field-typed call already reached by collectCalls', () => {
    const edges = potentialCalls(edgesOf(`
      export class Service {
        constructor(private readonly users: UserRepository) {}
        async run(x: unknown): Promise<void> {
          await this.users.create(x);
        }
      }
    `));
    const edge = edges.find((e) => e.toName === 'UserRepository.create');
    expect(edge).toBeDefined();
    expect(edge!.resolution).toBe('field_type');
  });

  it('resolves a call with explicit type arguments — `x.m<T>()`', () => {
    const edges = potentialCalls(edgesOf(`
      export function run(repo: UserRepository): void {
        repo.findById<string>(id);
      }
    `));
    const edge = edges.find((e) => e.toName === 'UserRepository.findById');
    expect(edge).toBeDefined();
    expect(edge!.resolution).toBe('parameter_type');
  });

  it('does NOT infer through an unannotated await binding (no promise-unwrapped type inference)', () => {
    const edges = potentialCalls(edgesOf(`
      export async function run(): Promise<void> {
        const y = await makeFoo();
        y.bar();
      }
    `));
    expect(edges.find((e) => e.toName.endsWith('.bar'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// F4 — this./super. resolution
// ---------------------------------------------------------------------------

describe('extractEdges — POTENTIAL_CALL this./super. resolution (F4)', () => {
  it('resolves `this.helper()` inside a method to the enclosing class', () => {
    const edges = potentialCalls(edgesOf(`
      export class Klass {
        caller(): void { this.helper(); }
        helper(): void {}
      }
    `));
    const edge = edges.find((e) => e.toName === 'Klass.helper');
    expect(edge).toBeDefined();
    expect(edge!.fromName).toBe('Klass.caller');
    expect(edge!.resolution).toBe('this_method');
  });

  it('resolves `super.base()` to the parent class named in the extends clause', () => {
    const edges = potentialCalls(edgesOf(`
      export class Base {
        base(): void {}
      }
      export class Klass extends Base {
        caller(): void { super.base(); }
      }
    `));
    const edge = edges.find((e) => e.toName === 'Base.base');
    expect(edge).toBeDefined();
    expect(edge!.fromName).toBe('Klass.caller');
    expect(edge!.resolution).toBe('super_method');
  });

  it('emits no super edge when the class has no extends clause', () => {
    const edges = potentialCalls(edgesOf(`
      export class Klass {
        caller(): void { super.base(); }
      }
    `));
    expect(edges.find((e) => e.toName.endsWith('.base'))).toBeUndefined();
  });

  it('does NOT resolve `this.helper()` inside a nested function_expression (this is not the class instance there)', () => {
    const edges = potentialCalls(edgesOf(`
      export class Klass {
        caller(): void {
          const inner = function () { this.helper(); };
          inner();
        }
        helper(): void {}
      }
    `));
    expect(edges.find((e) => e.toName === 'Klass.helper')).toBeUndefined();
  });

  it('resolves `this.helper()` inside an arrow function within the method (arrows inherit `this`)', () => {
    const edges = potentialCalls(edgesOf(`
      export class Klass {
        caller(): void {
          const inner = () => { this.helper(); };
          inner();
        }
        helper(): void {}
      }
    `));
    const edge = edges.find((e) => e.toName === 'Klass.helper');
    expect(edge).toBeDefined();
    expect(edge!.fromName).toBe('Klass.caller');
    expect(edge!.resolution).toBe('this_method');
  });
});

// ---------------------------------------------------------------------------
// POTENTIAL_CALL — where in a declaration the call sits (D098)
//
// A call belongs to the nearest enclosing declaration that has a symbol. None
// of the positions below has a symbol of its own, so each call is its
// enclosing declaration's.
// ---------------------------------------------------------------------------

describe('extractEdges — POTENTIAL_CALL by position (D098)', () => {
  const LOCAL = 'function local(n: number): number { return n; }';

  /** `from -> to [resolution]` for every call edge in `src`, sorted. */
  function calls(src: string): string[] {
    return potentialCalls(edgesOf(src))
      .map((e) => `${e.fromName} -> ${e.toName} [${String(e.resolution)}]`)
      .sort();
  }

  it.each([
    [
      'a function declared inside a function',
      `${LOCAL}
       export function outer(): number { function inner(): number { return local(1); } return inner(); }`,
      ['outer -> local [same_file]'],
    ],
    [
      'a method of an object literal',
      `${LOCAL}
       export const make = () => ({ go(): number { return local(1); } });`,
      ['make -> local [same_file]'],
    ],
    [
      'an arrow function whose body is the call',
      `${LOCAL}
       export const short = (n: number) => local(n);`,
      ['short -> local [same_file]'],
    ],
    [
      'a default parameter value',
      `${LOCAL}
       export function withDefault(n: number = local(1)): number { return n; }`,
      ['withDefault -> local [same_file]'],
    ],
    [
      'a class property initializer',
      `${LOCAL}
       export class K { field = local(1); }`,
      ['K -> local [same_file]'],
    ],
    [
      'a method call on an annotated parameter of a nested arrow function',
      `export function build(): (e: Env) => number { return (e: Env) => e.record(1); }`,
      ['build -> Env.record [parameter_type]'],
    ],
  ])('links a call in %s', (_position, src, expected) => {
    expect(calls(src)).toEqual(expected);
  });

  it('does not read `this` in an object-literal method as the enclosing class', () => {
    const src = `export class A {
      m(): unknown { return { go() { return this.own(); } }; }
      own(): number { return 1; }
    }`;

    expect(calls(src)).toEqual([]);
  });

  it('does not read a nested parameter as the outer parameter of the same name', () => {
    const src = `export function f(e: Env, xs: Other[]): unknown { return xs.map((e) => e.record(1)); }`;

    expect(calls(src)).toEqual([]);
  });

  it('reads a nested parameter by its own annotation, not the outer one', () => {
    const src = `export function f(e: Env, xs: Other[]): unknown { return xs.map((e: Other) => e.record(1)); }`;

    expect(calls(src)).toEqual(['f -> Other.record [parameter_type]']);
  });

  it('does not read a call of a nested parameter as a call of the import it is named after', () => {
    const src = `import { imported } from './lib';
      export function f(xs: readonly (() => void)[]): void { xs.forEach((imported) => imported()); }`;

    expect(calls(src)).toEqual([]);
  });

  // D104. A name declared inside the function is that declaration, whatever
  // the file imports or declares at the top under the same name. n8n has
  // `const unsupportedAction = () => ...` in a method of a file that imports a
  // function of that name; the call was stored as a call of the import.
  const IMPORTS = `import { fail, Repo } from './lib';`;

  it.each([
    ['a local const', `export function f(): unknown { const fail = () => 1; return fail(); }`],
    ['a local let', `export function f(): unknown { let fail = () => 1; return fail(); }`],
    ['a function declared inside', `export function f(): unknown { function fail(): number { return 1; } return fail(); }`],
    ['a destructured local', `export function f(o: { fail(): void }): void { const { fail } = o; fail(); }`],
    ['a renamed destructured local', `export function f(o: { x(): void }): void { const { x: fail } = o; fail(); }`],
    ['a loop variable', `export function f(fs: (() => void)[]): void { for (const fail of fs) fail(); }`],
    ['a caught value', `export function f(): void { try { g(); } catch (fail) { fail(); } }`],
    ['its own parameter', `export function f(fail: () => void): void { fail(); }`],
    ['its own destructured parameter', `export function f({ fail }: { fail(): void }): void { fail(); }`],
    ['a parameter of the method it is in', `export class K { m(fail: () => void): void { fail(); } }`],
    ['a local used as a receiver', `export function f(): unknown { const Repo = pick(); return Repo.make(); }`],
    ['a local that is constructed', `export function f(): unknown { const Repo = pick(); return new Repo(); }`],
    ['a class declared inside', `export function f(): unknown { class Repo {} return new Repo(); }`],
    ['its own parameter used as a receiver', `export function f(Repo: Maker): unknown { return Repo.make(); }`.replace(': Maker', '')],
    ['the one bare parameter of an arrow', `export const f = fail => fail();`],
    ['a parameter of an arrow that initializes a field', `export class K { h = (fail: () => void) => fail(); }`],
    [
      'a local of the function around the one it is in',
      `export function f(xs: number[]): unknown { const fail = () => 1; return xs.map(() => fail()); }`,
    ],
  ])('does not read a call of %s as a call of the import it is named after', (_what, src) => {
    expect(calls(`${IMPORTS}\n${src}`)).toEqual([]);
  });

  it('does not read a call of a local as a call of the top-level function it is named after', () => {
    const src = `${LOCAL}
      export function f(): unknown { const local = () => 1; return local(); }`;

    expect(calls(src)).toEqual([]);
  });

  it('keeps the import for a function that declares no such name', () => {
    const src = `${IMPORTS}
      export function f(): unknown { const fail = () => 1; return fail(); }
      export function g(): unknown { return [fail(), Repo.make(), new Repo()]; }`;

    expect(calls(src)).toEqual([
      'g -> Repo [construction]',
      'g -> Repo.make [static_method]',
      'g -> fail [import]',
    ]);
  });

  // A default value is an expression, not a name the pattern binds. n8n has
  // `({ telemetry = useTelemetry() })` as a parameter.
  it.each([
    ['its own destructured parameter', `export function f({ t = fail() }: { t?: number }): void {}`],
    ['a destructured local', `export function f(o: { t?: number }): unknown { const { t = fail() } = o; return t; }`],
    ['a destructured array local', `export function f(o: number[]): unknown { const [t = fail()] = o; return t; }`],
    [
      'a destructured parameter of a nested function',
      `export function f(xs: { t?: number }[]): unknown { return xs.map(({ t = fail() }) => t); }`,
    ],
  ])('keeps the import for a call in the default value of %s', (_what, src) => {
    expect(calls(`${IMPORTS}\n${src}`)).toEqual(['f -> fail [import]']);
  });

  // n8n's `createVectorStoreNode = (args) => class ... { execute() { handleInsertOperation(...) } }`.
  it('keeps the calls in a class that is the whole body of an arrow', () => {
    const src = `${IMPORTS}
      export const f = (n: number) => class { m(): unknown { return fail(); } };`;

    expect(calls(src)).toEqual(['f -> fail [import]']);
  });

  it('keeps the import outside the nested function that declares the name', () => {
    const src = `${IMPORTS}
      export function f(xs: number[]): unknown { xs.forEach(() => { const fail = 1; return fail; }); return fail(); }`;

    expect(calls(src)).toEqual(['f -> fail [import]']);
  });

  it('still reads a local bound to `new X()` as an X', () => {
    const src = `${IMPORTS}
      export function f(): unknown { const repo = new Repo(); return repo.find(); }`;

    expect(calls(src)).toEqual(['f -> Repo [construction]', 'f -> Repo.find [new_expression]']);
  });

  it('reads its own annotated parameter by the annotation, not as the import of the same name', () => {
    const src = `import { repo, Repo } from './lib';
      export function f(repo: Repo): unknown { return repo.find(); }`;

    expect(calls(src)).toEqual(['f -> Repo.find [parameter_type]']);
  });
});

// ---------------------------------------------------------------------------
// POTENTIAL_CALL — construction
// ---------------------------------------------------------------------------

// D116. Which declaration of a name a call sees is decided by the blocks
// around the call, as the language decides it, not by the first `new` bound to
// the name anywhere in the function.
describe('extractEdges — a local bound to `new X()`, by block (D116)', () => {
  const memberCalls = (body: string): string[] =>
    potentialCalls(edgesOf(`
      class A { run(): void {} }
      class B { run(): void {} }
      declare function other(): any;
      ${body}
    `))
      .filter((e) => e.resolution !== 'construction')
      .map((e) => `${e.fromName} -> ${e.toName}`);

  it('reads the binding of the block the call is in, when another block binds the name first', () => {
    expect(memberCalls(`
      export function f(kind: string): void {
        if (kind === 'a') { const c = new A(); void c; } else { const c = new B(); c.run(); }
      }
    `)).toEqual(['f -> B.run']);
  });

  it('reads the binding of the `case` block the call is in', () => {
    expect(memberCalls(`
      export function f(kind: string): void {
        switch (kind) {
          case 'a': { const h = new A(); void h; break; }
          default: { const h = new B(); h.run(); }
        }
      }
    `)).toEqual(['f -> B.run']);
  });

  it('does not read a local of one callback by the `new` bound to its name in another', () => {
    expect(memberCalls(`
      export function f(items: any[]): void {
        items.forEach(() => { const r = new A(); void r; });
        items.forEach((x) => { const r = x.other; r.run(); });
      }
    `)).toEqual([]);
  });

  it('reads a block-local `new` over the annotated parameter of the same name', () => {
    expect(memberCalls(`
      export function f(c: A, flag: boolean): void {
        if (flag) { const c = new B(); c.run(); }
      }
    `)).toEqual(['f -> B.run']);
  });

  it('does not read a block-local of unknown type by the annotated parameter of the same name', () => {
    expect(memberCalls(`
      export function f(c: A, flag: boolean): void {
        if (flag) { const c = other(); c.run(); }
      }
    `)).toEqual(['f -> other']);
  });

  it('reads the enclosing block\'s binding from a block inside it', () => {
    expect(memberCalls(`
      export function f(flag: boolean): void {
        const c = new A();
        if (flag) { c.run(); }
      }
    `)).toEqual(['f -> A.run']);
  });

  it('does not read a call written after the block that binds the name', () => {
    expect(memberCalls(`
      export function f(flag: boolean): void {
        if (flag) { const c = new A(); void c; }
        c.run();
      }
    `)).toEqual([]);
  });

  it('reads a `var` bound in a block from anywhere in the function', () => {
    expect(memberCalls(`
      export function f(flag: boolean): void {
        if (flag) { var c = new A(); }
        c.run();
      }
    `)).toEqual(['f -> A.run']);
  });

  it('does not read a loop variable by the `new` bound to its name outside the loop', () => {
    expect(memberCalls(`
      export function f(items: any[]): void {
        const c = new A();
        for (const c of items) { c.run(); }
        void c;
      }
    `)).toEqual([]);
  });

  it('still reads a `new` bound inside a callback, in that callback', () => {
    expect(memberCalls(`
      export function f(items: any[]): void {
        items.forEach(() => { const r = new A(); r.run(); });
      }
    `)).toEqual(['f -> A.run']);
  });
});

describe('extractEdges — construction', () => {
  it('emits a construction edge to the class named in `new X()`', () => {
    const edges = potentialCalls(edgesOf(`
      import { Repo } from './repo';
      class Local {}
      export function build(): unknown { return [new Repo(), new Local()]; }
    `));

    expect(edges.map((e) => `${e.fromName} -> ${e.toName} [${String(e.resolution)}]`).sort()).toEqual([
      'build -> Local [construction]',
      'build -> Repo [construction]',
    ]);
  });

  it('emits nothing for a class that is neither imported nor declared in the file', () => {
    const edges = potentialCalls(edgesOf(`export function build(): unknown { return new Map(); }`));

    expect(edges).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POTENTIAL_CALL — an awaited call with type arguments (D103)
//
// tree-sitter-typescript 0.23.2 reads `await f<T>(x)` as `(await f)<T>(x)`:
// the call's function is the await expression. TypeScript reads it as
// `await (f<T>(x))`.
// ---------------------------------------------------------------------------

describe('extractEdges — an awaited call with type arguments', () => {
  it.each([
    { call: 'await helper<number>(1)', edge: 'run -> helper [import]' },
    { call: 'await repo.find<number>(1)', edge: 'run -> Repo.find [parameter_type]' },
    { call: 'await helper(1)', edge: 'run -> helper [import]' },
  ])('links `$call`', ({ call, edge }) => {
    const edges = potentialCalls(edgesOf(`
      import { helper, Repo } from './lib';
      export async function run(repo: Repo): Promise<unknown> { return ${call}; }
    `));

    expect(edges.map((e) => `${e.fromName} -> ${e.toName} [${String(e.resolution)}]`)).toEqual([edge]);
  });

  it('links `await this.m<T>()` to the method of the class', () => {
    const edges = potentialCalls(edgesOf(`
      export class Svc {
        async own<T>(x: T): Promise<T> { return x; }
        async run(): Promise<number> { return await this.own<number>(1); }
      }
    `));

    expect(edges.map((e) => `${e.fromName} -> ${e.toName} [${String(e.resolution)}]`)).toEqual([
      'Svc.run -> Svc.own [this_method]',
    ]);
  });
});

// ---------------------------------------------------------------------------
// EXTENDS
// ---------------------------------------------------------------------------

describe('extractEdges — EXTENDS', () => {
  it('emits an EXTENDS edge for a class extends clause', () => {
    const edges = edgesOf(`export class Derived extends Base {}`);
    const edge = edges.find((e) => e.edgeType === 'EXTENDS');
    expect(edge).toBeDefined();
    expect(edge!.fromName).toBe('Derived');
    expect(edge!.toName).toBe('Base');
  });
});

// D117, D123. A bare name, a class constructed and a name taken from a
// dynamic import are each read by the declaration the call's block sees.
describe('extractEdges — a name declared in a block, read by block (D117, D123)', () => {
  const calls = (body: string): string[] =>
    potentialCalls(edgesOf(`
      import { run, Repo, pick } from './local';
      ${body}
    `)).map((e) => `${e.fromName} -> ${e.importModule ?? '.'}:${e.toName}`);

  it('leaves a call after the block to the static import, when the block takes the name from a dynamic import', () => {
    expect(calls(`
      export async function main(flag: boolean): Promise<void> {
        if (flag) { const { run } = await import('./remote'); void run; return; }
        run();
      }
    `)).toEqual(['main -> ./local:run']);
  });

  it('places a call inside the block by the dynamic import, beside another block that declares the name', () => {
    expect(calls(`
      export async function main(flag: boolean): Promise<void> {
        if (flag) { const { run } = await import('./remote'); run(); } else { const run = pick; run(); }
      }
    `)).toEqual(['main -> ./remote:run']);
  });

  it('leaves a call before a callback to the static import, when the callback declares the name', () => {
    expect(calls(`
      export function main(items: unknown[]): void {
        run();
        items.forEach(() => { const run = pick; run(); });
      }
    `)).toEqual(['main -> ./local:run']);
  });

  it('stores nothing through a static member of a name another block takes from a dynamic import', () => {
    expect(calls(`
      export async function main(flag: boolean): Promise<void> {
        if (flag) { const { Other } = await import('./remote'); void Other; }
        else { const Other = pick; Other.make(); }
      }
    `)).toEqual([]);
  });

  it('stores nothing for a method on `new` of a local that has an imported class\'s name', () => {
    expect(calls(`
      export function f(): void { const Repo = pick(); const r = new Repo(); r.find(); }
    `)).toEqual(['f -> ./local:pick']);
  });

  it('stores nothing for a method on `new` of a parameter that has an imported class\'s name', () => {
    expect(calls(`
      export function g(Repo: any): void { const r = new Repo(); r.find(); }
    `)).toEqual([]);
  });

  it('stores nothing for a method on `new` of a callback parameter that has an imported class\'s name', () => {
    expect(calls(`
      export function h(items: any[]): void { items.forEach((Repo) => { const r = new Repo(); r.find(); }); }
    `)).toEqual([]);
  });

  it('reads `new` of the imported class in a block beside one where the name is a local', () => {
    expect(calls(`
      export function f(flag: boolean): void {
        if (flag) { const Repo = pick; void Repo; } else { const r = new Repo(); r.find(); }
      }
    `)).toEqual(['f -> ./local:Repo', 'f -> ./local:Repo.find']);
  });

  it('places a method on `new` of a class taken from a dynamic import in that module', () => {
    expect(calls(`
      export async function f(): Promise<void> {
        const { Agent } = await import('./remote'); const a = new Agent(); a.go();
      }
    `)).toEqual(['f -> ./remote:Agent', 'f -> ./remote:Agent.go']);
  });
});
