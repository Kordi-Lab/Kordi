export type ClientDistribution = {
  edition: 'app' | 'research';
  environment: 'staging' | 'production';
  backendOrigin: string;
  displayName: string;
  callbackScheme: string;
  desktopIdentifier: string;
  updates: { enabled: boolean; publicKey: string; artifactName: string };
};

declare const __KORDI_DISTRIBUTION__: ClientDistribution | null;

export function clientDistribution(): ClientDistribution | undefined {
  return typeof __KORDI_DISTRIBUTION__ === 'undefined' ? undefined : __KORDI_DISTRIBUTION__ ?? undefined;
}

export function requiredClientDistribution(): ClientDistribution {
  const distribution = clientDistribution();
  if (!distribution) throw new Error('An ops distribution profile is required for this release.');
  return distribution;
}

/** Development keeps its existing link handling; releases accept only their own origin and scheme. */
export function distributionLinkTarget() {
  const distribution = clientDistribution();
  if (distribution) return { origin: distribution.backendOrigin, scheme: distribution.callbackScheme };
  if (import.meta.env?.DEV) return { origin: 'https://kordi.ai', scheme: 'kordi' };
  throw new Error('An ops distribution profile is required for release links.');
}
