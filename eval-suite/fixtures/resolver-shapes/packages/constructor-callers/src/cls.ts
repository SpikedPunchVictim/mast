import { target } from './lib';
export class WithCtor {
  private v = target();
  constructor() { void this.v; }
}
export class NoCtor {
  private v = target();
}
