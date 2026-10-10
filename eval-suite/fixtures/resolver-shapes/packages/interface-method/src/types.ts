export interface Store {
  get(key: string): string;
  has?(key: string): boolean;
  put: (key: string, value: string) => void;
  // an accessor is stored as a method is, once for the pair
  get size(): number;
  set size(value: number);
}

export interface Readable {
  read(): string;
}
export interface Source extends Readable {}

export interface Editor {
  hasModel(): this is ActiveEditor;
  getModel(): string | null;
}
export interface ActiveEditor extends Editor {
  getModel(): string;
}

export class Merged {
  both(): void {}
}
export interface Merged {
  both(): void;
  added(): void;
}
