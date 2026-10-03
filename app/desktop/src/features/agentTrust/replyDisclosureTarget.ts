// Which agent reply "About this reply" describes, and how the app asks the
// server about it. The AI chip and the message menu announce a request with a
// window event; one dialog host near the transcript answers it.
import type { ReplyDisclosureRequest } from '@/features/cloud/agentTrustTypes';
import { isPipAvatarUrl } from '@/features/pip/pipIdentity';
import type { Message } from '@/kordi-app/types';
import { isAgentAuthoredMessage } from './agentAuthorship';
import { dispatchWindowEvent } from './agentTrustEvents';

export const OPEN_REPLY_DISCLOSURE_EVENT = 'kordi-open-reply-disclosure';

/** The run an agent reply answers, from the reply's stored content. */
export type AgentRunRef = { ownerAccountId: string; requestId: string };

export type ReplyDisclosureTarget = {
  key: string;
  sessionId: string | null;
  requestId: string | null;
  ownerAccountId: string | null;
  role: Message['role'];
  agentName: string | null;
  ownerName: string | null;
  isPip: boolean;
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function agentRunRefFromContent(content: Record<string, unknown>): AgentRunRef | null {
  const ownerAccountId = text(content.senderOwnerAccountId);
  const requestId = text(content.requestId) ?? text(content.replyToMessageId) ?? text(content.requestMessageId);
  return ownerAccountId && requestId ? { ownerAccountId, requestId } : null;
}

/** Group and direct conversations synced through Kordi Cloud. */
export function cloudSharedSessionId(value: string | null | undefined): string | null {
  const id = value?.trim() ?? '';
  return id.startsWith('session:group:') || id.startsWith('session:direct-person:') ? id : null;
}

export function replyDisclosureTargetForMessage(message: Message): ReplyDisclosureTarget | null {
  if (!isAgentAuthoredMessage(message)) return null;
  const key = text(message.id) ?? text(message.entryId) ?? text(message.turn?.id);
  if (!key) return null;
  return {
    key,
    sessionId: cloudSharedSessionId(message.turn?.sessionId),
    requestId: message.agentRunRef?.requestId ?? text(message.replyToMessageId) ?? text(message.turn?.replyToMessageId),
    ownerAccountId: message.agentRunRef?.ownerAccountId ?? null,
    role: message.role,
    agentName: text(message.sender),
    ownerName: text(message.senderOwnerName),
    isPip: isPipAvatarUrl(message.senderProfileImageUrl),
  };
}

/** Cloud-synced agent replies and PiP offer "About this reply"; replies that
 * are still being written and local-only agent chats do not. */
export function messageOffersReplyDisclosure(message: Message): boolean {
  if (!isAgentAuthoredMessage(message)) return false;
  if (message.turn && !message.turn.completed) return false;
  return isPipAvatarUrl(message.senderProfileImageUrl)
    || Boolean(message.agentRunRef)
    || Boolean(message.reactionConversationId)
    || Boolean(cloudSharedSessionId(message.turn?.sessionId));
}

/**
 * What the disclosure route needs, filling gaps from the open conversation:
 * its cloud session, and, in a direct chat, the owner (the signed-in account
 * for its own agent, the other person for theirs). `null` when the reply
 * cannot be looked up.
 */
export function replyDisclosureRequestFor(
  target: ReplyDisclosureTarget,
  context: { sessionId?: string | null; accountId?: string | null },
): { sessionId: string; reply: ReplyDisclosureRequest } | null {
  const sessionId = target.sessionId ?? cloudSharedSessionId(context.sessionId);
  if (!sessionId || !target.requestId) return null;
  let ownerAccountId = target.ownerAccountId;
  const accountId = context.accountId?.trim() || null;
  if (!ownerAccountId && sessionId.startsWith('session:direct-person:') && accountId) {
    const peer = sessionId.slice('session:direct-person:'.length).split(':').find((id) => id && id !== accountId) ?? null;
    ownerAccountId = target.role === 'owned-agent' ? accountId : target.role === 'external-agent' ? peer : null;
  }
  if (!ownerAccountId) return null;
  return { sessionId, reply: { key: target.key, requestId: target.requestId, ownerAccountId } };
}

export function requestReplyDisclosure(message: Message): void {
  const target = replyDisclosureTargetForMessage(message);
  if (target) dispatchWindowEvent<ReplyDisclosureTarget>(OPEN_REPLY_DISCLOSURE_EVENT, target);
}

export function onReplyDisclosureRequested(listener: (target: ReplyDisclosureTarget) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handle = (event: Event) => listener((event as CustomEvent<ReplyDisclosureTarget>).detail);
  window.addEventListener(OPEN_REPLY_DISCLOSURE_EVENT, handle);
  return () => window.removeEventListener(OPEN_REPLY_DISCLOSURE_EVENT, handle);
}
