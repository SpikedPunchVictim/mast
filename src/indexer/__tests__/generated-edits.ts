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

/** What one import or re-export names: the file a specifier stands for, without extension or `/index`. */
type Stem = string;

interface ImportSpec {
  readonly stem: Stem;
  readonly names: readonly string[];
}

interface ClassSpec {
  readonly name: string;
  readonly parent: string | null;
  readonly methods: readonly string[];
}

interface FileSpec {
  /** Exported functions, each with a number its body returns. */
  readonly functions: Readonly<Record<string, number>>;
  readonly classes: readonly ClassSpec[];
  readonly imports: readonly ImportSpec[];
  readonly stars: readonly Stem[];
  readonly namedReExports: readonly ImportSpec[];
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
  for (const [name, value] of Object.entries(spec.functions)) {
    lines.push(`export function ${name}(): number { return ${value}; }`);
  }
  for (const cls of spec.classes) {
    const heritage = cls.parent === null ? '' : ` extends ${cls.parent}`;
    lines.push(`export class ${cls.name}${heritage} { ${cls.methods.map((m) => `${m}(): void {}`).join(' ')} }`);
  }
  const imported = spec.imports.flatMap((imp) => imp.names);
  const calls: string[] = [];
  const parameters: string[] = [];
  for (const name of imported) {
    if (name.startsWith('f')) {
      calls.push(`${name}();`);
    } else {
      parameters.push(`p${name}: ${name}`);
      calls.push(`p${name}.m0();`, `new ${name}().m1();`);
    }
  }
  if (calls.length > 0) {
    const useName = `use_${path.replace(/[^a-z0-9]/gi, '_')}`;
    lines.push(`export function ${useName}(${parameters.join(', ')}): void { ${calls.join(' ')} }`);
  }
  return lines.length === 0 ? '// nothing here\n' : `${lines.join('\n')}\n`;
}

function randomFile(dice: Dice, path: string): FileSpec {
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

  return {
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
}

type Edit = (project: Project, dice: Dice) => string | null;

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

const addAFile: Edit = (project, dice) => {
  const path = dice.pick(PATHS.filter((p) => !project.has(p)));
  if (path === undefined) return null;
  project.set(path, randomFile(dice, path));
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
  const project: Project = new Map();
  for (const path of PATHS) {
    if (dice.chance(0.6)) project.set(path, randomFile(dice, path));
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
      const description = dice.pick(EDITS)?.(project, dice) ?? null;
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
