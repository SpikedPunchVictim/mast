// Shared filesystem locations for the N1 bake-off harness.
//
// Everything lives under the session scratchpad — NOT the repo, NOT the default
// Transformers.js node_modules cache. The repo's live `.mast` state dir is never
// touched; the harness builds its own throwaway corpus.

import { join } from 'node:path';

const SCRATCH =
  '/private/tmp/claude-501/-Users-spikedpunchvictim-projects-kluster/c4f25db4-b26f-4eb7-94d3-6a2eef5c6b2c/scratchpad';

/** Transformers.js weight cache — set as env.cacheDir before any pipeline(). */
export const MODEL_CACHE_DIR = join(SCRATCH, 'model-cache');

/** Base state dir: Phase-1 corpus (chunks.lance + graph.db FTS), model-independent. */
export const BASE_STATE_DIR = join(SCRATCH, 'base-state');

/** Per-model state dirs get a vectors.lance embedded by that model. */
export const MODEL_STATES_DIR = join(SCRATCH, 'model-states');

/** Raw results JSON the report is assembled from. */
export const RESULTS_DIR = join(SCRATCH, 'results');

/** The repo whose real chunks form the corpus. */
export const PROJECT_ROOT = '/Users/spikedpunchvictim/projects/kluster';

export function modelStateDir(modelId) {
  return join(MODEL_STATES_DIR, modelId.replace(/\//g, '_'));
}
