// Q1 provenance protocol — extract candidate "lexically-normal" queries from
// this repo's own PRE-EXISTING task descriptions.
//
// Why this source: the 28-query gold-set.json was, by its own provenance_note,
// "deliberately worded to minimize lexical overlap" — it can kill vectors but
// never justify them (GITNEXUS_COMPARISON.md §14.3). Hand-authoring 15
// replacements now would bias the other way, since the author knows which arm
// each phrasing favours. Instead we harvest descriptions that were written by a
// human, for an unrelated purpose (tracking work), BEFORE this experiment was
// designed — and that cite their own ground truth as `file.ts:NNN`.
//
// Critically: we read the docs from the PINNED worktree, not the live tree, so
// nothing written during the Q1 design can leak into the query set.
//
// Rule: query = the description with the file:line citation STRIPPED (an agent
// that already knows file:line has no reason to search); target = that citation.
// Identifiers stay in the query — that is exactly what makes these queries
// "normal" rather than the anti-lexical class.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT, CORPUS_SHA } from './paths.mjs';

const SEED = 20260801;
const SOURCES = [
  'packages/mast/IMPLEMENTATION_PLAN.md',
  'packages/mast/eval/GITNEXUS_COMPARISON.md',
];

// `foo/bar.ts:123` or `bar.ts:123` — the cited ground truth.
const CITE = /`?([\w./-]+\.(?:ts|tsx|js|mjs))[`]?:(\d+)/g;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const candidates = [];
for (const src of SOURCES) {
  const abs = join(PROJECT_ROOT, src);
  if (!existsSync(abs)) { console.error(`skip (absent at pin): ${src}`); continue; }
  const lines = readFileSync(abs, 'utf-8').split('\n');
  lines.forEach((line, i) => {
    const cites = [...line.matchAll(CITE)];
    if (cites.length !== 1) return;               // ambiguous or none — skip
    if (line.length < 60 || line.length > 320) return;  // too thin / too rambling
    candidates.push({
      source: `${src}:${i + 1}`,
      raw: line.trim(),
      citedFile: cites[0][1],
      citedLine: Number(cites[0][2]),
    });
  });
}

const rand = mulberry32(SEED);
for (let i = candidates.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
}

console.log(`corpus_sha: ${CORPUS_SHA}`);
console.log(`candidates: ${candidates.length}  (seed ${SEED}, shuffled)\n`);
for (const c of candidates.slice(0, 40)) {
  console.log(`--- ${c.source}  ->  ${c.citedFile}:${c.citedLine}`);
  console.log(`    ${c.raw}\n`);
}
