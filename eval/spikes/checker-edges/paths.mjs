// Shared filesystem locations for the checker-edges spike (Stage 1.1, Feature 1,
// IMPLEMENTATION_PLAN_VEXP.md). Throwaway — never imported by src/.

import { join } from 'node:path';

// Reused verbatim from the centrality spike (Stage 3.1) per the task brief:
// "graph.db + chunks.lance, built 2026-07-15, 12,989 chunks, 0 parse errors."
// This belongs to a different Claude session's scratchpad; it is opened
// READ-ONLY here and never written to. If this path is ever absent, rebuild
// via `pnpm -F @kluster/mast build && node packages/mast/eval/build-corpus.mjs`
// and update this constant.
export const BASE_STATE_DIR =
  '/private/tmp/claude-501/-Users-spikedpunchvictim-projects-kluster/c4f25db4-b26f-4eb7-94d3-6a2eef5c6b2c/scratchpad/base-state';

/** The repo whose real chunks form the corpus (and whose files the checker parses). */
export const PROJECT_ROOT = '/Users/spikedpunchvictim/projects/kluster';

/** This spike's own output directory (results.json, REPORT.md). */
export const SPIKE_DIR = join(PROJECT_ROOT, 'packages/mast/eval/spikes/checker-edges');

export const RESULTS_FILE = join(SPIKE_DIR, 'results.json');
