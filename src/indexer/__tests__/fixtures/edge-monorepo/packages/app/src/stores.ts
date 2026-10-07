import type { Store } from '@fx/core';

export class FileStore implements Store {
  get(key: string): string | undefined {
    return key;
  }
}

export class CacheStore implements Store {
  get(key: string): string | undefined {
    return key.length > 0 ? undefined : key;
  }
}
