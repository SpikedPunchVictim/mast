// Stage 3.1 spike — PageRank probe (second knob, run ONLY if in-degree fails
// the gate AND per-query deltas suggest hub-bias is the specific problem —
// see IMPLEMENTATION_PLAN_VEXP.md Feature 3 Stage 3.1 step 5 / §R reserve
// table: "In-degree fails the Stage 3.1 gate but per-query deltas suggest
// hub-bias is the fixable problem." Do not tune both knobs at once.
//
// Standard power-iteration PageRank, damping 0.85, over the same edge set as
// in-degree centrality (POTENTIAL_CALL, IMPLEMENTS), directed from_id -> to_id.
// Dangling nodes (no outgoing edges of the counted types) redistribute their
// rank mass uniformly — the standard fix for a well-formed stochastic matrix.

import Sqlite from 'better-sqlite3';
import { join } from 'node:path';
import { chunkKey } from './centrality.mjs';

const CENTRALITY_EDGE_TYPES = ['POTENTIAL_CALL', 'IMPLEMENTS'];
const DAMPING = 0.85;
const MAX_ITERATIONS = 100;
const CONVERGENCE_EPSILON = 1e-8;

/**
 * Compute PageRank per (file_path, symbol_name) key over the same directed
 * edge set as `computeInDegreeCentrality`.
 *
 * @param {string} stateDir directory containing graph.db
 * @returns {{ centrality: Map<string, number>, iterations: number, symbolCount: number }}
 */
export function computePageRank(stateDir) {
  const db = new Sqlite(join(stateDir, 'graph.db'), { readonly: true });
  try {
    const placeholders = CENTRALITY_EDGE_TYPES.map(() => '?').join(', ');

    const symbolRows = db
      .prepare(
        `SELECT s.id, f.path AS file_path, s.name AS symbol_name
         FROM symbols s JOIN files f ON f.id = s.file_id`,
      )
      .all();
    const idToKey = new Map(symbolRows.map((r) => [r.id, chunkKey(r.file_path, r.symbol_name)]));
    const ids = symbolRows.map((r) => r.id);
    const idIndex = new Map(ids.map((id, i) => [id, i]));
    const n = ids.length;

    const edgeRows = db
      .prepare(`SELECT from_id, to_id FROM edges WHERE edge_type IN (${placeholders})`)
      .all(...CENTRALITY_EDGE_TYPES);

    // Adjacency as out-edges per node index (only edges between known symbols).
    const outEdges = Array.from({ length: n }, () => []);
    for (const e of edgeRows) {
      const fromIdx = idIndex.get(e.from_id);
      const toIdx = idIndex.get(e.to_id);
      if (fromIdx === undefined || toIdx === undefined) continue;
      outEdges[fromIdx].push(toIdx);
    }
    const outDegree = outEdges.map((e) => e.length);

    let rank = new Float64Array(n).fill(1 / n);
    let iterations = 0;
    for (; iterations < MAX_ITERATIONS; iterations++) {
      const next = new Float64Array(n).fill((1 - DAMPING) / n);

      // Dangling mass (nodes with no counted out-edges) redistributes uniformly.
      let danglingMass = 0;
      for (let i = 0; i < n; i++) {
        if (outDegree[i] === 0) danglingMass += rank[i];
      }
      const danglingShare = (DAMPING * danglingMass) / n;
      for (let i = 0; i < n; i++) next[i] += danglingShare;

      for (let i = 0; i < n; i++) {
        if (outDegree[i] === 0) continue;
        const share = (DAMPING * rank[i]) / outDegree[i];
        for (const j of outEdges[i]) next[j] += share;
      }

      let delta = 0;
      for (let i = 0; i < n; i++) delta += Math.abs(next[i] - rank[i]);
      rank = next;
      if (delta < CONVERGENCE_EPSILON) { iterations++; break; }
    }

    const centrality = new Map();
    for (let i = 0; i < n; i++) {
      const key = idToKey.get(ids[i]);
      centrality.set(key, (centrality.get(key) ?? 0) + rank[i]);
    }

    return { centrality, iterations, symbolCount: n };
  } finally {
    db.close();
  }
}
