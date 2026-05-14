import type { Db } from './db.js';

/**
 * Heuristic resolver for `POTENTIAL_CALL` edges.
 *
 * Attempts to statically link a call-site receiver to a known indexed symbol
 * using a small set of high-frequency patterns (§10.3.1). Returns null when
 * the receiver cannot be resolved — callers treat unresolved sites as
 * `potential_matches` via `identifier_fts` rather than as verified edges.
 *
 * This is intentionally conservative: false negatives (missed edges) are
 * acceptable; false positives (wrong edges) are not, as they would poison
 * the `verified_callers` contract in `mast_callers`.
 */
export class LocalTypeEnvironment {
  /**
   * Map of local name → resolved symbol name.
   * Populated incrementally as the AST walk processes declarations.
   */
  private readonly bindings = new Map<string, string>();

  constructor(private readonly db: Db, private readonly filePath: string) {}

  /**
   * Record a named import binding.
   *   `import { handleLogin } from './handler'`
   * → `'handleLogin'` resolves to itself (same name, known import).
   */
  recordNamedImport(localName: string, importedName: string): void {
    this.bindings.set(localName, importedName);
  }

  /**
   * Record a class field with a known type annotation.
   *   `private userRepo: UserRepository`
   * → calls on `this.userRepo.method()` resolve via `UserRepository.method`.
   */
  recordField(fieldName: string, typeName: string): void {
    this.bindings.set(`this.${fieldName}`, typeName);
  }

  /**
   * Record a `new` expression binding.
   *   `const repo = new UserRepository()`
   * → `repo` resolves to type `UserRepository`.
   */
  recordNewExpression(localName: string, className: string): void {
    this.bindings.set(localName, className);
  }

  /**
   * Try to resolve a call expression receiver to a known symbol name.
   *
   * Returns `{ resolvedSymbol, resolution }` when the receiver can be
   * statically linked, or `null` when it cannot. Callers use the returned
   * symbol to look up the callee's `symbols` row for edge insertion.
   */
  async resolve(
    receiverExpr: string,
    methodName: string,
  ): Promise<{ resolvedSymbol: string; resolution: string } | null> {
    // Pattern 1: top-level named import — direct function call.
    const directBinding = this.bindings.get(receiverExpr);
    if (directBinding !== undefined) {
      return { resolvedSymbol: directBinding, resolution: 'import' };
    }

    // Pattern 2: `this.field.method()` — resolve via field type annotation.
    if (receiverExpr.startsWith('this.')) {
      const fieldKey = receiverExpr; // e.g. 'this.userRepo'
      const typeName = this.bindings.get(fieldKey);
      if (typeName !== undefined) {
        const qualifiedName = `${typeName}.${methodName}`;
        const exists = await this.symbolExists(qualifiedName);
        if (exists) return { resolvedSymbol: qualifiedName, resolution: 'field_type' };
      }
    }

    // Pattern 3: same-file function call — receiver is undefined, methodName
    // is the callee.
    const sameFileSymbol = await this.db
      .selectFrom('symbols as s')
      .innerJoin('files as f', 'f.id', 's.file_id')
      .select('s.name')
      .where('s.name', '=', methodName)
      .where('f.path', '=', this.filePath)
      .executeTakeFirst();

    if (sameFileSymbol !== undefined) {
      return { resolvedSymbol: sameFileSymbol.name, resolution: 'same_file' };
    }

    return null;
  }

  private async symbolExists(name: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('symbols')
      .select('id')
      .where('name', '=', name)
      .executeTakeFirst();
    return row !== undefined;
  }
}
