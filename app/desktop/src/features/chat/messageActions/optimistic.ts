import { COLLABORATION_MESSAGE_DIRECTION_OUTBOUND } from '@/features/collaboration/messages';
import { isCollaborationAgentRuntime } from '@/features/collaboration/runtime';
import type {
  AppendCanonicalMessageRequest,
  CanonicalSessionMessage,
  CanonicalSessionState,
  ConversationCollaborationTarget,
  DesktopCollaborationConversation,
  DesktopCollaborationState,
  DesktopChatState,
  MessageMention,
  Message,
  ComposerQuoteState,
} from '@/kordi-app/types';
import { appendCanonicalMessageFast } from '@/lib/desktop';

import type { AttachmentItem } from '../composerController.types';
import { quoteMessageAction } from '../messageActionMetadata';
import { optimisticSessionTitle } from '../sessionTitlePolicy';
import { optimisticAttachmentContent } from './optimisticAttachments';

export { retryAttachmentItemsFromMessage, toOptimisticAttachments, voiceMessageDraftFromAttachments, voiceMessageSendFields } from './optimisticAttachments';

export function collaborationAttachmentTransportFields(attachments: AttachmentItem[]) {
  return {
    attachmentPaths: attachments.map((attachment) => attachment.path),
    attachmentNames: attachments.map((attachment) => attachment.name),
  };
}

export function optimisticSessionTitleFromMessage(messageText: string, attachments: AttachmentItem[], fallbackTitle: string) {
  return optimisticSessionTitle(messageText, attachments, fallbackTitle);
}

export function appendOptimisticOutboundMessage(
  current: DesktopChatState,
  targetSessionId: string,
  previewText: string,
  messageText: string,
  attachments: AttachmentItem[],
  sentAt: string,
  mentions: MessageMention[] = [],
  quote: ComposerQuoteState | null = null,
) {
  const quoteAction = quote?.source ? quoteMessageAction(quote.source) : null;
  const updatedAtMs = Date.now();
  const attachmentContent = optimisticAttachmentContent(attachments);
  const optimisticMessage = {
    role: 'user' as const,
    sender: 'Me',
    text: messageText,
    ...attachmentContent,
    messageKind: attachmentContent.voiceMessage ? 'voice' : 'text',
    mentions,
    replyToMessageId: quoteAction?.source.sourceMessageId ?? null,
    messageAction: quoteAction,
    timeLabel: sentAt,
    timestampMs: updatedAtMs,
  };

  const activeSessionMatches = current.activeSession.id === targetSessionId;
  const activeProjectRoot = activeSessionMatches ? current.activeSession.project?.root?.trim() : undefined;
  const existingSummary = current.sessions.find((session) => session.id === targetSessionId);
  const existingProject = current.projects.find((project) => project.sessions.some((session) => session.id === targetSessionId));
  const existingProjectSummary = existingProject?.sessions.find((session) => session.id === targetSessionId);
  const isProjectSession = Boolean(activeProjectRoot || existingProjectSummary);
  const nextMessageCount = activeSessionMatches
    ? current.activeSession.messageCount + 1
    : (existingSummary?.messageCount ?? existingProjectSummary?.messageCount ?? 0) + 1;
  const baselineTitle = activeSessionMatches
    ? current.activeSession.title
    : existingSummary?.title ?? existingProjectSummary?.title ?? 'New chat';
  const nextTitle = /^(?:new session|new chat)$/i.test(baselineTitle.trim())
    ? optimisticSessionTitleFromMessage(messageText, attachments, baselineTitle)
    : baselineTitle;
  const optimisticSummary = {
    id: targetSessionId,
    title: nextTitle,
    subtitle: previewText,
    updatedAtLabel: sentAt,
    updatedAtMs,
    messageCount: nextMessageCount,
    draft: false,
  };
  const nextSessions = isProjectSession
    ? current.sessions.filter((session) => session.id !== targetSessionId)
    : current.sessions.some((session) => session.id === targetSessionId)
      ? current.sessions.map((session) =>
          session.id === targetSessionId
            ? {
                ...session,
                ...optimisticSummary,
              }
            : session,
        )
      : [optimisticSummary, ...current.sessions];
  const nextProjects = !isProjectSession
    ? current.projects
    : current.projects.map((project) => {
        const projectMatches = project.sessions.some((session) => session.id === targetSessionId)
          || Boolean(activeProjectRoot && project.root === activeProjectRoot);
        if (!projectMatches) return project;
        const sessions = project.sessions.some((session) => session.id === targetSessionId)
          ? project.sessions.map((session) => (
              session.id === targetSessionId
                ? {
                    ...session,
                    ...optimisticSummary,
                  }
                : session
            ))
          : [optimisticSummary, ...project.sessions];
        return { ...project, sessions };
      });

  return {
    ...current,
    sessions: nextSessions,
    projects: nextProjects,
    activeSession:
      activeSessionMatches
        ? {
            ...current.activeSession,
            subtitle: previewText,
            updatedAtLabel: sentAt,
            updatedAtMs,
            messageCount: nextMessageCount,
            draft: false,
            messages: [...current.activeSession.messages, optimisticMessage],
          }
        : current.activeSession,
  };
}

export function appendOptimisticCollaborationMessage(
  current: DesktopCollaborationState | null,
  conversationId: string,
  text: string,
  sentAt: string,
  optimisticMessageId: string,
  attachments: AttachmentItem[] = [],
  subtitleText = text,
  quote: ComposerQuoteState | null = null,
  mentions: MessageMention[] = [],
): DesktopCollaborationState | null {
  if (!current) return current;

  const timestampMs = Date.now();
  const quoteAction = quote?.source ? quoteMessageAction(quote.source) : null;
  const attachmentContent = optimisticAttachmentContent(attachments);
  const nextConversations = current.conversations.map((conversation) => {
    if (conversation.id !== conversationId) return conversation;
    const expectsAgentReply = Boolean(conversation.supportTicketEnabled)
      || isCollaborationAgentRuntime(conversation.peerRuntime);
    return {
      ...conversation,
      subtitle: subtitleText,
      updatedAtMs: timestampMs,
      updatedAtLabel: sentAt,
      awaitingReply: expectsAgentReply,
      messages: [
        ...conversation.messages,
        {
          id: optimisticMessageId,
          clientMessageId: optimisticMessageId,
          direction: COLLABORATION_MESSAGE_DIRECTION_OUTBOUND,
          sender: 'Me',
          text,
          timeLabel: sentAt,
          timestampMs,
          requestId: expectsAgentReply ? optimisticMessageId : null,
          deliveryState: 'sending',
          ...attachmentContent,
          messageKind: attachmentContent.voiceMessage ? 'voice' : 'text',
          mentions,
          messageAction: quoteAction,
        },
      ],
    };
  }).sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  return {
    ...current,
    conversations: nextConversations,
  };
}

export function markOptimisticCollaborationMessageFailed(
  current: DesktopCollaborationState | null,
  conversationId: string,
  optimisticMessageId: string,
  detail?: string | null,
): DesktopCollaborationState | null {
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
            ? {
                ...message,
                deliveryState: 'failed',
                detail: detail?.trim() || message.detail,
              }
            : message
        )),
      };
    }),
  };
}

export function markOptimisticCollaborationMessageSending(
  current: DesktopCollaborationState | null,
  conversationId: string,
  messageId: string,
): DesktopCollaborationState | null {
  if (!current) return current;

  return {
    ...current,
    conversations: current.conversations.map((conversation) => {
      if (conversation.id !== conversationId) return conversation;
      return {
        ...conversation,
        messages: conversation.messages.map((message) => (
          message.id === messageId
            ? {
                ...message,
                deliveryState: 'sending',
                detail: undefined,
              }
            : message
        )),
      };
    }),
  };
}

function optimisticContentRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function markOptimisticCanonicalMessageFailed(
  current: CanonicalSessionState | null,
  sessionId: string,
  messageId: string | null | undefined,
  detail?: string | null,
): CanonicalSessionState | null {
  if (!current || !messageId) return current;
  const updatedAtMs = Date.now();

  return {
    ...current,
    sessions: current.sessions.map((session) => (
      session.id === sessionId
        ? { ...session, updatedAtMs: Math.max(session.updatedAtMs, updatedAtMs) }
        : session
    )),
    messages: current.messages.map((message) => {
      if (message.id !== messageId || message.sessionId !== sessionId) return message;
      return {
        ...message,
        status: 'failed',
        updatedAtMs: Math.max(message.updatedAtMs, updatedAtMs),
        content: {
          ...optimisticContentRecord(message.content),
          deliveryState: 'failed',
          ...(detail?.trim() ? { detail: detail.trim() } : null),
        },
      };
    }),
  };
}

export function markOptimisticCanonicalMessageSending(
  current: CanonicalSessionState | null,
  sessionId: string,
  messageId: string,
  pendingRecipientIds: string[],
): CanonicalSessionState | null {
  if (!current) return current;
  const updatedAtMs = Date.now();

  return {
    ...current,
    sessions: current.sessions.map((session) => (
      session.id === sessionId
        ? { ...session, updatedAtMs: Math.max(session.updatedAtMs, updatedAtMs) }
        : session
    )),
    messages: current.messages.map((message) => {
      if (message.id !== messageId || message.sessionId !== sessionId) return message;
      return {
        ...message,
        status: 'sending',
        updatedAtMs: Math.max(message.updatedAtMs, updatedAtMs),
        content: {
          ...optimisticContentRecord(message.content),
          deliveryState: 'sending',
          deliveredRecipientIds: [],
          pendingRecipientIds,
          exhaustedRecipientIds: [],
          detail: undefined,
        },
      };
    }),
  };
}

export function findCollaborationConversationForTarget(
  state: DesktopCollaborationState,
  target: ConversationCollaborationTarget,
): DesktopCollaborationConversation | null {
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

export function failedPreparedCanonicalUserMessage(
  prepared: PreparedCanonicalUserMessage | null,
  detail?: string | null,
): PreparedCanonicalUserMessage | null {
  if (!prepared) return prepared;
  return {
    ...prepared,
    request: {
      ...prepared.request,
      status: 'failed',
      content: {
        ...optimisticContentRecord(prepared.request.content),
        deliveryState: 'failed',
        ...(detail?.trim() ? { detail: detail.trim() } : null),
      },
    },
  };
}

export function prepareCanonicalUserMessage(
  sessionId: string,
  senderIdentityId: string | null | undefined,
  text: string,
  attachments: AttachmentItem[],
  sentAt: string,
  sourceTransport: 'desktop-chat-ui' | 'desktop-bridge-ui' | 'cloud-group-ui',
  status = 'sending',
  mentions: MessageMention[] = [],
  quote: ComposerQuoteState | null = null,
): PreparedCanonicalUserMessage | null {
  if (!senderIdentityId) return null;

  const timestampMs = Date.now();
  const randomId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${timestampMs}-${Math.random().toString(16).slice(2)}`;
  const messageId = `msg:ui:${randomId}`;
  const quoteAction = quote?.source ? quoteMessageAction(quote.source) : null;
  const attachmentContent = optimisticAttachmentContent(attachments);
  const quoteSourceMessageId = quoteAction?.source.sourceMessageId ?? null;
  const quoteMatchesSession = quoteAction?.source.sourceSessionId === sessionId;
  return {
    messageId,
    timestampMs,
    request: {
      id: messageId,
      sessionId,
      senderIdentityId,
      senderRole: 'user',
      messageKind: attachmentContent.voiceMessage ? 'voice' : 'text',
      contentText: text,
      content: {
        sender: 'Me',
        timeLabel: sentAt,
        timestampMs,
        ...attachmentContent,
        mentions,
        ...(quoteAction ? {
          replyToMessageId: quoteSourceMessageId,
          messageAction: quoteAction,
        } : null),
      },
      createdAtMs: timestampMs,
      parentMessageId: quoteAction && quoteMatchesSession ? quoteSourceMessageId : null,
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
  return appendCanonicalMessageFast(prepared.request);
}
