import type { Editor, Source, Store } from './types';
import { Merged } from './types';

export function byParam(store: Store, source: Source): void {
  store.get('a');
  store.has?.('a');
  // a property that holds a function: no symbol, no edge
  store.put('a', 'b');
  source.read();
}

export class ByField {
  constructor(private readonly store: Store, private readonly editor: Editor) {}
  run(): void {
    this.store.get('a');
  }
  // The receiver is narrowed to ActiveEditor, whose getModel the compiler has. The
  // stored edge goes to the method of the type the field is written with.
  narrowed(): void {
    if (this.editor.hasModel()) this.editor.getModel();
  }
}

export function merged(m: Merged): void {
  m.both();
  m.added();
}
