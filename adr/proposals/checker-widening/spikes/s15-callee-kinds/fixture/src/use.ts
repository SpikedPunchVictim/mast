import { Base, Geo, Impl, plain, tools, top, type Reader, type Store } from './lib.js';

export function caller(store: Store, reader: Reader, base: Base, impl: Impl): void {
  Geo.area(1, 2);
  Geo.twice(1);
  Geo.Inner.deep();
  store.get('a');
  store.put('a', 'b');
  reader.read();
  base.run();
  impl.get('a');
  impl.put('a', 'b');
  tools.sum(1, 2);
  tools.neg(1);
  plain(1);
  top();
}
