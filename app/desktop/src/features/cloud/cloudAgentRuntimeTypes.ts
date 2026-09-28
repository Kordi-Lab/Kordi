
export type CloudProviderAuthSnapshotInput = {
  provider: string;
  authChoice: string;
  label?: string | null;
  payload: unknown;
};

export type CloudProviderAuthSnapshot = {
  snapshotId: string;
  provider: string;
  authChoice: string;
  label?: string | null;
  modelHint?: string | null;
  createdAt: string;
  revokedAt: string | null;
  /** `needs-reconnect` when the hosted copy can no longer refresh, for example a desktop sign-in whose access token expired. */
  status?: string | null;
};

export type CloudProviderRouteTestInput = {
  provider: string;
  authChoice: string;
  model: string;
  thinking: string;
};

export type CloudProviderRouteTestResult = {
  runner: 'OMP';
  provider: string;
  accountLabel: string;
  model: string;
  response: string;
};

export type CloudAgentRunClaimInput = {
  requestMessageId: string;
  sessionId: string;
  ownerAccountId: string;
  requesterAccountId: string;
  prompt: string;
  idempotencyKey: string;
  targetCloudAgentId?: string | null;
  runtimeRoute?: { defaultModel?: string | null; defaultAuthProvider?: string | null; defaultAuthChoice?: string | null; thinking?: string | null };
};

export type CloudAgentRunStatus = string;

export type CloudAgentRun = {
  runId: string;
  status: CloudAgentRunStatus;
  sandboxId: string | null;
  createdAt: string;
  updatedAt: string;
  executionBackend?: 'cloud' | 'desktop';
};

export type CloudAgentRunLookup = {
  run: CloudAgentRun | null;
};
