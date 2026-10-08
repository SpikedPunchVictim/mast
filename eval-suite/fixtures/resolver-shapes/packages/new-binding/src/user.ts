import { A, B, Repo } from './lib';

export function twoBlocks(kind: string): void {
  if (kind === 'a') {
    const c = new A();
    void c;
  } else {
    const c = new B();
    c.run();
  }
}

export function twoCallbacks(items: any[]): void {
  items.forEach(() => { const r = new Repo(); void r; });
  items.forEach((x) => { const r = x.other; r.save(); });
}

export function switchCases(kind: string): void {
  switch (kind) {
    case 'a': { const h = new A(); void h; break; }
    default: { const h = new B(); h.run(); }
  }
}
