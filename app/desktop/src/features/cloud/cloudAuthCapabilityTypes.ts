export type CloudOAuthProvider = 'google' | 'github';

export type CloudAuthCapabilities = {
  password: boolean;
  oauthProviders: CloudOAuthProvider[];
  connectorsVersion?: number | null; // Present when the server serves /v1/cloud/connectors.
  memoryVersion?: number;
  commonGroundVersion?: number | null; // Present when the server serves /v1/cloud/common-ground.
  contactProfileVersion?: number | null; // Present when the server serves /v1/cloud/contacts/{id}/profile.
};
