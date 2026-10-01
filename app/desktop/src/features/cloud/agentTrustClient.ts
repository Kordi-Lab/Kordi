import type { ChatSyncState } from './chatSyncState';
import type { ChatSyncConversation } from './chatSyncTypes';
import type {
  AgentActionDecision,
  AgentActionDecisionResult,
  AiAccessChange,
  AiFeatures,
  ChatSyncAiAccess,
  ChatSyncPipAccess,
  PendingAgentAction,
  PendingAgentActionKind,
  PendingAgentActionStatus,
  ReplyDisclosure,
  ReplyDisclosureRequest,
} from './agentTrustTypes';

const ACTION_KINDS = new Set<PendingAgentActionKind>([
  'calendar_disclosure', 'plan_rsvp', 'plan_vote', 'plan_confirm', 'plan_cancel', 'plan_reopen',
]);
const ACTION_STATUSES = new Set<PendingAgentActionStatus>([
  'pending', 'approved', 'declined', 'expired', 'superseded', 'applied',
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizePip(value: unknown): ChatSyncPipAccess | null {
  const pip = record(value);
  if (!pip) return null;
  return {
    available: pip.available === true,
    enabled: pip.enabled === true,
    provider_label: text(pip.provider_label),
  };
}

/** Reads `ai_access` leniently. `null` when absent or malformed. */
export function normalizeAiAccess(value: unknown): ChatSyncAiAccess | null {
  const access = record(value);
  if (!access) return null;
  const scope = access.history_scope === 'recent' ? 'recent' : 'mentions';
  const excluded = Array.isArray(access.excluded_member_ids)
    ? [...new Set(access.excluded_member_ids.flatMap((id) => text(id) ?? []))]
    : [];
  return {
    history_scope: scope,
    pip: normalizePip(access.pip),
    excluded_member_ids: excluded,
    viewer_excluded: access.viewer_excluded === true,
    viewer_can_manage: access.viewer_can_manage === true,
  };
}

export function normalizePendingAgentAction(value: unknown): PendingAgentAction | null {
  const action = record(value);
  const actionId = text(action?.actionId);
  const kind = action?.kind as PendingAgentActionKind;
  if (!action || !actionId || !ACTION_KINDS.has(kind)) return null;
  const status = ACTION_STATUSES.has(action.status as PendingAgentActionStatus)
    ? action.status as PendingAgentActionStatus
    : 'pending';
  const proposedBy = record(action.proposedBy);
  return {
    actionId,
    kind,
    sessionId: text(action.sessionId) ?? '',
    conversationId: text(action.conversationId) ?? '',
    status,
    createdAt: text(action.createdAt) ?? '',
    expiresAt: text(action.expiresAt) ?? '',
    proposedBy: {
      accountId: text(proposedBy?.accountId) ?? '',
      displayName: text(proposedBy?.displayName),
      kind: proposedBy?.kind === 'pip' ? 'pip' : 'agent',
    },
    subject: record(action.subject) ?? {},
  };
}

export function normalizeReplyDisclosure(value: unknown): ReplyDisclosure | null {
  const item = record(value);
  const key = text(item?.key);
  if (!item || !key) return null;
  return {
    key,
    agentId: text(item.agentId),
    agentName: text(item.agentName),
    ownerAccountId: text(item.ownerAccountId),
    ownerName: text(item.ownerName),
    requesterAccountId: text(item.requesterAccountId),
    requesterName: text(item.requesterName),
    runtime: item.runtime === 'kordi_cloud' || item.runtime === 'owner_device' ? item.runtime : null,
    credentials: item.credentials === 'owner' || item.credentials === 'kordi' ? item.credentials : null,
    provider: text(item.provider),
    providerLabel: text(item.providerLabel),
    model: text(item.model),
  };
}

/**
 * AI access settings, actions that need a person, and reply disclosure.
 * Exposed as `ChatSyncClient.agentTrust`; every call takes the session token.
 */
export class AgentTrustClient {
  constructor(private readonly state: ChatSyncState) {}

  private get(token: string) {
    return { method: 'GET', headers: { authorization: `Bearer ${token}` } } satisfies RequestInit;
  }

  private json(token: string, method: 'POST' | 'PUT', body: unknown) {
    return {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    } satisfies RequestInit;
  }

  async aiFeatures(token: string): Promise<AiFeatures> {
    const response = await this.state.send<unknown>(
      '/v2/chat/ai-features', this.get(token), 'Could not load AI features.',
    );
    const pip = record(record(response)?.pip);
    return { pip: { available: pip?.available === true, providerLabel: text(pip?.provider_label) } };
  }

  async aiAccess(token: string, sessionId: string): Promise<ChatSyncAiAccess | null> {
    const response = await this.state.send<unknown>(
      `/v2/chat/conversations/${encodeURIComponent(sessionId)}/ai-access`,
      this.get(token),
      'Couldn\'t load AI access.',
    );
    return normalizeAiAccess(record(response)?.ai_access);
  }

  /** Applies one change and returns the updated conversation snapshot. */
  async updateAiAccess(token: string, sessionId: string, change: AiAccessChange): Promise<ChatSyncConversation> {
    const response = await this.state.send<{ conversation: ChatSyncConversation }>(
      `/v2/chat/conversations/${encodeURIComponent(sessionId)}/ai-access`,
      this.json(token, 'PUT', { client_operation_id: crypto.randomUUID(), ...change }),
      'Couldn\'t update AI access. Try again.',
    );
    this.state.rememberConversation(response.conversation);
    return response.conversation;
  }

  async listAgentActions(token: string, sessionId?: string | null): Promise<PendingAgentAction[]> {
    const query = sessionId?.trim() ? `?sessionId=${encodeURIComponent(sessionId.trim())}` : '';
    const response = await this.state.send<unknown>(
      `/v1/cloud/agent-actions${query}`, this.get(token), 'Could not load what is waiting for you.',
    );
    const actions = record(response)?.actions;
    return Array.isArray(actions)
      ? actions.flatMap((action) => normalizePendingAgentAction(action) ?? [])
      : [];
  }

  async decideAgentAction(token: string, actionId: string, decision: AgentActionDecision): Promise<AgentActionDecisionResult> {
    const response = await this.state.send<unknown>(
      `/v1/cloud/agent-actions/${encodeURIComponent(actionId)}/decision`,
      this.json(token, 'POST', { decision }),
      'Couldn\'t save your answer. Try again.',
    );
    const body = record(response);
    return { action: normalizePendingAgentAction(body?.action), planCard: body?.planCard ?? null };
  }

  async replyDisclosures(token: string, sessionId: string, replies: ReplyDisclosureRequest[]): Promise<ReplyDisclosure[]> {
    if (replies.length === 0) return [];
    const response = await this.state.send<unknown>(
      '/v1/cloud/agent-runs/disclosures',
      this.json(token, 'POST', { sessionId, replies: replies.slice(0, 50) }),
      'Couldn\'t load details. Try again.',
    );
    const disclosures = record(response)?.disclosures;
    return Array.isArray(disclosures)
      ? disclosures.flatMap((item) => normalizeReplyDisclosure(item) ?? [])
      : [];
  }
}
