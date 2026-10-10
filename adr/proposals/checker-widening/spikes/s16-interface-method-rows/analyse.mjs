#!/usr/bin/env node
/**
 * Spike s16: what the call pairs that changed bucket between two scorecards are.
 *
 *   node analyse.mjs <base card> <patched card>
 *
 * For the call edges newly wrong: the target the compiler has for a call of the same
 * method name in the same caller (a pair the patched card lacks), which is where the call
 * goes. For the pairs newly agreeing and newly lacking: how the call is written.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const read = (p) => JSON.parse(p.endsWith('.gz') ? gunzipSync(readFileSync(p)) : readFileSync(p, 'utf8'));
const [base, patched] = process.argv.slice(2).map(read);
const CALLS = 'edge: POTENTIAL_CALL';
const bucketOf = (card) => {
  const map = new Map();
  for (const [bucket, keys] of Object.entries(card.items[CALLS])) for (const key of keys) map.set(key, bucket);
  return map;
};
const before = bucketOf(base);
const after = bucketOf(patched);
const moved = new Map();
for (const [key, bucket] of after) {
  const was = before.get(key) ?? 'absent';
  if (was !== bucket) moved.set(`${was} -> ${bucket}`, [...(moved.get(`${was} -> ${bucket}`) ?? []), key]);
}
for (const [key, bucket] of before) if (!after.has(key)) moved.set(`${bucket} -> absent`, [...(moved.get(`${bucket} -> absent`) ?? []), key]);
console.log('call pairs that changed bucket:');
for (const [move, keys] of [...moved].sort()) console.log(String(keys.length).padStart(8), move);

const written = (key) => Object.entries(patched.breakdowns).filter(([name, b]) => name.startsWith('call written as') && Object.values(b).some((keys) => keys.includes(key))).map(([name]) => name.replace(/, (same|other) file$/, ''));
const writtenIndex = new Map();
for (const [name, b] of Object.entries(patched.breakdowns)) {
  if (!name.startsWith('call written as')) continue;
  for (const keys of Object.values(b)) for (const key of keys) writtenIndex.set(key, name.replace(/, (same|other) file$/, ''));
}
const storedIndex = new Map();
for (const [name, b] of Object.entries(patched.breakdowns)) {
  if (!name.startsWith('call edge, stored as')) continue;
  for (const keys of Object.values(b)) for (const key of keys) storedIndex.set(key, name);
}
const tallyBy = (keys, index) => {
  const t = new Map();
  for (const key of keys) t.set(index.get(key) ?? 'not in a breakdown', (t.get(index.get(key) ?? 'not in a breakdown') ?? 0) + 1);
  return [...t].sort((a, b) => b[1] - a[1]);
};
for (const move of ['absent -> agree', 'absent -> lacks']) {
  console.log(`\n${move}, by how the call is written:`);
  for (const [name, n] of tallyBy(moved.get(move) ?? [], writtenIndex)) console.log(String(n).padStart(8), name);
}
console.log('\nabsent -> agree, by the rule that stored the edge:');
for (const [name, n] of tallyBy(moved.get('absent -> agree') ?? [], storedIndex)) console.log(String(n).padStart(8), name);

// Where the newly wrong edges' calls go.
const lacksByCaller = new Map();
for (const key of patched.items[CALLS].lacks) {
  const [caller, target] = key.split(' > ');
  lacksByCaller.set(caller, [...(lacksByCaller.get(caller) ?? []), target]);
}
const shapes = new Map();
const unexplained = [];
for (const key of moved.get('absent -> wrong') ?? []) {
  const [caller, target] = key.split(' > ');
  const owner = target.slice(target.lastIndexOf(':') + 1, target.lastIndexOf('.'));
  const method = target.slice(target.lastIndexOf('.'));
  const actual = (lacksByCaller.get(caller) ?? []).filter((t) => t.endsWith(method) && t !== target);
  if (actual.length === 0) { unexplained.push(key); continue; }
  for (const t of actual) {
    const actualOwner = t.slice(t.lastIndexOf(':') + 1, t.lastIndexOf('.'));
    const shape = `stored ${owner}${method}, the compiler has ${actualOwner}${method}`;
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
  }
}
console.log(`\nabsent -> wrong: ${(moved.get('absent -> wrong') ?? []).length}; with no lacking pair of the same caller and method name: ${unexplained.length}`);
for (const [shape, n] of [...shapes].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(8), shape);
for (const key of unexplained) console.log('   unexplained', key);
void written;
