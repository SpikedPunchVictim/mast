/**
 * Single source of truth for all environment variables read by MAST.
 *
 * Two schemas are provided — one for each process boundary:
 *   - `ConfigEnvSchema`  used by the main process in `store/config.ts`
 *   - `WorkerEnvSchema`  used by the background embedder worker entry block
 *
 * Nothing below the process entry point should call `process.env` directly.
 */
import { z } from 'zod';

/** Environment variables relevant to the main CLI / MCP server process. */
export const ConfigEnvSchema = z.object({
  /** Override for the state directory path. Falls back to config file then default. */
  MAST_STATE_DIR: z.string().min(1).optional(),
});

export type ConfigEnv = z.infer<typeof ConfigEnvSchema>;

/** Environment variables required by the background embedder worker process. */
export const WorkerEnvSchema = z.object({
  /** Absolute path to the MAST state directory. Required in the worker. */
  MAST_STATE_DIR: z.string().min(1, 'MAST_STATE_DIR must be a non-empty path'),
  /** HuggingFace model ID to use for embedding. */
  MAST_MODEL_ID: z.string().min(1).default('jinaai/jina-embeddings-v2-base-code'),
  /** Absolute path for the Transformers.js model weight cache. Required in the worker. */
  MAST_TRANSFORMERS_CACHE: z.string().min(1, 'MAST_TRANSFORMERS_CACHE must be a non-empty path'),
});

export type WorkerEnv = z.infer<typeof WorkerEnvSchema>;
