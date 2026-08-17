import { cloudAgentNoProviderNoticeText } from '@/features/cloud/cloudAgentMessages';
import { NO_PROVIDER_PENDING_LIVE_TURN_PREFIX } from '@/features/chat/desktopLiveTurns';
import type {
  AppendCanonicalMessageRequest,
  CanonicalSessionState,
  DesktopChatTurnSnapshot,
} from '@/kordi-app/types';

function canonicalIdentityKind(
  state: CanonicalSessionState,
  identityId?: string | null,
): string | null {
  return state.identities.find((identity) => identity.id === identityId)?.kind
    ?? null;
}

export function ownedAgentIdentityId(
  state: CanonicalSessionState | null,
  fallbackPrimaryIdentityId?: string | null,
) {
  const fallback = fallbackPrimaryIdentityId?.trim();
  if (
    state
    && fallback
    && canonicalIdentityKind(state, fallback) === 'agent'
  ) return fallback;
  return state?.identities.find((identity) => (
    identity.kind === 'agent'
    && identity.ownerIdentityId === state.profile.humanIdentityId
  ))?.id ?? null;
}

export function noProviderPendingLiveTurn({
  sessionId,
  requestMessageId,
  text,
  now = Date.now(),
}: {
  sessionId: string;
  requestMessageId: string;
  text: string;
  now?: number;
}): DesktopChatTurnSnapshot {
  return {
    id: `${NO_PROVIDER_PENDING_LIVE_TURN_PREFIX}${requestMessageId}`,
    sessionId,
    prompt: text.trim(),
    status: 'starting',
    message: 'Working…',
    assistantText: '',
    thinkingText: '',
    tools: [],
    completed: false,
    succeeded: false,
    startedAtMs: now,
    completedAtMs: null,
    error: null,
    replyToMessageId: requestMessageId,
  };
}

export function canonicalNoProviderFailedAgentMessageRequest({
  state,
  sessionId,
  requestMessageId,
  now = Date.now(),
}: {
  state: CanonicalSessionState | null;
  sessionId: string;
  requestMessageId: string;
  now?: number;
}): AppendCanonicalMessageRequest | null {
  if (!state) return null;
  const session = state.sessions.find((candidate) => candidate.id === sessionId)
    ?? null;
  if (!session) return null;
  const agentIdentityId = ownedAgentIdentityId(
    state,
    session.primaryIdentityId,
  );
  if (!agentIdentityId) return null;
  const notice = cloudAgentNoProviderNoticeText();
  return {
    id: `msg:no-provider:${requestMessageId}`,
    sessionId,
    senderIdentityId: agentIdentityId,
    senderRole: 'owned-agent',
    messageKind: 'agent-turn',
    contentText: '',
    content: {
      sender: 'My Kordi',
      timestampMs: now,
      deliveryState: 'failed',
      requestId: requestMessageId,
      replyToMessageId: requestMessageId,
      error: notice,
    },
    createdAtMs: now,
    parentMessageId: requestMessageId,
    delegatedExchangeId: null,
    status: 'failed',
    sourceTransport: 'desktop-chat-ui',
    sourceEventId:
      `desktop-chat-ui-no-provider:${sessionId}:${requestMessageId}`,
  };
}

export function initialCloudAgentSessionTitle(
  text: string,
  attachmentCount: number,
): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const title = words.slice(0, 8).join(' ').slice(0, 60).trim();
  if (title) return title;
  if (attachmentCount === 1) return 'File attachment';
  if (attachmentCount > 1) return `${attachmentCount} attachments`;
  return 'New session';
}
