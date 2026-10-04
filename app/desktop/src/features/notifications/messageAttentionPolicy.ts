import type { Conversation, Message } from '@/kordi-app/types';
import { blobEmojiPlainText } from '@/features/emoji/blobEmoji';

export type MessageAttentionSnapshot = Record<string, {
  messageId: string;
  unreadCount: number;
}>;

export type DesktopMessageAttentionEvent = {
  eventId: string;
  sessionId: string;
  messageId: string;
  title: string;
  previewText: string;
  unreadCount: number;
  threadRootId?: string;
};

export function shouldRequestDockAttention({
  enabled,
  windowFocused,
  lastRequestedAt,
  now,
  minimumIntervalMs,
}: {
  enabled: boolean;
  windowFocused: boolean;
  lastRequestedAt: number;
  now: number;
  minimumIntervalMs: number;
}) {
  return enabled
    && !windowFocused
    && (lastRequestedAt <= 0 || now - lastRequestedAt >= minimumIntervalMs);
}

function isIncomingVisibleMessage(message: Message) {
  if (!message.id || message.isForkSnapshot) return false;
  if (message.isOwnMessage ?? message.role === 'user') return false;
  return !['system', 'action', 'edit'].includes(message.role);
}

function latestIncomingMessage(conversation: Conversation) {
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    if (message && isIncomingVisibleMessage(message)) return message;
  }
  return null;
}

function messagePreview(message: Message) {
  const compactText = blobEmojiPlainText(message.text).trim().replace(/\s+/g, ' ');
  if (compactText) {
    return compactText.length > 140 ? `${compactText.slice(0, 140)}…` : compactText;
  }
  const attachmentCount = message.attachments?.length ?? 0;
  if (attachmentCount === 1) {
    return message.attachments?.[0]?.kind === 'image' ? 'Sent a photo' : 'Sent a file';
  }
  if (attachmentCount > 1) return `Sent ${attachmentCount} files`;
  return 'New message';
}

export function messageAttentionSnapshot(
  conversations: Conversation[],
): MessageAttentionSnapshot {
  return Object.fromEntries(conversations.flatMap((conversation) => {
    const message = latestIncomingMessage(conversation);
    if (!message?.id) return [];
    const sessionId = conversation.canonicalSessionId?.trim() || conversation.id;
    return [[sessionId, {
      messageId: message.id,
      unreadCount: Math.max(0, conversation.unread ?? 0),
    }]];
  }));
}

const DEFAULT_CLOUD_AGENT_IDENTITY_PREFIX = 'agent:cloud-agent:cloud-agent:';

/**
 * Whether a message comes from a suppressed sender: the sender itself, or for
 * an agent message, the agent's human owner (`human:<account>`). A default
 * cloud agent names its owner in its identity even before the owner is known.
 */
function fromSuppressedSender(message: Message, suppressed: ReadonlySet<string> | undefined): boolean {
  if (!suppressed?.size) return false;
  const sender = message.senderIdentityId?.trim();
  const owner = message.senderOwnerIdentityId?.trim()
    || (sender?.startsWith(DEFAULT_CLOUD_AGENT_IDENTITY_PREFIX)
      ? `human:${sender.slice(DEFAULT_CLOUD_AGENT_IDENTITY_PREFIX.length)}`
      : null);
  return Boolean((sender && suppressed.has(sender)) || (owner && suppressed.has(owner)));
}

export function newMessageAttentionEvents({
  previous,
  conversations,
  suppressedSenderIdentityIds,
}: {
  previous: MessageAttentionSnapshot;
  conversations: Conversation[];
  /**
   * Senders whose messages never notify, such as `human:<account>` identities
   * the user blocked. Their agents' messages are suppressed too.
   */
  suppressedSenderIdentityIds?: ReadonlySet<string>;
}): DesktopMessageAttentionEvent[] {
  return conversations.flatMap((conversation) => {
    const message = latestIncomingMessage(conversation);
    if (!message?.id) return [];
    if (fromSuppressedSender(message, suppressedSenderIdentityIds)) return [];
    const sessionId = conversation.canonicalSessionId?.trim() || conversation.id;
    const unreadCount = Math.max(0, conversation.unread ?? 0);
    const prior = previous[sessionId];
    const unreadIncreased = unreadCount > (prior?.unreadCount ?? 0);
    if (unreadCount <= 0 || (prior?.messageId === message.id && !unreadIncreased)) return [];
    return [{
      eventId: message.id,
      sessionId,
      messageId: message.id,
      title: message.sender?.trim() || conversation.name || 'Kordi',
      previewText: messagePreview(message),
      ...(message.messageAction?.kind==='thread'?{threadRootId:message.messageAction.source.sourceMessageId}:{}),
      unreadCount,
    }];
  });
}

export function notificationNumericId(eventId: string) {
  let hash = 0x811c9dc5;
  for (const character of eventId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}
