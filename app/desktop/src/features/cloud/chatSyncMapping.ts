import type { CloudMessage, CloudMessageAttachment, CloudVoiceMessage, SendCloudMessageAttachmentInput } from './authClient';
import type { ChatSyncConversation, ChatSyncMessage } from './chatSyncTypes';
import {
  encodeCloudGroupControl,
  isCloudGroupSessionId,
  parseCloudGroupControl,
  type CloudGroupParticipant,
} from './cloudGroupMessages';
import { parseCloudAgentResponse } from './cloudAgentMessages';
import { normalizedImagePixelDimensions } from '@/lib/imageDimensions';

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

export function chatTextContent(
  body: string,
  attachments: SendCloudMessageAttachmentInput[],
  canonicalHistory?: {
    localMessageId: string;
    originalCreatedAt: string;
  } | null,
  voiceMessage?: CloudVoiceMessage | null,
) {
  return {
    schema: 1,
    blocks: [
      { type: 'text', text: body },
      ...(voiceMessage ? [{
        type: 'voice',
        mediaId: voiceMessage.mediaId,
        mimeType: voiceMessage.mimeType,
        durationMs: voiceMessage.durationMs,
        waveformSamples: voiceMessage.waveformSamples,
        transcript: voiceMessage.transcript,
      }] : []),
    ],
    legacy_attachments: voiceMessage ? [] : attachments,
    ...(canonicalHistory ? {
      canonical_history: {
        local_message_id: canonicalHistory.localMessageId,
        original_created_at: canonicalHistory.originalCreatedAt,
      },
    } : {}),
  };
}

function voiceMessageFromChatContent(content: unknown): CloudVoiceMessage | null {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const blocks = (content as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks)) return null;
  for (const value of blocks) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const block = value as Record<string, unknown>;
    if (block.type !== 'voice') continue;
    const mediaId = typeof block.mediaId === 'string' ? block.mediaId.trim() : '';
    const mimeType = typeof block.mimeType === 'string' ? block.mimeType.trim() : '';
    const transcript = typeof block.transcript === 'string' ? block.transcript.trim() : '';
    const durationMs = typeof block.durationMs === 'number' && Number.isFinite(block.durationMs)
      ? Math.max(0, Math.round(block.durationMs))
      : 0;
    const waveformSamples = Array.isArray(block.waveformSamples)
      ? block.waveformSamples.flatMap((sample) => (
          typeof sample === 'number' && Number.isFinite(sample)
            ? [Math.max(0, Math.min(1, sample))]
            : []
        )).slice(0, 96)
      : [];
    if (!mediaId || !mimeType || durationMs <= 0) return null;
    return { mediaId, mimeType, durationMs, waveformSamples, transcript };
  }
  return null;
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

function textFromChatContent(content: unknown): string {
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

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function groupMessageBody(
  message: ChatSyncMessage,
  conversation: ChatSyncConversation,
  text: string,
): string | null {
  if (conversation.kind !== 'group') return null;
  if (text.trim().startsWith('kordi-cloud-group:')) {
    const envelope = parseCloudGroupControl(text);
    const createdAtMs = Date.parse(message.created_at);
    const groupId = conversation.legacy_session_id?.trim() || conversation.id.trim();
    return envelope?.kind === 'group-message'
      && envelope.message
      && isCloudGroupSessionId(groupId)
      && Number.isFinite(createdAtMs)
      ? encodeCloudGroupControl({
          ...envelope,
          groupId,
          message: { ...envelope.message, createdAtMs },
        })
      : null;
  }

  const participants: CloudGroupParticipant[] = conversation.members
    .filter((member) => member.membership_state === 'active')
    .map((member) => ({
      accountId: member.account_id,
      displayName: member.display_name?.trim() || member.account_id,
      avatarUrl: member.avatar_url?.trim() || null,
      agentId: member.default_agent_id?.trim() || `cloud-agent:${member.account_id}`,
      agentDisplayName: member.default_agent_display_name?.trim() || 'Kordi',
      agentAvatarUrl: member.default_agent_avatar_url?.trim() || null,
      role: member.role,
      joinedAt: member.joined_at,
    }));
  const actor = participants.find(
    (participant) => participant.accountId === message.sender_account_id,
  ) ?? {
    accountId: message.sender_account_id,
    displayName: message.sender_account_id,
    avatarUrl: null,
    role: 'person',
  };
  const groupId = conversation.legacy_session_id?.trim() || conversation.id.trim();
  if (!isCloudGroupSessionId(groupId) || participants.length === 0) return null;
  const agentResponse = parseCloudAgentResponse(text);

  return encodeCloudGroupControl({
    kind: 'group-message',
    groupId,
    groupSpaceId: null,
    groupTitle: conversation.shared_title,
    createdByAccountId: conversation.created_by_account_id,
    actor,
    participants,
    message: {
      id: message.id,
      senderAccountId: message.sender_account_id,
      text: agentResponse?.text ?? text,
      createdAtMs: Date.parse(message.created_at) || Date.now(),
      senderKind: agentResponse ? 'agent' : 'human',
      senderDisplayName: agentResponse
        ? `${actor.displayName}'s Kordi`
        : actor.displayName,
      messageKind: message.kind,
      structuredContent: recordValue(message.content),
      ...(agentResponse ? {
        deliveryState: agentResponse.deliveryState,
        replyToMessageId: agentResponse.requestId,
        requestId: agentResponse.requestId,
      } : {}),
    },
  });
}

function attachmentsFromChatContent(content: unknown): CloudMessageAttachment[] {
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
    const dimensions = normalizedImagePixelDimensions(record.widthPixels, record.heightPixels);
    return [{
      attachmentId,
      name,
      kind,
      ...(record.subtype === 'sticker' && kind === 'image'
        ? { subtype: 'sticker' as const }
        : record.subtype === 'meme' && kind === 'image' ? {
            subtype: 'meme' as const,
            altText: typeof record.altText === 'string' ? record.altText : null,
          } : {}),
      mimeType: typeof record.mimeType === 'string' ? record.mimeType : null,
      sizeBytes: typeof record.sizeBytes === 'number' ? record.sizeBytes : null,
      ...(dimensions ?? {}),
      previewUrl: typeof record.previewUrl === 'string' ? record.previewUrl : null,
    } satisfies CloudMessageAttachment];
  });
}

export function directSessionId(accountId: string, peerAccountId: string): string {
  return `session:direct-person:${[accountId.trim(), peerAccountId.trim()].sort().join(':')}`;
}

export function inferConversationKind(
  accountId: string,
  peerAccountId: string,
  sessionId: string,
): ChatSyncConversation['kind'] {
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

export function conversationPeer(
  conversation: ChatSyncConversation,
  viewerAccountId: string,
  senderAccountId: string,
): string {
  if (senderAccountId !== viewerAccountId) return senderAccountId;
  return conversation.members
    .find((member) => member.account_id !== viewerAccountId && member.membership_state === 'active')
    ?.account_id ?? viewerAccountId;
}

export function cloudMessageFromChatSync(
  message: ChatSyncMessage,
  conversation: ChatSyncConversation,
  viewerAccountId = conversation.preferences.account_id,
): CloudMessage {
  const peerAccountId = conversationPeer(conversation, viewerAccountId, message.sender_account_id);
  const outgoing = message.sender_account_id === viewerAccountId;
  const otherMembers = conversation.members.filter(
    (member) => member.account_id !== viewerAccountId && member.membership_state === 'active',
  );
  const readByAccountIds = otherMembers
    .filter((member) => member.last_read_sequence >= message.conversation_sequence)
    .map((member) => member.account_id)
    .sort();
  const delivered = outgoing
    ? otherMembers.length > 0 && otherMembers.every(
      (member) => member.last_delivered_sequence >= message.conversation_sequence,
    )
    : true;
  const read = outgoing
    ? readByAccountIds.length > 0
    : conversation.members.some(
      (member) => member.account_id === viewerAccountId
        && member.last_read_sequence >= message.conversation_sequence,
    );
  const canonicalHistory = canonicalHistoryMetadata(message.content);
  const createdAt = canonicalHistory?.originalCreatedAt
    ?? message.created_at;
  const text = textFromChatContent(message.content);
  const body = groupMessageBody(message, conversation, text) ?? text;
  return {
    messageId: message.id,
    fromAccountId: message.sender_account_id,
    toAccountId: outgoing ? peerAccountId : viewerAccountId,
    body,
    createdAt,
    deliveredAt: delivered ? createdAt : null,
    readAt: read ? createdAt : null,
    ...(outgoing && conversation.kind === 'group' ? { readByAccountIds } : {}),
    direction: outgoing ? 'outgoing' : 'incoming',
    sessionId: conversation.legacy_session_id ?? conversation.id,
    attachments: attachmentsFromChatContent(message.content),
    voiceMessage: voiceMessageFromChatContent(message.content),
    conversationId: conversation.id,
    conversationSequence: message.conversation_sequence,
    clientMessageId: message.client_message_id,
    messageKind: message.kind,
    canonicalHistoryLocalMessageId:
      canonicalHistory?.localMessageId ?? null,
    version: message.version,
    editedAt: message.edited_at,
    deletedAt: message.deleted_at,
    reactions: (message.reactions ?? []).map((reaction) => ({
      value: reaction.reaction,
      accountIds: reaction.account_ids,
    })),
  };
}

export function chatSyncSessionTitle(conversation: ChatSyncConversation): string {
  const personalTitle = conversation.preferences.personal_title?.trim() ?? '';
  if (personalTitle) return personalTitle;
  if (conversation.kind === 'group') return '';
  return conversation.shared_title?.trim() ?? '';
}
