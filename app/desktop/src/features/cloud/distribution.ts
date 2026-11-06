import { isBrowserAppRuntime } from '@web/auth/browserAppRuntime';

export type ClientDistribution = {
  loginPage?: { title: string; subtitle: string; signupTitle: string; signupSubtitle: string };
  backendOrigin: string;
  callbackScheme: string;
  updates: { enabled: boolean; artifactName: string };
};

declare const __KORDI_DISTRIBUTION__: ClientDistribution | null;

export function clientDistribution(): ClientDistribution | undefined {
  return typeof __KORDI_DISTRIBUTION__ === 'undefined' ? undefined : __KORDI_DISTRIBUTION__ ?? undefined;
}

export function requiredClientDistribution(): ClientDistribution {
  const distribution = clientDistribution();
  if (!distribution) throw new Error('A distribution profile is required.');
  return distribution;
}

/** Development keeps its existing link handling; releases accept only their own origin and scheme. */
export function distributionLinkTarget() {
  if (isBrowserAppRuntime()) return { origin: window.location.origin, scheme: 'kordi' };
  const distribution = clientDistribution();
  if (distribution) return { origin: distribution.backendOrigin, scheme: distribution.callbackScheme };
  if (import.meta.env?.DEV) return { origin: 'https://kordi.ai', scheme: 'kordi' };
  throw new Error('A distribution profile is required.');
}
