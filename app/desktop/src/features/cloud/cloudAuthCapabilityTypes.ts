export type CloudOAuthProvider = 'google' | 'github';

export type CloudAuthCapabilities = {
  password: boolean;
  oauthProviders: CloudOAuthProvider[];
  connectorsVersion?: number | null; // Present when the server serves /v1/cloud/connectors.
  memoryVersion?: number;
};
