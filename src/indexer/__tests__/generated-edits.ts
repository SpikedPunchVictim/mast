import { dirname, relative } from 'node:path';
import type { Round, Scenario } from './equivalence-scenarios.js';

// ---------------------------------------------------------------------------
// T10 — generated edit sequences (adr/proposals/incremental-graph-correctness).
//
// The scenario table holds the cases someone thought of. This builds cases
// nobody did: a small project of files that import, re-export, extend and call
// one another, then a sequence of random edits to it. The names and paths come
// from pools small enough that they collide — the same function name in
// several files, `a.ts` beside `a/index.ts`, an import of a file that does not
// exist yet — because the defects found by hand (D084, D090, D091) all needed
// one of those.
//
// Deterministic for a seed. The result is a `Scenario`, so a sequence that
// fails can be cut down and pasted into equivalence-scenarios.ts as a row.
//
// Interfaces, `implements` and files with broken syntax were added after the
// first seeds had been run. They draw from a second random stream, so what the
// first stream decides for a seed is what it decided before.
//
// Classes that extend one another across files (`H0` to `H2`) were added with
// the walk up `EXTENDS` edges (adr/proposals/inherited-call-edges, T6): with
// two class names a call seldom landed two classes away from its receiver.
// They draw from a third stream.
//
// Not generated, because each is a known gap with its own ledger row or
// deferral: an import or re-export under an alias, a path alias (D087).
// ---------------------------------------------------------------------------

const PATHS = [
  'src/a.ts',
  'src/a/index.ts',
  'src/b.ts',
  'src/c.ts',
  'src/lib/index.ts',
  'src/lib/x.ts',
  'src/lib/y.ts',
  'src/zc.ts',
  'src/zd.ts',
] as const;
const FUNCTIONS = ['f0', 'f1', 'f2'] as const;
const CLASSES = ['K0', 'K1'] as const;
const METHODS = ['m0', 'm1'] as const;
const INTERFACES = ['I0', 'I1'] as const;
const DEEP_CLASSES = ['H0', 'H1', 'H2'] as const;

/** What one import or re-export names: the file a specifier stands for, without extension or `/index`. */
type Stem = string;

interface ImportSpec {
  readonly stem: Stem;
  readonly names: readonly string[];
}

interface ClassSpec {
  readonly name: string;
  readonly parent: string | null;
  readonly implemented: string | null;
  readonly methods: readonly string[];
}

/** `interface` and `type` under one name: a class can name either after `implements`, and only one gets an edge. */
type InterfaceKind = 'interface' | 'type';

/** How a file's text is damaged: cut off inside its last line, or with a line that is not TypeScript before its declarations. */
type Damage = 'none' | 'cut-off' | 'bad-line';

interface FileSpec {
  /** Exported functions, each with a number its body returns. */
  readonly functions: Readonly<Record<string, number>>;
  readonly classes: readonly ClassSpec[];
  readonly imports: readonly ImportSpec[];
  readonly stars: readonly Stem[];
  readonly namedReExports: readonly ImportSpec[];
  readonly interfaces: Readonly<Record<string, InterfaceKind>>;
  readonly damage: Damage;
}

type Project = Map<string, FileSpec>;

/** mulberry32: small, seedable, and the same on every platform. */
function randomSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Dice {
  constructor(private readonly next: () => number) {}

  below(n: number): number {
    return Math.floor(this.next() * n);
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T | undefined {
    return items[this.below(items.length)];
  }

  some<T>(items: readonly T[], probability: number): T[] {
    return items.filter(() => this.chance(probability));
  }
}

function stemOf(path: string): Stem {
  return path.replace(/\.ts$/, '').replace(/\/index$/, '');
}

const STEMS: readonly Stem[] = [...new Set(PATHS.map(stemOf))];

function specifier(fromPath: string, stem: Stem): string {
  const rel = relative(dirname(fromPath), stem);
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function render(path: string, spec: FileSpec): string {
  const lines: string[] = [];
  for (const imp of spec.imports) {
    if (imp.names.length > 0) lines.push(`import { ${imp.names.join(', ')} } from '${specifier(path, imp.stem)}';`);
  }
  for (const stem of spec.stars) lines.push(`export * from '${specifier(path, stem)}';`);
  for (const reExport of spec.namedReExports) {
    if (reExport.names.length > 0) lines.push(`export { ${reExport.names.join(', ')} } from '${specifier(path, reExport.stem)}';`);
  }
  if (spec.damage === 'bad-line') lines.push('export class { function ( => ;');
  for (const [name, value] of Object.entries(spec.functions)) {
    lines.push(`export function ${name}(): number { return ${value}; }`);
  }
  for (const [name, kind] of Object.entries(spec.interfaces)) {
    lines.push(kind === 'interface' ? `export interface ${name} { m0(): void }` : `export type ${name} = { m0(): void };`);
  }
  for (const cls of spec.classes) {
    const parent = cls.parent === null ? '' : ` extends ${cls.parent}`;
    const implemented = cls.implemented === null ? '' : ` implements ${cls.implemented}`;
    lines.push(`export class ${cls.name}${parent}${implemented} { ${cls.methods.map((m) => `${m}(): void {}`).join(' ')} }`);
  }
  const imported = spec.imports.flatMap((imp) => imp.names);
  const calls: string[] = [];
  const parameters: string[] = [];
  for (const name of imported) {
    if (name.startsWith('f')) {
      calls.push(`${name}();`);
    } else if (name.startsWith('I')) {
      parameters.push(`p${name}: ${name}`);
      calls.push(`p${name}.m0();`);
    } else {
      parameters.push(`p${name}: ${name}`);
      calls.push(`p${name}.m0();`, `new ${name}().m1();`);
    }
  }
  if (calls.length > 0) {
    const useName = `use_${path.replace(/[^a-z0-9]/gi, '_')}`;
    lines.push(`export function ${useName}(${parameters.join(', ')}): void { ${calls.join(' ')} }`);
  }
  const text = lines.length === 0 ? '// nothing here\n' : `${lines.join('\n')}\n`;
  return spec.damage === 'cut-off' ? text.slice(0, -Math.min(12, Math.floor(text.length / 2))) : text;
}

/** The interface names a file can put after `implements`: its own and the ones it imports. */
function interfacesInScope(spec: Pick<FileSpec, 'interfaces' | 'imports'>): string[] {
  const imported = spec.imports.flatMap((imp) => imp.names).filter((name) => name.startsWith('I'));
  return [...Object.keys(spec.interfaces), ...imported];
}

function randomFile(dice: Dice, extra: Dice, path: string): FileSpec {
  const ownStem = stemOf(path);
  const others = STEMS.filter((stem) => stem !== ownStem);
  const isBarrel = dice.chance(0.3);

  // A name is imported from one place only: a second import of it is not
  // valid TypeScript, and which of the two wins is not what is under test.
  const imports: ImportSpec[] = [];
  const taken = new Set<string>();
  for (const stem of dice.some(others, isBarrel ? 0.1 : 0.3)) {
    const names = dice.some([...FUNCTIONS, ...CLASSES], 0.4).filter((name) => !taken.has(name));
    for (const name of names) taken.add(name);
    if (names.length > 0) imports.push({ stem, names });
  }

  const ownFunctions = dice.some(FUNCTIONS, isBarrel ? 0.1 : 0.5).filter((name) => !taken.has(name));
  const ownClasses = dice.some(CLASSES, isBarrel ? 0 : 0.3).filter((name) => !taken.has(name));
  const importedClasses = [...taken].filter((name) => name.startsWith('K'));

  const base = {
    functions: Object.fromEntries(ownFunctions.map((name) => [name, dice.below(100)])),
    classes: ownClasses.map((name) => ({
      name,
      parent: dice.chance(0.5) ? (dice.pick(importedClasses) ?? null) : null,
      methods: dice.some(METHODS, 0.6),
    })),
    imports,
    stars: isBarrel ? dice.some(others, 0.3) : dice.some(others, 0.05),
    namedReExports: isBarrel
      ? dice.some(others, 0.2).map((stem) => ({ stem, names: dice.some([...FUNCTIONS, ...CLASSES], 0.4) }))
      : [],
  };

  // Everything below draws from `extra` only.
  const interfaces: Record<string, InterfaceKind> = {};
  const importsWithInterfaces = base.imports.map((imp) => ({ stem: imp.stem, names: [...imp.names] }));
  for (const name of INTERFACES) {
    if (extra.chance(0.25)) {
      interfaces[name] = extra.chance(0.8) ? 'interface' : 'type';
    } else if (extra.chance(0.3)) {
      const stem = extra.pick(others);
      if (stem === undefined) continue;
      const existing = importsWithInterfaces.find((imp) => imp.stem === stem);
      if (existing === undefined) importsWithInterfaces.push({ stem, names: [name] });
      else existing.names.push(name);
    }
  }
  const inScope = interfacesInScope({ interfaces, imports: importsWithInterfaces });
  return {
    ...base,
    imports: importsWithInterfaces,
    namedReExports: base.namedReExports.map((reExport) => ({
      stem: reExport.stem,
      names: [...reExport.names, ...extra.some(INTERFACES, 0.3)],
    })),
    classes: base.classes.map((cls) => ({
      ...cls,
      implemented: extra.chance(0.5) ? (extra.pick(inScope) ?? null) : null,
    })),
    interfaces,
    damage: 'none',
  };
}

type Edit = (project: Project, dice: Dice, extra: Dice) => string | null;

const changeABody: Edit = (project, dice) => {
  const candidates = [...project].filter(([, spec]) => Object.keys(spec.functions).length > 0);
  const chosen = dice.pick(candidates);
  if (chosen === undefined) return null;
  const [path, spec] = chosen;
  const name = dice.pick(Object.keys(spec.functions));
  if (name === undefined) return null;
  project.set(path, { ...spec, functions: { ...spec.functions, [name]: (spec.functions[name] ?? 0) + 100 } });
  return `body of ${name} in ${path}`;
};

const addOrRemoveAFunction: Edit = (project, dice) => {
  const chosen = dice.pick([...project]);
  const name = dice.pick(FUNCTIONS);
  if (chosen === undefined || name === undefined) return null;
  const [path, spec] = chosen;
  if (name in spec.functions) {
    const { [name]: _removed, ...rest } = spec.functions;
    project.set(path, { ...spec, functions: rest });
    return `remove ${name} from ${path}`;
  }
  if (spec.imports.some((imp) => imp.names.includes(name))) return null;
  project.set(path, { ...spec, functions: { ...spec.functions, [name]: dice.below(100) } });
  return `add ${name} to ${path}`;
};

const changeAClass: Edit = (project, dice) => {
  const candidates = [...project].filter(([, spec]) => spec.classes.length > 0);
  const chosen = dice.pick(candidates);
  if (chosen === undefined) return null;
  const [path, spec] = chosen;
  const index = dice.below(spec.classes.length);
  const cls = spec.classes[index];
  const method = dice.pick(METHODS);
  if (cls === undefined || method === undefined) return null;
  let changed: ClassSpec;
  let what: string;
  if (dice.chance(0.3)) {
    const importedClasses = spec.imports.flatMap((imp) => imp.names).filter((name) => name.startsWith('K'));
    const parent = cls.parent === null ? (dice.pick(importedClasses) ?? null) : null;
    changed = { ...cls, parent };
    what = `parent of ${cls.name} to ${parent ?? 'none'}`;
  } else if (cls.methods.includes(method)) {
    changed = { ...cls, methods: cls.methods.filter((m) => m !== method) };
    what = `remove ${cls.name}.${method}`;
  } else {
    changed = { ...cls, methods: [...cls.methods, method] };
    what = `add ${cls.name}.${method}`;
  }
  project.set(path, { ...spec, classes: spec.classes.map((c, i) => (i === index ? changed : c)) });
  return `${what} in ${path}`;
};

const addAFile: Edit = (project, dice, extra) => {
  const path = dice.pick(PATHS.filter((p) => !project.has(p)));
  if (path === undefined) return null;
  project.set(path, randomFile(dice, extra, path));
  return `add ${path}`;
};

const deleteAFile: Edit = (project, dice) => {
  const path = dice.pick([...project.keys()]);
  if (path === undefined || project.size <= 2) return null;
  project.delete(path);
  return `delete ${path}`;
};

/** The file's content goes to a free path; nothing that imported it is told. */
const moveAFile: Edit = (project, dice) => {
  const from = dice.pick([...project.keys()]);
  const to = dice.pick(PATHS.filter((p) => !project.has(p)));
  if (from === undefined || to === undefined) return null;
  const spec = project.get(from);
  if (spec === undefined) return null;
  const toStem = stemOf(to);
  project.delete(from);
  project.set(to, {
    ...spec,
    imports: spec.imports.filter((imp) => imp.stem !== toStem),
    stars: spec.stars.filter((stem) => stem !== toStem),
    namedReExports: spec.namedReExports.filter((reExport) => reExport.stem !== toStem),
  });
  return `move ${from} to ${to}`;
};

/** One import, star or named re-export is pointed at another file. */
const rePoint: Edit = (project, dice) => {
  const candidates = [...project].filter(
    ([, spec]) => spec.imports.length + spec.stars.length + spec.namedReExports.length > 0,
  );
  const chosen = dice.pick(candidates);
  if (chosen === undefined) return null;
  const [path, spec] = chosen;
  const target = dice.pick(STEMS.filter((stem) => stem !== stemOf(path)));
  if (target === undefined) return null;
  const kinds = [
    ...(spec.imports.length > 0 ? ['import' as const] : []),
    ...(spec.stars.length > 0 ? ['star' as const] : []),
    ...(spec.namedReExports.length > 0 ? ['named' as const] : []),
  ];
  const kind = dice.pick(kinds);
  if (kind === 'import') {
    const index = dice.below(spec.imports.length);
    project.set(path, { ...spec, imports: spec.imports.map((imp, i) => (i === index ? { ...imp, stem: target } : imp)) });
  } else if (kind === 'star') {
    const index = dice.below(spec.stars.length);
    project.set(path, { ...spec, stars: [...new Set(spec.stars.map((stem, i) => (i === index ? target : stem)))] });
  } else if (kind === 'named') {
    const index = dice.below(spec.namedReExports.length);
    project.set(path, {
      ...spec,
      namedReExports: spec.namedReExports.map((reExport, i) => (i === index ? { ...reExport, stem: target } : reExport)),
    });
  } else {
    return null;
  }
  return `re-point one ${kind} of ${path} to ${target}`;
};

/** An interface is declared, dropped, or turned into a type alias of the same name, or back. */
const changeAnInterface: Edit = (project, _dice, extra) => {
  const chosen = extra.pick([...project]);
  const name = extra.pick(INTERFACES);
  if (chosen === undefined || name === undefined) return null;
  const [path, spec] = chosen;
  const kind = spec.interfaces[name];
  if (kind === undefined) {
    if (spec.imports.some((imp) => imp.names.includes(name))) return null;
    project.set(path, { ...spec, interfaces: { ...spec.interfaces, [name]: 'interface' } });
    return `add interface ${name} to ${path}`;
  }
  if (extra.chance(0.5)) {
    const flipped: InterfaceKind = kind === 'interface' ? 'type' : 'interface';
    project.set(path, { ...spec, interfaces: { ...spec.interfaces, [name]: flipped } });
    return `turn ${name} in ${path} into ${flipped === 'type' ? 'a type alias' : 'an interface'}`;
  }
  const { [name]: _removed, ...rest } = spec.interfaces;
  project.set(path, { ...spec, interfaces: rest });
  return `remove ${name} from ${path}`;
};

const changeWhatAClassImplements: Edit = (project, _dice, extra) => {
  const candidates = [...project].filter(([, spec]) => spec.classes.length > 0);
  const chosen = extra.pick(candidates);
  if (chosen === undefined) return null;
  const [path, spec] = chosen;
  const index = extra.below(spec.classes.length);
  const cls = spec.classes[index];
  if (cls === undefined) return null;
  const implemented = cls.implemented === null ? (extra.pick(interfacesInScope(spec)) ?? null) : null;
  if (implemented === cls.implemented) return null;
  project.set(path, { ...spec, classes: spec.classes.map((c, i) => (i === index ? { ...c, implemented } : c)) });
  return `${cls.name} in ${path} implements ${implemented ?? 'nothing'}`;
};

/** A file is saved half-written, or a damaged one is put right. */
const damageOrMendAFile: Edit = (project, _dice, extra) => {
  // Half the time a damaged file is the one chosen, when there is one: a file
  // left damaged for the rest of the sequence tests less each round.
  const damaged = [...project].filter(([, spec]) => spec.damage !== 'none');
  const chosen = extra.chance(0.5) ? (extra.pick(damaged) ?? extra.pick([...project])) : extra.pick([...project]);
  if (chosen === undefined) return null;
  const [path, spec] = chosen;
  const damage: Damage = spec.damage !== 'none' ? 'none' : extra.chance(0.5) ? 'cut-off' : 'bad-line';
  project.set(path, { ...spec, damage });
  return damage === 'none' ? `mend ${path}` : `damage ${path} (${damage})`;
};

function isDeep(name: string): boolean {
  return name.startsWith('H');
}

function namesInFile(spec: FileSpec): Set<string> {
  return new Set([...spec.classes.map((cls) => cls.name), ...spec.imports.flatMap((imp) => imp.names)]);
}

function withImport(spec: FileSpec, stem: Stem, name: string): FileSpec {
  const existing = spec.imports.find((imp) => imp.stem === stem);
  const imports =
    existing === undefined
      ? [...spec.imports, { stem, names: [name] }]
      : spec.imports.map((imp) => (imp === existing ? { stem, names: [...imp.names, name] } : imp));
  return { ...spec, imports };
}

/**
 * Where `path` imports `name` from: most of the time a file that declares it,
 * since a chain of classes that resolves nowhere tests nothing.
 */
function stemToImportFrom(project: Project, deep: Dice, path: string, name: string): Stem | undefined {
  const declaring = [...project]
    .filter(([other, spec]) => other !== path && spec.classes.some((cls) => cls.name === name))
    .map(([other]) => stemOf(other));
  const anywhere = deep.pick(STEMS.filter((candidate) => candidate !== stemOf(path)));
  return deep.chance(0.85) ? (deep.pick(declaring) ?? anywhere) : anywhere;
}

/** `spec` with one more class of the deep pool, which most of the time extends another it imports. */
function withDeepClass(project: Project, deep: Dice, path: string, spec: FileSpec): FileSpec | null {
  const taken = namesInFile(spec);
  const name = deep.pick(DEEP_CLASSES.filter((candidate) => !taken.has(candidate)));
  if (name === undefined) return null;
  let next = spec;
  let parent: string | null = null;
  if (deep.chance(0.8)) {
    const already = [...taken].filter(isDeep);
    const fresh = deep.pick(DEEP_CLASSES.filter((candidate) => candidate !== name && !taken.has(candidate)));
    const stem = fresh === undefined ? undefined : stemToImportFrom(project, deep, path, fresh);
    if (already.length > 0 && deep.chance(0.5)) {
      parent = deep.pick(already) ?? null;
    } else if (fresh !== undefined && stem !== undefined) {
      next = withImport(spec, stem, fresh);
      parent = fresh;
    }
  }
  return { ...next, classes: [...next.classes, { name, parent, implemented: null, methods: deep.some(METHODS, 0.4) }] };
}

type DeepEdit = (project: Project, deep: Dice) => string | null;

function pickDeepClass(project: Project, deep: Dice): { path: string; spec: FileSpec; cls: ClassSpec } | null {
  const candidates = [...project].flatMap(([path, spec]) =>
    spec.classes.filter((cls) => isDeep(cls.name)).map((cls) => ({ path, spec, cls })),
  );
  return deep.pick(candidates) ?? null;
}

function replaceClass(project: Project, path: string, spec: FileSpec, from: ClassSpec, to: ClassSpec | null): void {
  const classes = spec.classes.flatMap((cls) => (cls === from ? (to === null ? [] : [to]) : [cls]));
  project.set(path, { ...spec, classes });
}

const addOrRemoveAMethodUpTheChain: DeepEdit = (project, deep) => {
  const chosen = pickDeepClass(project, deep);
  const method = deep.pick(METHODS);
  if (chosen === null || method === undefined) return null;
  const { path, spec, cls } = chosen;
  const has = cls.methods.includes(method);
  const methods = has ? cls.methods.filter((m) => m !== method) : [...cls.methods, method];
  replaceClass(project, path, spec, cls, { ...cls, methods });
  return `${has ? 'remove' : 'add'} ${cls.name}.${method} in ${path}`;
};

const changeWhatADeepClassExtends: DeepEdit = (project, deep) => {
  const chosen = pickDeepClass(project, deep);
  if (chosen === null) return null;
  const { path, spec, cls } = chosen;
  const inScope = [...namesInFile(spec)].filter((name) => isDeep(name) && name !== cls.name && name !== cls.parent);
  const parent = cls.parent !== null && deep.chance(0.5) ? null : (deep.pick(inScope) ?? null);
  if (parent === cls.parent) return null;
  replaceClass(project, path, spec, cls, { ...cls, parent });
  return `${cls.name} in ${path} extends ${parent ?? 'nothing'}`;
};

const addOrRemoveADeepClass: DeepEdit = (project, deep) => {
  if (deep.chance(0.5)) {
    const chosen = pickDeepClass(project, deep);
    if (chosen === null) return null;
    replaceClass(project, chosen.path, chosen.spec, chosen.cls, null);
    return `remove ${chosen.cls.name} from ${chosen.path}`;
  }
  const chosen = deep.pick([...project]);
  if (chosen === undefined) return null;
  const [path, spec] = chosen;
  const next = withDeepClass(project, deep, path, spec);
  if (next === null) return null;
  project.set(path, next);
  return `add ${next.classes.at(-1)?.name ?? 'a class'} to ${path}`;
};

/** A file starts or stops importing a deep class, which makes it a caller of what the class inherits. */
const importOrDropADeepClass: DeepEdit = (project, deep) => {
  const chosen = deep.pick([...project]);
  const name = deep.pick(DEEP_CLASSES);
  if (chosen === undefined || name === undefined) return null;
  const [path, spec] = chosen;
  const stem = stemToImportFrom(project, deep, path, name);
  if (stem === undefined) return null;
  if (spec.imports.some((imp) => imp.names.includes(name))) {
    const imports = spec.imports.map((imp) => ({ stem: imp.stem, names: imp.names.filter((n) => n !== name) }));
    project.set(path, { ...spec, imports });
    return `${path} stops importing ${name}`;
  }
  if (spec.classes.some((cls) => cls.name === name)) return null;
  project.set(path, withImport(spec, stem, name));
  return `${path} imports ${name} from ${stem}`;
};

/** Drawn by the third stream. */
const DEEP_EDITS: readonly DeepEdit[] = [
  addOrRemoveAMethodUpTheChain,
  addOrRemoveAMethodUpTheChain,
  changeWhatADeepClassExtends,
  addOrRemoveADeepClass,
  importOrDropADeepClass,
];

/** Drawn by the second stream, on top of what the first one chose for the round. */
const EXTRA_EDITS: readonly Edit[] = [changeAnInterface, changeAnInterface, changeWhatAClassImplements, damageOrMendAFile];

const EDITS: readonly Edit[] = [
  changeABody,
  changeABody,
  addOrRemoveAFunction,
  addOrRemoveAFunction,
  changeAClass,
  addAFile,
  deleteAFile,
  moveAFile,
  rePoint,
  rePoint,
];

function renderAll(project: Project): Record<string, string> {
  return Object.fromEntries([...project].map(([path, spec]) => [path, render(path, spec)]));
}

export interface GeneratedScenario extends Scenario {
  /** What each round did, in words, for the failure message. */
  readonly edits: readonly string[];
}

/** A project and `steps` rounds of edits to it, the same for the same `seed`. */
export function generateScenario(seed: number, steps: number): GeneratedScenario {
  const dice = new Dice(randomSource(seed));
  const extra = new Dice(randomSource(seed ^ 0x5bd1e995));
  const project: Project = new Map();
  const deep = new Dice(randomSource(seed ^ 0x2545f491));
  for (const path of PATHS) {
    if (dice.chance(0.6)) project.set(path, randomFile(dice, extra, path));
  }
  for (const [path, spec] of [...project]) {
    if (deep.chance(0.6)) project.set(path, withDeepClass(project, deep, path, spec) ?? spec);
  }
  // Callers: a file that imports a deep class calls a method on it, declared there or above.
  for (const [path, spec] of [...project]) {
    const name = deep.pick(DEEP_CLASSES.filter((candidate) => !namesInFile(spec).has(candidate)));
    const stem = name === undefined ? undefined : stemToImportFrom(project, deep, path, name);
    if (name !== undefined && stem !== undefined && deep.chance(0.5)) project.set(path, withImport(spec, stem, name));
  }

  const files = renderAll(project);
  const rounds: Round[] = [];
  const edits: string[] = [];
  let before = files;
  while (rounds.length < steps) {
    const descriptions: string[] = [];
    // Mostly one edit to a round, sometimes two or three: a real save, a real commit.
    const editsThisRound = dice.chance(0.7) ? 1 : 2 + dice.below(2);
    for (let i = 0; i < editsThisRound; i++) {
      const description = dice.pick(EDITS)?.(project, dice, extra) ?? null;
      if (description !== null) descriptions.push(description);
    }
    if (extra.chance(0.4)) {
      const description = extra.pick(EXTRA_EDITS)?.(project, dice, extra) ?? null;
      if (description !== null) descriptions.push(description);
    }
    if (deep.chance(0.5)) {
      const description = deep.pick(DEEP_EDITS)?.(project, deep) ?? null;
      if (description !== null) descriptions.push(description);
    }
    const after = renderAll(project);
    const round: Record<string, string | null> = {};
    for (const [path, content] of Object.entries(after)) {
      if (before[path] !== content) round[path] = content;
    }
    for (const path of Object.keys(before)) {
      if (!(path in after)) round[path] = null;
    }
    if (Object.keys(round).length === 0) continue;
    rounds.push(round);
    edits.push(descriptions.join('; '));
    before = after;
  }

  return { name: `generated sequence, seed ${seed}`, files, rounds, edits };
}
