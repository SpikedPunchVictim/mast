import type { Store } from './ports.js';

export class MemoryStore implements Store {
  get(key: string): string | undefined {
    return key;
  }
}
