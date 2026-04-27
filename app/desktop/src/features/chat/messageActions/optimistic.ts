import { BRIDGE_MESSAGE_DIRECTION_OUTBOUND } from '@/features/bridge/messages';
import { isBridgeAgentRuntime } from '@/features/bridge/runtime';
import type {
  AppendCanonicalMessageRequest,
  CanonicalSessionMessage,
  CanonicalSessionState,
  ConversationBridgeTarget,
  DesktopBridgeConversation,
  DesktopBridgeState,
  DesktopChatState,
  MessageMention,
} from '@/kordi-app/types';
import { appendCanonicalMessageFast } from '@/lib/desktop';

import type { AttachmentItem } from '../composerController.types';

export function toOptimisticAttachments(attachments: AttachmentItem[]) {
  return attachments.map((attachment) => ({
    kind: attachment.kind,
    name: attachment.name,
    formatLabel: attachment.formatLabel,
    previewUrl: attachment.previewUrl,
  }));
}

export function optimisticSessionTitleFromMessage(messageText: string, attachments: AttachmentItem[], fallbackTitle: string) {
  const titleFromText = messageText
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .join(' ')
    .slice(0, 60)
    .trim();

  if (titleFromText) {
    return titleFromText;
  }

  if (attachments.length === 1) {
    return `Attached ${attachments[0].name}`;
  }

  if (attachments.length > 1) {
    return `${attachments.length} attachments`;
  }

  return fallbackTitle;
}

export function appendOptimisticOutboundMessage(
  current: DesktopChatState,
  targetSessionId: string,
  previewText: string,
  messageText: string,
  attachments: AttachmentItem[],
  sentAt: string,
  mentions: MessageMention[] = [],
) {
  const optimisticMessage = {
    role: 'user' as const,
    sender: 'Me',
    text: messageText,
    attachments: toOptimisticAttachments(attachments),
    mentions,
    timeLabel: sentAt,
    timestampMs: Date.now(),
  };

  const activeSessionMatches = current.activeSession.id === targetSessionId;
  const existingSummary = current.sessions.find((session) => session.id === targetSessionId);
  const nextMessageCount = activeSessionMatches
    ? current.activeSession.messageCount + 1
    : (existingSummary?.messageCount ?? 0) + 1;
  const baselineTitle = activeSessionMatches
    ? current.activeSession.title
    : existingSummary?.title ?? 'New session';
  const nextTitle = baselineTitle.trim() === 'New session'
    ? optimisticSessionTitleFromMessage(messageText, attachments, baselineTitle)
    : baselineTitle;
  const nextSessions = current.sessions.some((session) => session.id === targetSessionId)
    ? current.sessions.map((session) =>
        session.id === targetSessionId
          ? {
              ...session,
              subtitle: previewText,
              updatedAtLabel: sentAt,
              messageCount: nextMessageCount,
              draft: false,
            }
          : session,
      )
    : [{
        id: targetSessionId,
        title: nextTitle,
        subtitle: previewText,
        updatedAtLabel: sentAt,
        messageCount: nextMessageCount,
        draft: false,
      }, ...current.sessions];

  return {
    ...current,
    sessions: nextSessions,
    activeSession:
      activeSessionMatches
        ? {
            ...current.activeSession,
            subtitle: previewText,
            updatedAtLabel: sentAt,
            messageCount: nextMessageCount,
            draft: false,
            messages: [...current.activeSession.messages, optimisticMessage],
          }
        : current.activeSession,
  };
}

export function appendOptimisticBridgeMessage(
  current: DesktopBridgeState | null,
  conversationId: string,
  text: string,
  sentAt: string,
  optimisticMessageId: string,
): DesktopBridgeState | null {
  if (!current) return current;

  const timestampMs = Date.now();
  const nextConversations = current.conversations.map((conversation) => {
    if (conversation.id !== conversationId) return conversation;
    return {
      ...conversation,
      subtitle: text,
      updatedAtMs: timestampMs,
      updatedAtLabel: sentAt,
      awaitingReply: isBridgeAgentRuntime(conversation.peerRuntime),
      messages: [
        ...conversation.messages,
        {
          id: optimisticMessageId,
          direction: BRIDGE_MESSAGE_DIRECTION_OUTBOUND,
          sender: 'Me',
          text,
          timeLabel: sentAt,
          timestampMs,
          deliveryState: 'sending',
        },
      ],
    };
  }).sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  return {
    ...current,
    conversations: nextConversations,
  };
}

export function markOptimisticBridgeMessageFailed(
  current: DesktopBridgeState | null,
  conversationId: string,
  optimisticMessageId: string,
): DesktopBridgeState | null {
  if (!current) return current;

  return {
    ...current,
    conversations: current.conversations.map((conversation) => {
      if (conversation.id !== conversationId) return conversation;
      return {
        ...conversation,
        awaitingReply: false,
        messages: conversation.messages.map((message) => (
          message.id === optimisticMessageId
            ? { ...message, deliveryState: 'failed' }
            : message
        )),
      };
    }),
  };
}

export function findBridgeConversationForTarget(
  state: DesktopBridgeState,
  target: ConversationBridgeTarget,
): DesktopBridgeConversation | null {
  const normalizedRuntime = target.runtime?.trim().toLowerCase();
  return state.conversations.find((conversation) => (
    conversation.hostId === target.hostId
    && conversation.peerNodeId === target.nodeId
    && (!normalizedRuntime || conversation.peerRuntime.trim().toLowerCase() === normalizedRuntime)
  )) ?? null;
}

export type PreparedCanonicalUserMessage = {
  messageId: string;
  timestampMs: number;
  request: AppendCanonicalMessageRequest;
};

export function prepareCanonicalUserMessage(
  sessionId: string,
  senderIdentityId: string | null | undefined,
  text: string,
  attachments: AttachmentItem[],
  sentAt: string,
  sourceTransport: 'desktop-chat-ui' | 'desktop-bridge-ui',
  status = 'sending',
  mentions: MessageMention[] = [],
): PreparedCanonicalUserMessage | null {
  if (!senderIdentityId) return null;

  const timestampMs = Date.now();
  const randomId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${timestampMs}-${Math.random().toString(16).slice(2)}`;
  const messageId = `msg:ui:${randomId}`;
  return {
    messageId,
    timestampMs,
    request: {
      id: messageId,
      sessionId,
      senderIdentityId,
      senderRole: 'user',
      messageKind: 'text',
      contentText: text,
      content: {
        sender: 'Me',
        timeLabel: sentAt,
        timestampMs,
        attachments: toOptimisticAttachments(attachments),
        mentions,
      },
      createdAtMs: timestampMs,
      parentMessageId: null,
      delegatedExchangeId: null,
      status,
      sourceTransport,
      sourceEventId: `${sourceTransport}:${sessionId}:${timestampMs}`,
    },
  };
}

export function appendOptimisticCanonicalMessage(
  current: CanonicalSessionState | null,
  prepared: PreparedCanonicalUserMessage | null,
): CanonicalSessionState | null {
  if (!current || !prepared) return current;
  if (current.messages.some((message) => message.id === prepared.messageId)) return current;

  const { request, timestampMs } = prepared;
  const sequenceNum = current.messages
    .filter((message) => message.sessionId === request.sessionId)
    .reduce((max, message) => Math.max(max, message.sequenceNum), 0) + 1;
  const message: CanonicalSessionMessage = {
    id: prepared.messageId,
    sessionId: request.sessionId,
    senderIdentityId: request.senderIdentityId,
    senderRole: request.senderRole,
    messageKind: request.messageKind,
    contentText: request.contentText,
    content: request.content,
    parentMessageId: request.parentMessageId,
    delegatedExchangeId: request.delegatedExchangeId,
    status: request.status ?? 'sending',
    sequenceNum,
    createdAtMs: request.createdAtMs ?? timestampMs,
    updatedAtMs: timestampMs,
    contentHash: null,
    sourceTransport: request.sourceTransport,
    sourceEventId: request.sourceEventId,
  };

  return {
    ...current,
    sessions: current.sessions.map((session) => (
      session.id === request.sessionId
        ? {
            ...session,
            updatedAtMs: Math.max(session.updatedAtMs, timestampMs),
            lastMessageAtMs: Math.max(session.lastMessageAtMs ?? 0, message.createdAtMs),
          }
        : session
    )),
    messages: [...current.messages, message],
  };
}

export async function persistCanonicalUserMessage(prepared: PreparedCanonicalUserMessage | null) {
  if (!prepared) return null;
  await appendCanonicalMessageFast(prepared.request);
  return prepared.messageId;
}
