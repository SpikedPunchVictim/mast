// Shared filesystem locations for the MAST eval harness.
//
// Everything lives under a STABLE cache dir — not the repo, not a session
// scratchpad, not the default Transformers.js node_modules cache. The repo's
// live `.mast` state dir is never touched; the harness builds its own corpus.
//
// D2 (2026-08-01): this file previously pinned SCRATCH to session directory
// `c4f25db4-…`, which no longer exists — `model-cache/` and `model-states/`
// went with it, so no historical run could be reproduced or compared against.
// Session scratchpads are per-session by construction and can never host a
// regression baseline. Hence a stable, boring path under ~/.cache.

import { join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = join(homedir(), '.cache', 'mast-eval');

/** Transformers.js weight cache — set as env.cacheDir before any pipeline(). */
export const MODEL_CACHE_DIR = join(ROOT, 'model-cache');

/**
 * Base state dir: Phase-1 corpus (SQLite chunks + graph.db FTS), model-independent.
 *
 * Overridable via MAST_EVAL_STATE so a re-registered experiment (Q1-r2) can build
 * a fresh corpus without destroying the prior run's state — the void v1 numbers
 * stay reproducible alongside the replacement.
 */
export const BASE_STATE_DIR = process.env.MAST_EVAL_STATE ?? join(ROOT, 'base-state');

/** Per-model state dirs get a vectors.lance embedded by that model. */
export const MODEL_STATES_DIR = join(ROOT, 'model-states');

/** Raw results JSON the report is assembled from. */
export const RESULTS_DIR = join(ROOT, 'results');

/**
 * The repo whose real chunks form the corpus — a PINNED git worktree, not the
 * live tree.
 *
 * Why pinned: `chunk_id` is `sha256(file_path + ":" + start_line)`
 * (`ast/types.ts:28`), so ids break on *line drift* — any edit that shifts a
 * declaration's start line. Pointing at the live, drifting repo (the prior
 * behaviour) silently invalidated every frozen gold target and made
 * cross-time comparison meaningless. See GITNEXUS_COMPARISON.md §14.2.
 *
 * Create with:
 *   git worktree add --detach ~/.cache/mast-eval/corpus-kluster <CORPUS_SHA>
 */
export const PROJECT_ROOT = join(ROOT, 'corpus-kluster');

/**
 * The commit the corpus is pinned at. Stamped into every result JSON so a
 * score can never be silently compared against a differently-pinned run.
 */
export const CORPUS_SHA = '07d705b354e256d3175594f959f945d92cfc116d';

export function modelStateDir(modelId) {
  return join(MODEL_STATES_DIR, modelId.replace(/\//g, '_'));
}
