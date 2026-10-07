import { createLogger } from '@fx/core';
import type { Handler } from './handler.js';
import { FileStore } from './stores.js';

export class Main implements Handler {
  run(): void {
    createLogger();
    this.read(new FileStore());
  }

  read(store: FileStore): string | undefined {
    return store.get('key');
  }
}
