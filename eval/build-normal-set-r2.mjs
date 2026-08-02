// Q1-r2 — rebuild the lexically-normal query set from the TARGET, not from prose.
//
// v1 harvested query text verbatim from in-corpus documents, so each query was a
// near-perfect trigram match for its own source paragraph and the lexical arm
// returned that chunk alone (VOID run, see IMPLEMENTATION_PLAN.md). v2 derives
// the query from the target itself:
//
//   query = camelCaseSplit(symbol_name) + first sentence of its TSDoc, <= 12 words
//
// The 15 TARGETS are carried over unchanged from v1 (they were selected
// mechanically by seed); only the wording changes, which keeps the two runs
// comparable on the same needles.
//
// KNOWN BIAS, declared before running: a chunk's TSDoc is part of its own indexed
// content, so this hands the LEXICAL arm tokens that sit inside the target. The
// normal set is therefore biased FOR lexical — deliberately. See the bracketing
// design in IMPLEMENTATION_PLAN.md § "Q1-r2 — RE-REGISTERED protocol".

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../dist/graph/db.js';
import { SqliteChunkStore } from '../dist/store/sqliteChunkStore.js';
import { BASE_STATE_DIR, PROJECT_ROOT, CORPUS_SHA } from './paths.mjs';

const MAX_WORDS = 12;
const v1 = JSON.parse(readFileSync(new URL('./gold-set-normal.json', import.meta.url), 'utf-8'));

const db = openDatabase(BASE_STATE_DIR);
const chunks = await new SqliteChunkStore(db).getAllChunks();
await db.destroy();
if (chunks.length === 0) { console.error('FAIL: corpus empty'); process.exit(1); }

const byFile = new Map();
for (const c of chunks) {
  if (!byFile.has(c.file_path)) byFile.set(c.file_path, []);
  byFile.get(c.file_path).push(c);
}

/** `walkProject` -> "walk project";  `Foo.barBaz` -> "foo bar baz" */
function splitIdent(name) {
  return name
    .replace(/[._]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** First sentence of the TSDoc immediately preceding `startLine` (1-indexed). */
function tsdocFirstSentence(filePath, startLine) {
  const lines = readFileSync(join(PROJECT_ROOT, filePath), 'utf-8').split('\n');
  let i = startLine - 2;                       // line above the declaration
  while (i >= 0 && lines[i].trim() === '') i--;
  if (i < 0 || !lines[i].trim().endsWith('*/')) return '';
  const block = [];
  while (i >= 0) {
    block.unshift(lines[i]);
    if (lines[i].trim().startsWith('/**')) break;
    i--;
  }
  const text = block
    .join(' ')
    .replace(/\/\*\*|\*\//g, ' ')
    .replace(/^\s*\*\s?/gm, ' ')
    .replace(/\s*\*\s/g, ' ')
    .replace(/`|\{@\w+\s*|\}/g, ' ')
    .replace(/@\w+/g, ' ')                     // @param/@throws tags
    .replace(/\s{2,}/g, ' ')
    .trim();
  const m = text.match(/^(.*?[.!?])(\s|$)/);
  return (m ? m[1] : text).trim();
}

const queries = [];
const skipped = [];
for (const q of v1.queries) {
  const t = q.relevant[0];
  const fc = byFile.get(t.file_path) ?? [];
  const hit = fc.find((c) => t.line >= c.start_line && t.line <= c.end_line);
  if (!hit) { skipped.push(`${q.id} ${t.file_path}:${t.line} (no chunk in r2 corpus)`); continue; }

  const symWords = splitIdent(hit.symbol_name ?? '');
  const docWords = tsdocFirstSentence(t.file_path, hit.start_line)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  // symbol words first (an agent leads with the identifier), then doc prose,
  // deduped, capped. Cap is on WORDS so no query can become a phrase-match key.
  const seen = new Set();
  const words = [];
  for (const w of [...symWords, ...docWords]) {
    if (w.length < 2 || seen.has(w)) continue;
    seen.add(w);
    words.push(w);
    if (words.length >= MAX_WORDS) break;
  }
  if (words.length < 3) { skipped.push(`${q.id} ${hit.symbol_name} (too few query words)`); continue; }

  queries.push({
    id: q.id,
    query: words.join(' '),
    derived_from: hit.symbol_name ?? `L${hit.start_line}`,
    had_tsdoc: docWords.length > 0,
    relevant: [{ file_path: t.file_path, line: t.line }],
  });
}

const out = {
  version: '2.0.0',
  created: '2026-08-01',
  supersedes: 'gold-set-normal.json v1.0.0 (VOID — in-corpus source leakage)',
  corpus: { corpus_sha: CORPUS_SHA, chunks: chunks.length },
  purpose: 'Lexically-normal counterweight to gold-set.json for Q1-r2.',
  derivation: `query = camelCaseSplit(symbol_name) + first TSDoc sentence, deduped, capped at ${MAX_WORDS} words`,
  declared_bias:
    'BIASED FOR THE LEXICAL ARM, deliberately and stated before the run. A chunk\'s TSDoc is part of its own indexed content, so these queries hand FTS tokens that sit inside the target. Q1-r2 is a BRACKETING design: this set is rigged for lexical, gold-set.json is rigged for vectors (§14.3). A win on the set rigged against you is decisive; each arm winning its own set is ambiguous by construction and escalates to real agent queries.',
  targets_carried_from_v1: true,
  skipped,
  queries,
};

writeFileSync(new URL('./gold-set-normal-r2.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(`built ${queries.length} queries (${skipped.length} skipped), corpus ${chunks.length} chunks\n`);
for (const q of queries) console.log(`${q.id}  [${q.derived_from}]${q.had_tsdoc ? '' : ' (no tsdoc)'}\n     "${q.query}"`);
if (skipped.length) console.log('\nskipped:'), skipped.forEach((s) => console.log('  ' + s));
