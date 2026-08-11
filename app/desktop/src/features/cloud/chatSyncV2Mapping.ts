import type { CloudMessage, CloudMessageAttachment, SendCloudMessageAttachmentInput } from './authClient';
import type { ChatSyncV2Conversation, ChatSyncV2Message } from './chatSyncV2Types';

function decodeBase64UrlJson<T>(value: string): T | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character: string) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}


function randomUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // Test and older WebView fallback. UUID uniqueness, rather than secrecy, is
  // required for operation identity.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (token) => {
    const random = Math.floor(Math.random() * 16);
    const value = token === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export function cloudOperationUuid(value?: string | null): string {
  const normalized = value?.trim() ?? '';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    return normalized.toLowerCase();
  }
  if (!normalized) return randomUuid();
  let seed = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    seed ^= normalized.charCodeAt(index);
    seed = Math.imul(seed, 0x01000193);
  }
  const bytes = new Uint8Array(16);
  let state = seed >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function v2TextContent(
  body: string,
  attachments: SendCloudMessageAttachmentInput[],
  canonicalHistory?: {
    localMessageId: string;
    originalCreatedAt: string;
  } | null,
) {
  return {
    schema: 1,
    blocks: [{ type: 'text', text: body }],
    legacy_attachments: attachments,
    ...(canonicalHistory ? {
      canonical_history: {
        local_message_id: canonicalHistory.localMessageId,
        original_created_at: canonicalHistory.originalCreatedAt,
      },
    } : {}),
  };
}

function canonicalHistoryMetadata(content: unknown): {
  localMessageId: string;
  originalCreatedAt: string;
} | null {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return null;
  }
  const history = (content as { canonical_history?: unknown })
    .canonical_history;
  if (!history || typeof history !== 'object' || Array.isArray(history)) {
    return null;
  }
  const record = history as {
    local_message_id?: unknown;
    original_created_at?: unknown;
  };
  const localMessageId = typeof record.local_message_id === 'string'
    ? record.local_message_id.trim()
    : '';
  const value = record
    .original_created_at;
  if (!localMessageId || typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? {
        localMessageId,
        originalCreatedAt: new Date(parsed).toISOString(),
      }
    : null;
}

function textFromV2Content(content: unknown): string {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return '';
  const blocks = (content as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((block) => (
      block && typeof block === 'object' && !Array.isArray(block)
        && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : ''
    ))
    .join('');
}

function attachmentsFromV2Content(content: unknown): CloudMessageAttachment[] {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return [];
  const attachments = (content as { legacy_attachments?: unknown }).legacy_attachments;
  if (!Array.isArray(attachments)) return [];
  return attachments.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const attachmentId = typeof record.attachmentId === 'string' ? record.attachmentId.trim() : '';
    const name = typeof record.name === 'string' ? record.name : '';
    const kind = record.kind === 'image' ? 'image' : record.kind === 'file' ? 'file' : null;
    if (!attachmentId || !kind) return [];
    return [{
      attachmentId,
      name,
      kind,
      mimeType: typeof record.mimeType === 'string' ? record.mimeType : null,
      sizeBytes: typeof record.sizeBytes === 'number' ? record.sizeBytes : null,
      previewUrl: typeof record.previewUrl === 'string' ? record.previewUrl : null,
    } satisfies CloudMessageAttachment];
  });
}

export function directSessionId(accountId: string, peerAccountId: string): string {
  return `session:direct-person:${[accountId.trim(), peerAccountId.trim()].sort().join(':')}`;
}

export function inferV2ConversationKind(
  accountId: string,
  peerAccountId: string,
  sessionId: string,
): ChatSyncV2Conversation['kind'] {
  if (accountId === peerAccountId) return 'ai';
  if (sessionId.startsWith('session:group:') || sessionId.startsWith('group:')) return 'group';
  return 'direct';
}

export function groupMemberAccountIdsFromEnvelope(body: string): string[] | null {
  const encoded = body.trim().startsWith('kordi-cloud-group:')
    ? body.trim().slice('kordi-cloud-group:'.length)
    : '';
  if (!encoded) return null;
  const envelope = decodeBase64UrlJson<{ participants?: Array<{ accountId?: unknown }> }>(encoded);
  if (!Array.isArray(envelope?.participants)) return null;
  return [...new Set(envelope.participants.flatMap((participant) => (
    typeof participant?.accountId === 'string' && participant.accountId.trim()
      ? [participant.accountId.trim()]
      : []
  )))];
}

export function v2ConversationPeer(
  conversation: ChatSyncV2Conversation,
  viewerAccountId: string,
  senderAccountId: string,
): string {
  if (senderAccountId !== viewerAccountId) return senderAccountId;
  return conversation.members
    .find((member) => member.account_id !== viewerAccountId && member.membership_state === 'active')
    ?.account_id ?? viewerAccountId;
}

export function cloudMessageFromChatSyncV2(
  message: ChatSyncV2Message,
  conversation: ChatSyncV2Conversation,
  viewerAccountId = conversation.preferences.account_id,
): CloudMessage {
  const peerAccountId = v2ConversationPeer(conversation, viewerAccountId, message.sender_account_id);
  const outgoing = message.sender_account_id === viewerAccountId;
  const otherMembers = conversation.members.filter((member) => member.account_id !== viewerAccountId);
  const delivered = outgoing
    ? otherMembers.length > 0 && otherMembers.every(
      (member) => member.last_delivered_sequence >= message.conversation_sequence,
    )
    : true;
  const read = outgoing
    ? otherMembers.some(
      (member) => member.last_read_sequence >= message.conversation_sequence,
    )
    : conversation.members.some(
      (member) => member.account_id === viewerAccountId
        && member.last_read_sequence >= message.conversation_sequence,
    );
  const canonicalHistory = canonicalHistoryMetadata(message.content);
  const createdAt = canonicalHistory?.originalCreatedAt
    ?? message.created_at;
  return {
    messageId: message.id,
    fromAccountId: message.sender_account_id,
    toAccountId: outgoing ? peerAccountId : viewerAccountId,
    body: textFromV2Content(message.content),
    createdAt,
    deliveredAt: delivered ? createdAt : null,
    readAt: read ? createdAt : null,
    direction: outgoing ? 'outgoing' : 'incoming',
    sessionId: conversation.legacy_session_id ?? conversation.id,
    attachments: attachmentsFromV2Content(message.content),
    conversationId: conversation.id,
    conversationSequence: message.conversation_sequence,
    clientMessageId: message.client_message_id,
    messageKind: message.kind,
    canonicalHistoryLocalMessageId:
      canonicalHistory?.localMessageId ?? null,
    version: message.version,
  };
}

export function chatSyncV2SessionTitle(conversation: ChatSyncV2Conversation): string {
  const personalTitle = conversation.preferences.personal_title?.trim() ?? '';
  if (personalTitle) return personalTitle;
  if (conversation.kind === 'group') return '';
  return conversation.shared_title?.trim() ?? '';
}
