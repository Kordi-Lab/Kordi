export type CloudAgentRunClaimInput = {
  requestMessageId: string;
  sessionId: string;
  ownerAccountId: string;
  requesterAccountId: string;
  prompt: string;
  idempotencyKey: string;
  targetCloudAgentId?: string | null;
};

export type CloudAgentRunStatus =
  | 'queued'
  | 'leased'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type CloudAgentRun = {
  runId: string;
  status: CloudAgentRunStatus;
  sandboxId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CloudAgentRunLookup = {
  run: CloudAgentRun | null;
};
