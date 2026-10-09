#!/usr/bin/env node
// renamed-keys.mjs <baseline card> <new card>
//
// D121 made the scorecard name an end of an edge `key@line` where the key has more than one
// row. `compare` reports a key that left `agree` as lost, and a renamed key is one. This
// lists, for every key that left `agree`, whether the new card has the same key with a line
// on one or both ends in `agree`, and prints the ones that have no such counterpart.
import { readFileSync } from 'node:fs';

const [before, after] = process.argv.slice(2).map((p) => JSON.parse(readFileSync(p, 'utf8')));
const strip = (key) => key.replace(/@\d+/g, '');
let renamed = 0;
const lost = [];
for (const [item, buckets] of Object.entries(before.items)) {
  const now = new Set(after.items[item]?.agree ?? []);
  const nowStripped = new Set([...now].filter((k) => /@\d+/.test(k)).map(strip));
  for (const key of buckets.agree) {
    if (now.has(key)) continue;
    if (nowStripped.has(key)) renamed++;
    else lost.push(`${item}: ${key}`);
  }
}
console.log(`left agree and agree under a key with a line: ${renamed}`);
console.log(`left agree with no such key: ${lost.length}`);
for (const line of lost) console.log(`  ${line}`);
