import { UserError } from '@fx/core';

export class NotFoundError extends UserError {
  status(): number {
    return 404;
  }
}

// Same name as core's BaseError, and unrelated to it.
export class BaseError {
  describe(): string {
    return 'app';
  }
}
