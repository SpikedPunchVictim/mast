import { Base } from './base';

export class Child extends Base {
  // overrides the inherited method with a property (common in React/event code)
  handle = (): void => {};
  declare render: () => void;
  constructor(public log: () => void) { super(); }
  go(): void {
    this.handle();
    this.render();
    this.log();
  }
}

export class K {
  static make(): K { return new K(); }
  make(): void {}
  static create(): void { this.make(); }
  inst(): void { this.make(); K.make(); }
}

export class Over {
  m(a: string): void;
  m(a: number): void;
  m(a: unknown): void { void a; }
  get acc(): () => void { return () => {}; }
  set acc(v: () => void) { void v; }
  use(): void { this.m(1); this.acc(); }
}
export function outer(o: Over, c: Child): void { o.m('x'); c.handle(); }
