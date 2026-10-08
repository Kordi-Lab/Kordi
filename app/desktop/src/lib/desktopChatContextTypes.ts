
export type DesktopChatContextMessage = {
  executionLease?: { runId: string; claimId: string; ownerAccountId: string; sessionId: string; connectorTools?: unknown[]; connectorAudience?: 'owner_private' };
  id: string;
  authorName: string;
  authorKind: 'human' | 'agent'; contextRole?: 'history' | 'system' | 'resource' | 'runtimeIdentity';
  text: string;
  createdAtMs?: number | null;
};

export type DesktopVisibleTaskRecord = {
  taskId: string;
  parentTaskId?: string | null;
  title: string;
  summary?: string | null;
  status: string;
  involvedParticipants?: string[];
};
