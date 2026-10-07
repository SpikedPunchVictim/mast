import { BaseError } from './base.error.js';

export class UserError extends BaseError {
  hint(): string {
    return super.describe();
  }
}
