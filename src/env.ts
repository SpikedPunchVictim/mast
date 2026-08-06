/**
 * Single source of truth for all environment variables read by MAST.
 *
 * `ConfigEnvSchema` is used by the main process in `store/config.ts`. The
 * background embedder worker's `WorkerEnvSchema` was removed in Stage 7.1
 * (IMPLEMENTATION_PLAN.md "Stage 7: Vector-store deletion") along with the
 * worker process it configured.
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
