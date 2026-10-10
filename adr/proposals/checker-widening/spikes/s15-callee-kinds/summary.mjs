#!/usr/bin/env node
/**
 * One table from the per-corpus results of `callee-kinds.mjs`:
 *
 *   node summary.mjs <result.json> [<result.json> ...]
 *
 * Sites and distinct callees per group, and the share of the calls whose callee is in the
 * corpus. The groups marked "no row" are the kinds `fixture.out.txt` shows mast stores no
 * symbol for; the fixture has no case for the kinds left in "other".
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const GROUPS = [
  ['a method of an interface (no row)', ['a method of an interface']],
  ['a property of an interface with a function type (no row)', ['a property of an interface with a function type']],
  ['a member of a type literal (no row for the method)', ['a method of a type literal', 'a property of a type literal with a function type']],
  ['a function or constant in a TypeScript namespace (no row)', ['a function, in a TypeScript namespace', 'a constant holding a function, in a TypeScript namespace']],
  ['a member of an object literal (no row)', ['a method of an object literal', 'a property of an object literal holding a function']],
  ['a class property holding a function (no row)', ['a class property holding a function']],
  ['a class method, static or abstract included (row)', ['a method', 'a static method', 'an abstract method']],
  ['a function or constant at the top of its file (row)', ['a function, at the top of its file', 'a constant holding a function, at the top of its file']],
];
for (const path of process.argv.slice(2)) {
  const r = JSON.parse(readFileSync(path, 'utf8'));
  const inCorpus = r.totals['callee in the corpus'];
  console.log(`\n${basename(path)}: ${r.corpus_files_read} files, ${r.totals['call expressions']} call expressions, ${inCorpus} with the callee in the corpus,`);
  console.log(`  ${r.totals['callee outside the corpus'] ?? 0} outside it, ${r.totals['no declaration: the callee has no type here, or the type has no signature'] ?? 0} with no declaration`);
  let grouped = 0;
  for (const [label, kinds] of GROUPS) {
    const sites = kinds.reduce((n, k) => n + (r.sites_by_callee_kind[k] ?? 0), 0);
    const callees = kinds.reduce((n, k) => n + (r.distinct_callees_by_kind[k] ?? 0), 0);
    grouped += sites;
    console.log(`  ${String(sites).padStart(7)} sites ${(100 * sites / inCorpus).toFixed(1).padStart(5)}%  ${String(callees).padStart(6)} callees  ${label}`);
  }
  console.log(`  ${String(inCorpus - grouped).padStart(7)} sites ${(100 * (inCorpus - grouped) / inCorpus).toFixed(1).padStart(5)}%                  other kinds`);
  for (const [k, v] of Object.entries(r.interface_sites_by_implementors)) if (k.startsWith('a method of an interface')) console.log(`          ${String(v).padStart(7)}  ${k}`);
}
