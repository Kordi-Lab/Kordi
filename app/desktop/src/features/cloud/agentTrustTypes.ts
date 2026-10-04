// Wire types for AI access settings, actions that need a person, and reply
// disclosure. Every field is optional on read: older servers omit them, and a
// malformed value must never break the chat UI.

export type ChatSyncAiHistoryScope = 'mentions' | 'recent';

export type ChatSyncPipAccess = {
  available: boolean;
  enabled: boolean;
  provider_label: string | null;
};

/** `ai_access` on a conversation snapshot, as the viewer sees it. */
export type ChatSyncAiAccess = {
  history_scope: ChatSyncAiHistoryScope;
  pip: ChatSyncPipAccess | null;
  /** Active members with "Don't let AI use my messages" on, for settings. */
  excluded_member_ids: string[];
  /** Everyone with it on, including members who left. Local filters read this. */
  excluded_account_ids?: string[];
  viewer_excluded: boolean;
  viewer_can_manage: boolean;
};

export type AiFeatures = {
  pip: { available: boolean; providerLabel: string | null };
};

/** Exactly one change per request. */
export type AiAccessChange =
  | { history_scope: ChatSyncAiHistoryScope }
  | { pip_enabled: boolean }
  | { exclude_my_messages: boolean };

export type PendingAgentActionKind =
  | 'calendar_disclosure'
  | 'plan_rsvp'
  | 'plan_vote'
  | 'plan_confirm'
  | 'plan_cancel'
  | 'plan_reopen';

export type PendingAgentActionStatus =
  | 'pending'
  | 'approved'
  | 'declined'
  | 'expired'
  | 'superseded'
  | 'applied';

export type PendingAgentAction = {
  actionId: string;
  kind: PendingAgentActionKind;
  sessionId: string;
  conversationId: string;
  status: PendingAgentActionStatus;
  createdAt: string;
  expiresAt: string;
  proposedBy: { accountId: string; displayName: string | null; kind: 'agent' | 'pip' };
  subject: Record<string, unknown>;
};

export type AgentActionDecision = 'approve' | 'decline';

export type AgentActionDecisionResult = {
  action: PendingAgentAction | null;
  planCard: unknown;
};

export type ReplyDisclosureRequest = {
  key: string;
  requestId: string;
  ownerAccountId: string;
};

export type ReplyDisclosure = {
  key: string;
  agentId: string | null;
  agentName: string | null;
  ownerAccountId: string | null;
  ownerName: string | null;
  requesterAccountId: string | null;
  requesterName: string | null;
  runtime: 'kordi_cloud' | 'owner_device' | null;
  credentials: 'owner' | 'kordi' | null;
  provider: string | null;
  providerLabel: string | null;
  model: string | null;
};
