import {
  operatorCloudOAuthProviderFallback,
  type CloudApiEnvironment,
  type CloudOAuthProvider,
} from './authClient';
import { isCloudOAuthProvider } from './cloudAuthCapabilityTypes';

/** Product sign-in always offers these; capability discovery never hides them. */
const PRODUCT_OAUTH_PROVIDERS: readonly CloudOAuthProvider[] = ['google', 'github'];

function activeEnvironment(env?: CloudApiEnvironment): CloudApiEnvironment | undefined {
  const meta = typeof import.meta !== 'undefined'
    ? (import.meta as ImportMeta & { env?: CloudApiEnvironment }).env
    : undefined;
  return env ?? meta;
}

export function cloudAuthCapabilityDiscoveryEnabled(env?: CloudApiEnvironment): boolean {
  return activeEnvironment(env)?.DEV === true;
}

export function defaultCloudOAuthProviders(env?: CloudApiEnvironment): CloudOAuthProvider[] {
  return cloudAuthCapabilityDiscoveryEnabled(env)
    ? operatorCloudOAuthProviderFallback(env)
    : [...PRODUCT_OAUTH_PROVIDERS];
}

/**
 * Sign-in providers to offer once the server's capabilities arrive. Development
 * follows the server list. Packaged apps keep Google and GitHub and add Apple
 * only when the server says it is configured.
 */
export function offeredCloudOAuthProviders(
  advertised: readonly unknown[],
  env?: CloudApiEnvironment,
): CloudOAuthProvider[] {
  const known = advertised.filter(isCloudOAuthProvider);
  if (cloudAuthCapabilityDiscoveryEnabled(env)) return [...new Set(known)];
  return known.includes('apple') ? [...PRODUCT_OAUTH_PROVIDERS, 'apple'] : [...PRODUCT_OAUTH_PROVIDERS];
}
