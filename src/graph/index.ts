// Public graph/query surface — exported for programmatic consumers (e.g. foldv2's reconcile adapter)
// so they don't go through the MCP server or the CLI. The queries take an open `Db` (openDatabase).
export * from "./db.js";
export * from "./queries.js";
export type { DependencyEntry, ImplementorResult } from "../ast/types.js";
