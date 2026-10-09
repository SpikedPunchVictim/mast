export async function viaArrow(): Promise<void> {
  const { go, named } = await import('./arrow');
  go();
  named();
}
