function format(message: string): string {
  return `[log] ${message}`;
}

export function createLogger(): string {
  return format('ready');
}
