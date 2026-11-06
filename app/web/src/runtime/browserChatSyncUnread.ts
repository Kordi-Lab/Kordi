import { decodeBase64UrlUtf8 } from '@/features/cloud/cloudBase64Url';
import type { ChatSyncConversation, ChatSyncMessage } from '@/features/cloud/chatSyncTypes';
import type { ChatSyncConversationHead } from '@/lib/desktopChatSync';

// Browser twin of the Mac's chat sync unread policy
// (src-tauri/src/canonical_sessions/chat_sync/unread_policy.rs and
// load_conversation_heads). Both clients count the messages after the
// server's conversation read cursor, so a fresh browser sign-in shows the same
// totals as the Mac and the phone.

const CLOUD_GROUP_PREFIX = 'kordi-cloud-group:';
const AGENT_RESPONSE_PREFIX = 'kordi-cloud-agent-response:';
const THREAD_WALK_LIMIT = 16;

type Envelope = Record<string, unknown>;

function envelope(body: string | null, prefix: string): Envelope | null {
  if (!body?.startsWith(prefix)) return null;
  try {
    const value: unknown = JSON.parse(decodeBase64UrlUtf8(body.slice(prefix.length)));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Envelope : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Envelope | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Envelope : null;
}

function text(value: unknown) {
  return typeof value === 'string' ? value : null;
}

export function chatSyncMessageBody(message: Pick<ChatSyncMessage, 'content'>): string | null {
  const blocks = record(message.content)?.blocks;
  return Array.isArray(blocks) ? text(record(blocks[0])?.text) : null;
}

function isSelfAgentReply(body: string | null) {
  const response = envelope(body, AGENT_RESPONSE_PREFIX);
  if (response) {
    return response.kind === 'agent-response'
      && !['queued', 'processing'].includes(text(response.deliveryState) ?? '')
      && Boolean(text(response.text)?.trim());
  }
  const group = envelope(body, CLOUD_GROUP_PREFIX);
  return group?.kind === 'group-message' && record(group.message)?.senderKind === 'agent';
}

/** The key one unread message counts under, or null when it never counts. */
export function chatSyncUnreadKey(messageId: string, body: string | null): string | null {
  if (!body?.startsWith(CLOUD_GROUP_PREFIX)) return messageId;
  const group = envelope(body, CLOUD_GROUP_PREFIX);
  if (group?.kind !== 'group-message') return null;
  const message = record(group.message);
  if (!message) return null;
  if (message.senderKind === 'agent' && ['queued', 'processing'].includes(text(message.deliveryState) ?? '')) return null;
  return text(message.id)?.trim() || messageId;
}

// The attention fields the server derives from a message body: a group
// envelope's inner message, another Kordi envelope itself, or nothing.
function attentionContent(body: string | null): Envelope | null {
  if (!body) return null;
  const group = envelope(body, CLOUD_GROUP_PREFIX);
  if (group) return record(group.message);
  const separator = body.indexOf(':');
  if (separator < 0) return null;
  const prefix = body.slice(0, separator);
  return prefix.startsWith('kordi-cloud-') ? envelope(body, `${prefix}:`) : null;
}

function uuidReference(reference: string) {
  if (!reference.startsWith('collaboration-message:')) return reference;
  const rest = reference.slice('collaboration-message:'.length);
  return rest.slice(rest.lastIndexOf(':') + 1);
}

/**
 * Mirrors the server's thread resolution. A discussion reply counts against
 * its own thread read cursor (reported by the attention endpoint), never
 * against the conversation read cursor.
 */
export function isChatSyncThreadMessage(
  message: Pick<ChatSyncMessage, 'content' | 'reply_to_message_id'>,
  findInConversation: (reference: string) => Pick<ChatSyncMessage, 'content' | 'reply_to_message_id'> | undefined,
) {
  let body = chatSyncMessageBody(message);
  let replyTo = message.reply_to_message_id;
  // Replies inherit the thread of their parent; bound the walk.
  for (let step = 0; step < THREAD_WALK_LIMIT; step += 1) {
    const content = attentionContent(body);
    if (record(content?.messageAction)?.kind === 'thread') return true;
    const reference = (text(content?.replyToMessageId) ?? text(content?.requestId) ?? replyTo)?.trim();
    replyTo = null;
    if (!reference) return false;
    const parent = findInConversation(uuidReference(reference));
    if (!parent) return false;
    body = chatSyncMessageBody(parent);
    replyTo = parent.reply_to_message_id;
  }
  return false;
}

export function chatSyncConversationHeads(
  accountId: string,
  conversations: readonly ChatSyncConversation[],
  messages: readonly ChatSyncMessage[],
): ChatSyncConversationHead[] {
  const byConversation = new Map<string, ChatSyncMessage[]>();
  for (const message of messages) {
    const rows = byConversation.get(message.conversation_id);
    if (rows) rows.push(message);
    else byConversation.set(message.conversation_id, [message]);
  }
  return conversations.map((conversation) => {
    const viewer = conversation.members.find((member) => member.account_id === accountId);
    const lastReadSequence = viewer?.last_read_sequence ?? 0;
    const rows = byConversation.get(conversation.id) ?? [];
    let lookup: Map<string, ChatSyncMessage> | null = null;
    const findInConversation = (reference: string) => {
      if (!lookup) {
        lookup = new Map();
        for (const row of rows) {
          if (!lookup.has(row.client_message_id)) lookup.set(row.client_message_id, row);
        }
        // A message id wins over a matching client id.
        for (const row of rows) lookup.set(row.id, row);
      }
      return lookup.get(reference);
    };
    const unreadKeys = new Set<string>();
    for (const row of rows) {
      if (row.conversation_sequence <= lastReadSequence || row.deleted_at) continue;
      const body = chatSyncMessageBody(row);
      if (row.sender_account_id === accountId && !isSelfAgentReply(body)) continue;
      if (isChatSyncThreadMessage(row, findInConversation)) continue;
      const key = chatSyncUnreadKey(row.id, body);
      if (key) unreadKeys.add(key);
    }
    return {
      conversationId: conversation.id,
      sessionId: conversation.legacy_session_id?.trim() || conversation.id,
      latestMessageSequence: conversation.latest_message_sequence,
      lastReadSequence,
      unreadCount: unreadKeys.size,
    };
  });
}
