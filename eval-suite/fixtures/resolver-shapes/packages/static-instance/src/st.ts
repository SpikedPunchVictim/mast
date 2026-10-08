export class P {
  static make(): P { return new P(); }
  save(): void {}
}
export class K extends P {
  make(): void {}
  static save(): void {}
  inst(): void { this.save(); }
}
export function f(k: K): void { K.make(); k.save(); }
export async function g(h: <T>(x: T) => Promise<T>): Promise<void> {
  function* gen(): Generator<P> { yield P.make(); }
  void gen; void h;
}
