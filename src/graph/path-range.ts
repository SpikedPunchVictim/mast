/**
 * Half-open range bounds for "this path starts with P" queries.
 *
 * The obvious spelling, `path LIKE P || '%'`, is wrong three ways:
 *
 *  - **`_` and `%` inside P act as wildcards.** Paths are not escaped before
 *    interpolation, so `src/my_util.ts` also matches `src/my.util.ts`. With
 *    `ORDER BY path` that returns the wrong row, because `.` (0x2E) sorts
 *    before `_` (0x5F).
 *  - **LIKE is case-insensitive for ASCII.** `case_sensitive_like` is OFF by
 *    default, so `src/Foo.ts` matches `src/FOO.ts` — and `FOO` sorts first.
 *  - **It cannot use the index.** SQLite's LIKE optimization requires either
 *    `case_sensitive_like=ON` or a NOCASE-collated index; `files.path`'s
 *    implicit UNIQUE index is BINARY. The plan degrades to `SCAN files USING
 *    COVERING INDEX sqlite_autoindex_files_1` — the only scan among the
 *    resolver's five lookups (FINDINGS.md §2.3).
 *
 * A half-open range on the BINARY collation fixes all three at once: it is
 * literal, case-sensitive, and a plain two-sided index seek.
 *
 * Exactness: for any suffix S, `P <= P||S < P||U+10FFFF` holds, and any row in
 * `[P, P||U+10FFFF)` must start with P — a row differing from P at some
 * position inside P is either below P or at/above the bound. The single
 * excluded case is a path whose character immediately after P is U+10FFFF, the
 * highest code point, a permanently-unassigned noncharacter that cannot appear
 * in a filename.
 */

/**
 * The exclusive upper bound for paths beginning with `prefix`.
 *
 * Pair with a `>= prefix` lower bound:
 * `.where('path', '>=', p).where('path', '<', pathPrefixUpperBound(p))`.
 *
 * The bound is only ordered correctly under SQLite's BINARY collation, which
 * is `memcmp` over UTF-8. JavaScript's `<` compares UTF-16 code units, under
 * which U+FFFF sorts ABOVE the surrogate pair for U+10FFFF — so this value is
 * for SQL comparison only. Do not use it to filter paths in JS.
 */
export function pathPrefixUpperBound(prefix: string): string {
  return `${prefix}\u{10FFFF}`;
}
