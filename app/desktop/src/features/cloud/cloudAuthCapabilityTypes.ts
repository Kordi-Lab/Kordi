export type CloudOAuthProvider = 'google' | 'github' | 'apple';

export const CLOUD_OAUTH_PROVIDERS: readonly CloudOAuthProvider[] = ['google', 'github', 'apple'];

export function isCloudOAuthProvider(value: unknown): value is CloudOAuthProvider {
  return typeof value === 'string' && (CLOUD_OAUTH_PROVIDERS as readonly string[]).includes(value);
}

export type CloudAuthCapabilities = {
  password: boolean;
  oauthProviders: CloudOAuthProvider[];
  connectorsVersion?: number | null; // Present when the server serves /v1/cloud/connectors.
  memoryVersion?: number;
  commonGroundVersion?: number | null; // Present when the server serves /v1/cloud/common-ground.
  commonGroundNearbyVersion?: number | null; // Present when the server serves /v1/cloud/common-ground/nearby.
  contactProfileVersion?: number | null; // Present when the server serves /v1/cloud/contacts/{id}/profile.
};
