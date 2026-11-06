import {
  operatorCloudOAuthProviderFallback,
  type CloudApiEnvironment,
  type CloudOAuthProvider,
} from './authClient';

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
    : ['google', 'github'];
}
