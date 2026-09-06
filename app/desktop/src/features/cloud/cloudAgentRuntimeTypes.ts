
export type CloudProviderAuthSnapshotInput = {
  provider: string;
  authChoice: string;
  payload: unknown;
};

export type CloudProviderAuthSnapshot = {
  snapshotId: string;
  provider: string;
  authChoice: string;
  createdAt: string;
  revokedAt: string | null;
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
