import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../graph/db.js';
import { queryImplementors } from '../../graph/queries.js';
import {
  configFor,
  editFile,
  expectEdges,
  expectStoredEdges,
  indexFull,
  indexIncremental,
  makeProject,
  writeFiles,
} from './graph-fixture.js';

// ---------------------------------------------------------------------------
// T5 and T16 — IMPLEMENTS, EXTENDS and PARENT_OF follow evidence in the file,
// never a name match across the graph (D085; decision 1 of
// adr/proposals/incremental-graph-correctness).
//
// Evidence is an import of the name or a declaration of it in the same file.
// With neither, no edge is recorded: on n8n the name guess produced 27 edges
// for such records and all 27 were wrong (spikes/s6-structural-fallback).
//
// Decoy files are named to sort first, so their rows are the first with the
// name and the guess lands on them.
// ---------------------------------------------------------------------------

const STRUCTURAL = ['EXTENDS', 'IMPLEMENTS'] as const;

describe('structural edges with no evidence in the file', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeProject('structural-none');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Typed, so each row's `files` is a plain path-to-source map and not a union
  // of every row's keys.
  const CASES: readonly { readonly name: string; readonly files: Readonly<Record<string, string>> }[] = [
    {
      name: 'an interface extending the built-in Record, beside a class named Record',
      files: {
        'src/0-record.ts': `export class Record { get(): void {} }\n`,
        'src/payload.ts': `export interface Payload extends Record<string, unknown> { id: string }\n`,
      },
    },
    {
      name: 'a class extending the built-in Error, beside a class named Error',
      files: {
        'src/0-error.ts': `export class Error { describe(): void {} }\n`,
        'src/failure.ts': `export class Failure extends Error {}\n`,
      },
    },
    {
      name: 'a base class imported from a package, beside a class of that name',
      files: {
        'src/0-command.ts': `export class Command { parse(): void {} }\n`,
        'src/run.ts': `import { Command } from '@oclif/core';\nexport class Run extends Command {}\n`,
      },
    },
    {
      name: 'an interface imported from a package, beside an interface of that name',
      files: {
        'src/0-tracer.ts': `export interface Tracer { trace(): void }\n`,
        'src/noop.ts': `import type { Tracer } from '@opentelemetry/api';\nexport class Noop implements Tracer { trace(): void {} }\n`,
      },
    },
  ];

  it.each(CASES)('records no edge for $name', async ({ files }) => {
    writeFiles(dir, files);

    await expectEdges(dir, [], STRUCTURAL);
  });

  // Was a no-edge case until D106: the import is the evidence, under the name
  // the module exports. The unrelated class named as the alias is still not it.
  it('follows an aliased import to the class its module exports', async () => {
    writeFiles(dir, {
      'src/0-b.ts': `export class B { unrelated(): void {} }\n`,
      'src/a.ts': `export class A { real(): void {} }\n`,
      'src/c.ts': `import { A as B } from './a.js';\nexport class C extends B {}\n`,
    });

    await expectEdges(dir, ['EXTENDS src/c.ts:C -> src/a.ts:A'], STRUCTURAL);
  });
});

describe('structural edges with evidence in the file', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeProject('structural-evidence');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a same-file declaration wins over a class of that name elsewhere', async () => {
    writeFiles(dir, {
      'src/0-error.ts': `export class Error { describe(): void {} }\n`,
      'src/failure.ts': `class Error { local(): void {} }\nexport class Failure extends Error {}\n`,
    });

    await expectEdges(dir, ['EXTENDS src/failure.ts:Failure -> src/failure.ts:Error'], STRUCTURAL);
  });

  it('implements follows the import when a type alias elsewhere has the interface name', async () => {
    writeFiles(dir, {
      'src/0-types.ts': `export type Handler = () => void;\n`,
      'src/handler.ts': `export interface Handler { run(): void }\n`,
      'src/z-impl.ts': `import type { Handler } from './handler.js';\nexport class Impl implements Handler { run(): void {} }\n`,
    });

    await expectEdges(dir, ['IMPLEMENTS src/z-impl.ts:Impl -> src/handler.ts:Handler'], STRUCTURAL);
  });

  it('mast_implementors lists that class', async () => {
    writeFiles(dir, {
      'src/0-types.ts': `export type Handler = () => void;\n`,
      'src/handler.ts': `export interface Handler { run(): void }\n`,
      'src/z-impl.ts': `import type { Handler } from './handler.js';\nexport class Impl implements Handler { run(): void {} }\n`,
    });
    await indexFull(dir);
    const db = openDatabase(configFor(dir).resolved_state_dir);

    const implementors = await queryImplementors(db, 'Handler');
    await db.destroy();

    expect(implementors.map((i) => `${i.file_path}:${i.class_name}`)).toEqual(['src/z-impl.ts:Impl']);
  });

  // Both classes declare `render`. A member looked up by name across the graph
  // finds the first `Widget.render` for both classes; distinct member names
  // alone would pass under that lookup.
  it('two classes with one name each keep their own members', async () => {
    writeFiles(dir, {
      'src/a/widget.ts': `export class Widget { render(): void {} alpha(): void {} }\n`,
      'src/b/widget.ts': `export class Widget { render(): void {} beta(): void {} }\n`,
    });

    await expectEdges(
      dir,
      [
        'PARENT_OF src/a/widget.ts:Widget -> src/a/widget.ts:Widget.alpha',
        'PARENT_OF src/a/widget.ts:Widget -> src/a/widget.ts:Widget.render',
        'PARENT_OF src/b/widget.ts:Widget -> src/b/widget.ts:Widget.beta',
        'PARENT_OF src/b/widget.ts:Widget -> src/b/widget.ts:Widget.render',
      ],
      ['PARENT_OF'],
    );
  });

  it('mast_implementors gives two implementing classes with one name their own methods', async () => {
    writeFiles(dir, {
      'src/port.ts': `export interface Port { open(): void }\n`,
      'src/a/adapter.ts': `import type { Port } from '../port.js';\nexport class Adapter implements Port { open(): void {} alpha(): void {} }\n`,
      'src/b/adapter.ts': `import type { Port } from '../port.js';\nexport class Adapter implements Port { open(): void {} beta(): void {} }\n`,
    });
    await indexFull(dir);
    const db = openDatabase(configFor(dir).resolved_state_dir);

    const implementors = await queryImplementors(db, 'Port');
    await db.destroy();

    expect(
      implementors.map((i) => `${i.file_path}: ${[...i.methods].sort().join(', ')}`).sort(),
    ).toEqual([
      'src/a/adapter.ts: Adapter.alpha, Adapter.open',
      'src/b/adapter.ts: Adapter.beta, Adapter.open',
    ]);
  });
});

describe('the same interface name declared in two files (T5)', () => {
  let dir: string;

  // The other declaration sorts LAST here, so the first full index is right
  // under a name match too. Re-writing the imported file gives its rows newer
  // ids than the other file's, and a name match then flips.
  const PORT_SRC = `export interface Port { open(): void }\n`;
  const OTHER_SRC = `export interface Port { close(): void }\n`;
  const implSrc = (body: string): string =>
    `import type { Port } from './port.js';\nexport class Impl implements Port { open(): void {${body}} }\n`;
  const EXPECTED = ['IMPLEMENTS src/impl.ts:Impl -> src/port.ts:Port'];

  beforeEach(() => {
    dir = makeProject('structural-two-files');
    writeFiles(dir, {
      'src/port.ts': PORT_SRC,
      'src/impl.ts': implSrc(''),
      'src/zz-other.ts': OTHER_SRC,
    });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('implements follows the import on a full index', async () => {
    await expectEdges(dir, EXPECTED, STRUCTURAL);
  });

  it('and still does after the imported file and the class are both re-written', async () => {
    await indexFull(dir);
    editFile(dir, 'src/port.ts', `export interface Port { open(): void; extra(): void }\n`);
    editFile(dir, 'src/impl.ts', implSrc(' return; '));

    await indexIncremental(dir);

    await expectStoredEdges(dir, EXPECTED, STRUCTURAL);
  });

  it('and still does after the other file and the class are both re-written', async () => {
    await indexFull(dir);
    editFile(dir, 'src/zz-other.ts', `export interface Port { close(): void; extra(): void }\n`);
    editFile(dir, 'src/impl.ts', implSrc(' return; '));

    await indexIncremental(dir);

    await expectStoredEdges(dir, EXPECTED, STRUCTURAL);
  });
});
