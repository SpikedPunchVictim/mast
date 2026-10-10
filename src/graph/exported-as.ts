/** The names of an import row's `exported_as`. A malformed value names nothing. */
export function namesExportedAs(exportedAsJson: string | null): readonly string[] {
  if (exportedAsJson === null) return [];
  try {
    const names: unknown = JSON.parse(exportedAsJson);
    return Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : [];
  } catch {
    return [];
  }
}
