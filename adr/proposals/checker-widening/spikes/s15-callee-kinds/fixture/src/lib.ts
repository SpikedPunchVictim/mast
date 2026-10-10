export namespace Geo {
  export function area(w: number, h: number): number {
    return w * h;
  }
  export const twice = (n: number): number => n * 2;
  export namespace Inner {
    export function deep(): number {
      return 1;
    }
  }
}

export interface Store {
  get(key: string): string;
  put: (key: string, value: string) => void;
}

export type Reader = {
  read(): string;
};

export abstract class Base {
  abstract run(): number;
  go(): number {
    return this.run();
  }
}

export class Impl extends Base implements Store {
  run(): number {
    return 1;
  }
  get(key: string): string {
    return key;
  }
  put = (key: string, value: string): void => {
    void key;
    void value;
  };
}

export const tools = {
  sum(a: number, b: number): number {
    return a + b;
  },
  neg: (a: number): number => -a,
};

export const plain = (n: number): number => n;
export function top(): number {
  return 0;
}
