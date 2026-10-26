/** Common ground route version a server advertises, or null when it offers none. */
export function commonGroundVersionFromCapabilities(capabilities: { commonGroundVersion?: number | null } | null | undefined): number | null {
  const version = capabilities?.commonGroundVersion;
  return typeof version === 'number' && version > 0 ? version : null;
}

/** Nearby people route version (`commonGroundNearbyVersion`), counted only beside `commonGroundVersion`. */
export function commonGroundNearbyVersionFromCapabilities(
  capabilities: { commonGroundVersion?: number | null; commonGroundNearbyVersion?: number | null } | null | undefined,
): number | null {
  if (commonGroundVersionFromCapabilities(capabilities) === null) return null;
  const version = capabilities?.commonGroundNearbyVersion;
  return typeof version === 'number' && version > 0 ? version : null;
}
