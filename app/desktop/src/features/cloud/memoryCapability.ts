/** Memory route version a server advertises, or null when it offers none. */
export function memoryVersionFromCapabilities(capabilities: { memoryVersion?: number } | null | undefined): number | null {
  const version = capabilities?.memoryVersion;
  return typeof version === 'number' && version > 0 ? version : null;
}
