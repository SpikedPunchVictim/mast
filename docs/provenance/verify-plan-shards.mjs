// Provenance check for the ADR shard split (ADR 001).
//
// Reassembles every adr/proposals/<feature>/PLAN-EXCERPT.md in original line order and asserts
// the result is IMPLEMENTATION_PLAN.md byte-for-byte. It is runnable ONLY at the commit that
// created the shards, while the root plan is still the full 11,459-line document — the next
// commit replaces that file with a routing stub. Kept as the auditable record that the split
// was lossless, not as a live test.
//
//   git stash && git checkout <shard-commit> && node docs/provenance/verify-plan-shards.mjs

import { readFileSync } from 'node:fs';
// Independent reassembly: walk the shards in ORIGINAL line order and rebuild the file.
const SEGMENTS = [
  [1,21,'adr-system'],[22,587,'staleness-contract'],[588,707,'chunk-store-sqlite'],
  [708,1172,'call-graph-resolution'],[1173,1602,'honest-surfaces'],[1603,2508,'measurement-harness'],
  [2509,5634,'indexing-scale'],[5635,5841,'edges-knee'],[5842,6241,'indexing-scale'],
  [6242,6422,'declined-scope'],[6423,8611,'retrieval-q1'],[8612,9515,'ranker-d'],
  [9516,9762,'vector-store-deletion'],[9763,9880,'ranker-d'],[9881,9992,'vector-store-deletion'],
  [9993,10071,'retrieval-q1'],[10072,10085,'declined-scope'],[10086,10141,'retrieval-q1'],
  [10142,11396,'edges-knee'],[11397,11459,'call-graph-resolution'],
];
const cursors = new Map();
const shard = new Map();
for (const f of new Set(SEGMENTS.map(s => s[2]))) {
  const t = readFileSync(`adr/proposals/${f}/PLAN-EXCERPT.md`, 'utf8');
  shard.set(f, t.replace(/\n$/, '').split('\n'));
  cursors.set(f, 0);
}
const rebuilt = [];
for (const [s, e, f] of SEGMENTS) {
  const n = e - s + 1, c = cursors.get(f);
  rebuilt.push(...shard.get(f).slice(c, c + n));
  cursors.set(f, c + n);
}
for (const [f, c] of cursors) {
  if (c !== shard.get(f).length) throw new Error(`${f}: consumed ${c} of ${shard.get(f).length} lines`);
}
const original = readFileSync('IMPLEMENTATION_PLAN.md', 'utf8');
const out = rebuilt.join('\n') + '\n';
if (out !== original) {
  const a = out.split('\n'), b = original.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if (a[i] !== b[i]) throw new Error(`first divergence at line ${i + 1}:\n  rebuilt: ${JSON.stringify(a[i])}\n  orig:    ${JSON.stringify(b[i])}`);
  throw new Error(`length mismatch ${out.length} vs ${original.length}`);
}
console.log(`INVARIANT HOLDS: shards reassemble to IMPLEMENTATION_PLAN.md byte-for-byte (${original.length} bytes, ${b_len(original)} lines)`);
function b_len(s){ return s.replace(/\n$/,'').split('\n').length; }
