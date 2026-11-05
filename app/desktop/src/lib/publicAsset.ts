/** Public files follow the compiled app base, including a hosted /app/ build. */
export function publicAssetPath(relative: string): string {
  const base = import.meta.env?.BASE_URL ?? '/';
  return `${base}${relative.replace(/^\/+/, '')}`;
}
