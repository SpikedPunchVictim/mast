// Q1 — Baseline verified:potential ratio (Stage 1.1, IMPLEMENTATION_PLAN_VEXP.md).
//
// (a) Total POTENTIAL_CALL edges grouped by resolution.
// (b) Top-50 most-called exported symbols (rank by incoming POTENTIAL_CALL
//     edge count, ties broken by name then file_path then id for full
//     determinism), each symbol's potential-match count computed via the
//     shipped semantics (lib.mjs:computePotentialMatches — identifier_fts
//     exact-identifier hits minus chunks already covered by a verified edge
//     FOR THAT SYMBOL). Aggregate verified:potential ratio across the 50.
//
//   node eval/spikes/checker-edges/q1-baseline.mjs

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_STATE_DIR, SPIKE_DIR } from './paths.mjs';
import { openReadOnlyDb, openLanceReadOnly, computePotentialMatches, queryVerifiedCallers } from './lib.mjs';

const db = openReadOnlyDb(BASE_STATE_DIR);
const lance = await openLanceReadOnly(BASE_STATE_DIR);

// --- (a) edges by resolution ---
const byResolution = await db
  .selectFrom('edges')
  .select(['resolution'])
  .select((eb) => eb.fn.countAll().as('count'))
  .where('edge_type', '=', 'POTENTIAL_CALL')
  .groupBy('resolution')
  .execute();

const totalPotentialCallEdges = byResolution.reduce((sum, r) => sum + Number(r.count), 0);

// --- (b) top-50 most-called exported symbols ---
// Incoming POTENTIAL_CALL edge count per symbol, exported symbols only,
// excluding barrel marker rows (kind='export', §10.1 — no real declaration).
const callCounts = await db
  .selectFrom('edges as e')
  .innerJoin('symbols as s', 's.id', 'e.to_id')
  .innerJoin('files as f', 'f.id', 's.file_id')
  .select(['s.id', 's.name', 'f.path as file_path', 's.line'])
  .select((eb) => eb.fn.countAll().as('incoming_count'))
  .where('e.edge_type', '=', 'POTENTIAL_CALL')
  .where('s.is_exported', '=', 1)
  .where('s.kind', '!=', 'export')
  .groupBy(['s.id', 's.name', 'f.path', 's.line'])
  .execute();

callCounts.sort((a, b) => {
  const ca = Number(a.incoming_count), cb = Number(b.incoming_count);
  if (cb !== ca) return cb - ca;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.file_path !== b.file_path) return a.file_path < b.file_path ? -1 : 1;
  return a.id - b.id;
});

const top50 = callCounts.slice(0, 50);

const perSymbol = [];
let potentialPool = []; // flattened for Q3's sampling frame
for (const sym of top50) {
  const verifiedRows = await queryVerifiedCallers(db, sym.id, false);
  const potential = await computePotentialMatches(db, lance, sym.name, verifiedRows);
  perSymbol.push({
    symbol_id: sym.id,
    name: sym.name,
    file_path: sym.file_path,
    line: sym.line,
    verified_count: Number(sym.incoming_count),
    potential_count: potential.length,
  });
  for (const p of potential) {
    // Field order matters: `p` (call-site chunk data) is spread AFTER the
    // queried-symbol fields on purpose, and `p`'s own key is `chunk_symbol_name`
    // (not `symbol_name`) specifically so it cannot silently clobber the
    // queried symbol's name — a bug caught during this spike's authoring.
    potentialPool.push({
      queried_symbol_id: sym.id,
      queried_symbol_name: sym.name,
      queried_symbol_file_path: sym.file_path,
      queried_symbol_line: sym.line,
      ...p,
    });
  }
}

const verifiedSum = perSymbol.reduce((s, r) => s + r.verified_count, 0);
const potentialSum = perSymbol.reduce((s, r) => s + r.potential_count, 0);

const result = {
  methodology: {
    a: "SELECT resolution, COUNT(*) FROM edges WHERE edge_type='POTENTIAL_CALL' GROUP BY resolution",
    b: 'Top 50 exported symbols by incoming POTENTIAL_CALL count (kind!=export). ' +
       'Ties: name asc, then file_path asc, then id asc (deterministic). ' +
       'Per symbol: verified_count = incoming POTENTIAL_CALL edges (direct, non-transitive, ' +
       'same as mast_callers default). potential_count = shipped collectPotentialMatches ' +
       'semantics (src/mcp/tools/_helpers.ts): identifier_fts exact-phrase match on the ' +
       'symbol name (limit 50), chunks fetched from chunks.lance, minus chunks whose ' +
       '(file_path,start_line) equals a verified caller (file_path,line) for this symbol.',
    ratio: 'aggregate verified:potential = sum(verified_count) : sum(potential_count) across the 50',
  },
  state_dir: BASE_STATE_DIR,
  a_edges_by_resolution: Object.fromEntries(byResolution.map((r) => [r.resolution ?? 'null', Number(r.count)])),
  a_total_potential_call_edges: totalPotentialCallEdges,
  b_top50_symbols: perSymbol,
  b_aggregate: {
    verified_sum: verifiedSum,
    potential_sum: potentialSum,
    ratio_verified_per_potential: potentialSum > 0 ? +(verifiedSum / potentialSum).toFixed(4) : null,
    ratio_string: `${verifiedSum}:${potentialSum}`,
  },
};

writeFileSync(join(SPIKE_DIR, 'q1-results.json'), JSON.stringify(result, null, 2));
writeFileSync(join(SPIKE_DIR, 'q1-potential-pool.json'), JSON.stringify(potentialPool, null, 2));
console.log(JSON.stringify({
  a_total_potential_call_edges: totalPotentialCallEdges,
  a_edges_by_resolution: result.a_edges_by_resolution,
  b_aggregate: result.b_aggregate,
  pool_size: potentialPool.length,
}, null, 2));

await db.destroy();
