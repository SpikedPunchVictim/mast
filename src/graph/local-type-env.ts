import type { CallerResolution } from '../ast/types.js';

/**
 * Synchronous heuristic resolver for `POTENTIAL_CALL` edges (§10.3.1).
 *
 * Built up per function/method scope during the AST walk, then queried for
 * each call site. It resolves a call's receiver to a callee *symbol name* using
 * a small set of high-frequency, statically-decidable patterns. It does NOT
 * touch the database — whether the resolved name corresponds to a real indexed
 * symbol is decided later, in `insertEdges`' name→id resolution (an unknown
 * name simply yields no edge).
 *
 * Intentionally conservative: false negatives (missed edges) are acceptable;
 * false positives (wrong edges) are not, as they would poison the
 * `verified_callers` contract in `mast_callers`.
 */
export class LocalTypeEnvironment {
  /** Named imports and same-file top-level symbols, by bare name. */
  private readonly bareCallables = new Map<string, CallerResolution>();
  /** Receiver expression (`repo`, `this.repo`) → its resolved type name. */
  private readonly receiverTypes = new Map<string, { type: string; resolution: CallerResolution }>();

  /** `import { handleLogin } from './h'` → bare call `handleLogin()` resolves. */
  recordImport(localName: string): void {
    if (!this.bareCallables.has(localName)) this.bareCallables.set(localName, 'import');
  }

  /** A top-level function/const in the same file → bare call resolves to it. */
  recordSameFileSymbol(name: string): void {
    if (!this.bareCallables.has(name)) this.bareCallables.set(name, 'same_file');
  }

  /**
   * A typed receiver binding. `receiver` is the literal receiver expression as
   * it appears before the method call — e.g. `repo` (local/param) or
   * `this.repo` (class field / constructor parameter property).
   */
  recordReceiverType(receiver: string, type: string, resolution: CallerResolution): void {
    if (!this.receiverTypes.has(receiver)) this.receiverTypes.set(receiver, { type, resolution });
  }

  /**
   * Resolve a call to `{ callee, resolution }`, or null when the receiver
   * cannot be statically linked.
   *
   * @param receiver - the receiver expression (`repo`, `this.repo`), or null
   *   for a bare call (`foo()`).
   * @param method - the called identifier (the function name for a bare call,
   *   the member name for a receiver call).
   */
  resolveCall(receiver: string | null, method: string): { callee: string; resolution: CallerResolution } | null {
    if (receiver === null) {
      const resolution = this.bareCallables.get(method);
      return resolution === undefined ? null : { callee: method, resolution };
    }
    const binding = this.receiverTypes.get(receiver);
    if (binding === undefined) return null;
    return { callee: `${binding.type}.${method}`, resolution: binding.resolution };
  }
}
