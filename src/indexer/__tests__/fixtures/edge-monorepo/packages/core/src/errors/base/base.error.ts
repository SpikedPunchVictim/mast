export class BaseError extends Error {
  describe(): string {
    return this.message;
  }
}
