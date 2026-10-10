export function css(strings: TemplateStringsArray, ...values: unknown[]): string { return strings.join(String(values.length)); }
export const html = (strings: TemplateStringsArray): string => strings.join('');
