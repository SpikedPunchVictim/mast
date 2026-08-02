// Q1/OUTCOME — build the frozen task set, per the registered provenance protocol.
//
// PROVENANCE (IMPLEMENTATION_PLAN.md § "Q1/OUTCOME > Task set"): tasks must be real
// and NOT about MAST. The sampling frame is pre-existing prose in the OTHER packages
// — packages/workbench/{foldv2,sdd,fold,metrics} and packages/kluster-bt — written
// for unrelated purposes before this experiment existed. Nothing here is authored:
// a candidate is a doc line that names a backticked identifier which resolves to
// EXACTLY ONE symbol in a non-mast source file. That symbol's (file, line) is the
// ground truth, cited by the document itself.
//
// Requiring a UNIQUE symbol resolution is what makes the ground truth mechanical
// rather than a judgement call. Ambiguous names are dropped, not adjudicated.
//
// Selection is a seeded shuffle (SEED below) fixed before any candidate was seen.
// Strata assignment is likewise mechanical: the first 6 sampled rows are S-ident
// (verbatim, identifiers retained), the next 6 are S-concept (to be paraphrased
// identifier-free in a separate step, then overlap-audited).
//
//   node eval/ab-build-tasks.mjs

import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SEED = 20260802;
const STATE = process.env.MAST_AB_STATE ?? join(homedir(), '.cache', 'mast-eval', 'ab-state');
const REPO = join(process.cwd(), '..', '..');
const K = 12;

// Sampling frame — deliberately excludes packages/mast entirely.
const DOC_GLOBS = [
  'packages/workbench/foldv2',
  'packages/workbench/sdd',
  'packages/workbench/fold',
  'packages/workbench/metrics',
  'packages/kluster-bt',
];

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const db = new Database(join(STATE, 'graph.db'), { readonly: true });

// Symbols in NON-mast source files only. `export`-kind marker rows are excluded
// (§10.1: they anchor barrel edges and are not real declarations).
const symRows = db.prepare(`
  SELECT s.name, s.kind, s.line, f.path
  FROM symbols s JOIN files f ON s.file_id = f.id
  WHERE s.kind != 'export'
    AND f.path NOT LIKE 'packages/mast/%'
    AND (f.path LIKE '%.ts' OR f.path LIKE '%.tsx')
`).all();

const byName = new Map();
for (const r of symRows) {
  if (!byName.has(r.name)) byName.set(r.name, []);
  byName.get(r.name).push(r);
}

// A chunk must exist at the symbol's location for the target to be retrievable.
const chunkAt = db.prepare('SELECT chunk_id, start_line, end_line, chunk_type, symbol_name FROM chunks WHERE file_path = ? AND start_line <= ? AND end_line >= ? LIMIT 1');

const docFiles = execSync(
  `cd ${JSON.stringify(REPO)} && git ls-files ${DOC_GLOBS.map((g) => JSON.stringify(g + '/**/*.md')).join(' ')}`,
  { encoding: 'utf8' },
).trim().split('\n').filter(Boolean);

const candidates = [];
for (const doc of docFiles) {
  const abs = join(REPO, doc);
  if (!existsSync(abs)) continue;
  const lines = readFileSync(abs, 'utf8').split('\n');
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const text = line.replace(/^[\s>*\-|#]+/, '').trim();
    if (text.length < 45 || text.length > 260) return;

    const ticked = [...text.matchAll(/`([A-Za-z_][A-Za-z0-9_.]*)`/g)].map((m) => m[1]);
    for (const raw of ticked) {
      const nm = raw.includes('.') ? raw : raw; // qualified method names resolve as-is
      const hits = byName.get(nm);
      if (hits === undefined || hits.length !== 1) continue; // UNIQUE resolution only
      const t = hits[0];
      const ch = chunkAt.get(t.path, t.line, t.line);
      if (ch === undefined) continue;
      candidates.push({
        source_doc: doc,
        source_line: i + 1,
        text,
        identifier: nm,
        target: { file_path: t.path, symbol: nm, kind: t.kind, line: t.line, chunk_key: `${ch.start_line}`, chunk_type: ch.chunk_type },
      });
      return; // one candidate per doc line
    }
  });
}

// Dedup by target symbol so no two tasks share a ground truth.
const seen = new Set();
const pool = candidates.filter((c) => {
  const k = `${c.target.file_path}:${c.target.symbol}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

const rng = mulberry32(SEED);
const shuffled = pool.map((c) => ({ c, r: rng() })).sort((a, b) => a.r - b.r).map((x) => x.c);
const picked = shuffled.slice(0, K);

picked.forEach((t, i) => {
  t.id = `T${String(i + 1).padStart(2, '0')}`;
  t.stratum = i < 6 ? 'S-ident' : 'S-concept';
  t.query = t.stratum === 'S-ident' ? t.text : null; // paraphrase filled in by ab-paraphrase step
});

const out = {
  registered: 'IMPLEMENTATION_PLAN.md § Q1/OUTCOME',
  built_at: new Date().toISOString(),
  seed: SEED,
  state: STATE,
  docs_scanned: docFiles.length,
  candidates_found: candidates.length,
  pool_after_dedup: pool.length,
  k: K,
  tasks: picked,
};
writeFileSync('./eval/ab-tasks.json', JSON.stringify(out, null, 2));

console.log(`docs scanned      : ${docFiles.length}`);
console.log(`candidate lines   : ${candidates.length}`);
console.log(`pool after dedup  : ${pool.length}`);
console.log(`sampled (seed ${SEED}) : ${picked.length}\n`);
for (const t of picked) {
  console.log(`${t.id} [${t.stratum}] ${t.target.file_path}:${t.target.line} (${t.target.symbol})`);
  console.log(`     ${t.text.slice(0, 120)}`);
  console.log(`     src: ${t.source_doc}:${t.source_line}`);
}
