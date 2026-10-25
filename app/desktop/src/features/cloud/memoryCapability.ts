/** Memory route version a server advertises, or null when it offers none. */
export function memoryVersionFromCapabilities(capabilities: { memoryVersion?: number } | null | undefined): number | null {
  const version = capabilities?.memoryVersion;
  return typeof version === 'number' && version > 0 ? version : null;
}

/** Version 2 files memories by category to Grounding profiles; card pages list them. */
export function memoryRoutingAvailable(capabilities: { memoryVersion?: number } | null | undefined): boolean {
  return (memoryVersionFromCapabilities(capabilities) ?? 0) >= 2;
}

/** Version 3 lets a memory feed several Grounding cards; card pages add and remove them. */
export function memoryCardsSupported(capabilities: { memoryVersion?: number } | null | undefined): boolean {
  return (memoryVersionFromCapabilities(capabilities) ?? 0) >= 3;
}
