export interface Events { on(name: string): void }
export interface Emitter extends Events {}
export class Emitter {
  constructor(readonly n: number) {}
  emit(): void {}
}
