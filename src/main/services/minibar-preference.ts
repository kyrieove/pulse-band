export function resolveMiniBarVisibility(value: unknown): boolean {
  return typeof value === 'boolean' ? value : true;
}
