export function leaf(): void {}
export class K {
  static make(): K { leaf(); return new K(); }
  make(): void {}
}
export type Handler = (x: number) => void;
export const Handler = (x: number): void => { void x; leaf(); };
