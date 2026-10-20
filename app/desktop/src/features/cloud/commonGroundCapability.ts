/** Common ground route version a server advertises, or null when it offers none. */
export function commonGroundVersionFromCapabilities(capabilities: { commonGroundVersion?: number | null } | null | undefined): number | null {
  const version = capabilities?.commonGroundVersion;
  return typeof version === 'number' && version > 0 ? version : null;
}
