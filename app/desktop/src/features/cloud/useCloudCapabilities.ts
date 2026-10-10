import { useEffect, useState } from 'react';

import type { CloudAuthClient, CloudOAuthProvider } from './authClient';
import { loadCloudAuthCapabilities } from './cloudAuthCapabilities';
import { cloudAuthCapabilityDiscoveryEnabled, defaultCloudOAuthProviders } from './cloudAuthReleasePolicy';
import { memoryVersionFromCapabilities } from './memoryCapability';

/**
 * Server capabilities. Memory discovery runs in every build; sign-in methods only where enabled.
 * `cacheKey` shares one fetch per API base URL with other capability readers.
 */
export function useCloudCapabilities(
  authClient: Pick<CloudAuthClient, 'capabilities'>,
  enabled: boolean,
  cacheKey?: string,
) {
  const [oauthProviders, setOAuthProviders] = useState<CloudOAuthProvider[]>(defaultCloudOAuthProviders);
  const [memoryVersion, setMemoryVersion] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const discoverSignInMethods = cloudAuthCapabilityDiscoveryEnabled();
    let cancelled = false;

    void loadCloudAuthCapabilities(authClient, cacheKey)
      .then((capabilities) => {
        if (cancelled) return;
        setMemoryVersion(memoryVersionFromCapabilities(capabilities));
        if (!discoverSignInMethods) return;
        setOAuthProviders(capabilities.oauthProviders.filter(
          (provider): provider is CloudOAuthProvider => provider === 'google' || provider === 'github',
        ));
      })
      .catch(() => {
        if (cancelled) return;
        setMemoryVersion(null);
        if (discoverSignInMethods) setOAuthProviders(defaultCloudOAuthProviders());
      });

    return () => {
      cancelled = true;
    };
  }, [authClient, cacheKey, enabled]);

  return { oauthProviders, memoryVersion };
}
