/**
 * The scope a `mast_search` call is restricted to — `file_pattern` and
 * `language` — compiled once and applied identically by every ranker.
 *
 * This module exists because the two filters used to be implemented in exactly
 * one of the two rankers `fusedSearch` unions together: `searchFts` pushed
 * them into SQL, `searchRankerD` applied none, and RRF then merged D's
 * unscoped declaration hits into a scoped result set. That is this package's
 * severity-zero shape (`docs/defects/LEDGER.md`) reached through the filter a
 * caller supplied precisely to be sure of the answer's boundaries — so scope
 * is defined here, once, rather than at each ranker's own SQL.
 *
 * Glob semantics come from {@link globToRegex}, the walker's own translation —
 * the same function `mast_project_skeleton` already uses for its `file_pattern`
 * and the same one that decides which files get indexed at all. A pattern
 * therefore selects the same files at query time as it does at index time,
 * which was not true of the SQL `LIKE` translation this replaces: under `LIKE`,
 * `*` crossed `/`, a literal `_` acted as a single-character wildcard, and
 * matching was case-insensitive against a case-sensitive index (the same three
 * faults recorded in `docs/defects/D004-like-prefix-match.md`, whose four-site
 * sweep did not reach here).
 */

import { globToRegex } from '../indexer/walker.js';
import type { Db } from '../graph/db.js';

/**
 * The SQL-level filters `SearchInput` carries, in this module's own naming.
 *
 * `undefined` is spelled out alongside `null` because `exactOptionalPropertyTypes`
 * is on: callers forward `SearchInput.file_pattern` (itself `string | null |
 * undefined`) straight through, and an optional-only property would reject the
 * explicit `undefined` that forwarding produces.
 */
export interface SearchScope {
  readonly filePattern?: string | null | undefined;
  readonly language?: string | null | undefined;
}

/** Predicate over one indexed row's `(file_path, language)` pair. */
export type ScopeMatcher = (filePath: string, language: string) => boolean;

/**
 * Compile a scope into a single predicate, or `null` when the scope restricts
 * nothing — callers branch on `null` to skip filtering entirely rather than
 * running an always-true predicate over every candidate.
 *
 * The `RegExp` is built once here, not per row: `globToRegex` compiles a
 * pattern, and doing that inside a filter callback would recompile it for
 * every chunk in the candidate pool.
 */
export function compileScopeMatcher(scope: SearchScope): ScopeMatcher | null {
  const pattern = scope.filePattern ?? null;
  const language = scope.language ?? null;
  if (pattern === null && language === null) return null;

  const rx = pattern === null ? null : globToRegex(pattern);
  return (filePath, rowLanguage) => {
    if (rx !== null && !rx.test(filePath)) return false;
    if (language !== null && rowLanguage !== language) return false;
    return true;
  };
}

/**
 * The indexed paths inside `scope`, or `null` when the scope restricts nothing.
 *
 * Used by the callers that can only filter by path — FTS5 (whose `MATCH` query
 * applies its `LIMIT` in SQL, so the restriction has to be an `IN` list rather
 * than a post-filter) and the zero-result assist (two of whose three passes
 * return only a symbol and a file). An empty array is a real answer, not an
 * absent one: the scope matched no indexed file, so the search has nothing to
 * return.
 *
 * `files` is scanned in full rather than filtered in SQL because the glob is
 * not expressible as a SQL predicate without reintroducing `LIKE`. The table
 * holds one row per indexed file, and the query it replaced —
 * `path LIKE ?` against a `BINARY` index with `case_sensitive_like` OFF —
 * could not use the index either (`graph/path-range.ts`), so this is not a
 * plan regression.
 */
export async function resolveScopedPaths(db: Db, scope: SearchScope): Promise<string[] | null> {
  const matcher = compileScopeMatcher(scope);
  if (matcher === null) return null;

  const rows = await db.selectFrom('files').select(['path', 'language']).execute();
  return rows.filter((r) => matcher(r.path, r.language)).map((r) => r.path);
}
