import type {
  Contact,
  Conversation,
  ConversationParticipant,
  AppendCanonicalMessageRequest,
  CanonicalSessionMessage,
  DesktopBridgeSessionParticipant,
  UpsertCanonicalIdentityRequest,
} from '@/kordi-app/types';

import type { CloudAccount, CloudContactSummary, CloudMessage } from './authClient';
import { CLOUD_PIXEL_AVATAR_URL_PREFIX, cloudAvatarImageUrl, cloudAvatarSeedForAccount } from './avatar';
import { CLOUD_HOST_SENTINEL } from './useCloudContacts';

const CLOUD_GROUP_PREFIX = 'kordi-cloud-group:';
export const CLOUD_GROUP_AGENT_CONVERSATION_PREFIX = 'cloud-group-agent:';

export type CloudGroupControlKind = 'group-invite' | 'group-message' | 'group-update' | 'group-title-update' | 'session-title-update';

export type CloudGroupParticipant = {
  accountId: string;
  displayName: string;
  avatarUrl: string | null;
  role?: 'admin' | 'person' | 'self' | string | null;
};

export type CloudGroupActor = CloudGroupParticipant;

export type CloudGroupControlEnvelope = {
  kind: CloudGroupControlKind;
  groupId: string;
  groupSpaceId?: string | null;
  groupTitle: string | null;
  createdByAccountId: string;
  actor: CloudGroupActor;
  participants: CloudGroupParticipant[];
  message?: {
    id: string;
    senderAccountId: string;
    text: string;
    createdAtMs: number;
    senderKind?: 'human' | 'agent' | null;
    senderDisplayName?: string | null;
    deliveryState?: 'processing' | 'complete' | 'failed' | 'cancelled' | string | null;
    replyToMessageId?: string | null;
    requestId?: string | null;
  } | null;
};

function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function cloudGroupAgentConversationId(groupId: string): string {
  return `${CLOUD_GROUP_AGENT_CONVERSATION_PREFIX}${groupId}`;
}

export function cloudGroupIdFromAgentConversationId(conversationId: string | null | undefined): string | null {
  const value = cleanText(conversationId);
  if (!value.startsWith(CLOUD_GROUP_AGENT_CONVERSATION_PREFIX)) return null;
  const groupId = value.slice(CLOUD_GROUP_AGENT_CONVERSATION_PREFIX.length).trim();
  return groupId || null;
}

export function isCloudGroupAgentConversationId(conversationId: string | null | undefined): boolean {
  return Boolean(cloudGroupIdFromAgentConversationId(conversationId));
}

function pixelAvatarUrlFromSeed(seed?: string | null) {
  const trimmed = cleanText(seed);
  return trimmed ? `${CLOUD_PIXEL_AVATAR_URL_PREFIX}${trimmed}` : null;
}

function uniqueByAccount(participants: CloudGroupParticipant[]) {
  const byAccountId = new Map<string, CloudGroupParticipant>();
  for (const participant of participants) {
    const accountId = cleanText(participant.accountId);
    const displayName = cleanText(participant.displayName) || accountId;
    if (!accountId) continue;
    const avatarUrl = cleanText(participant.avatarUrl) || null;
    const existing = byAccountId.get(accountId);
    if (existing) {
      byAccountId.set(accountId, {
        ...existing,
        displayName: existing.displayName === accountId ? displayName : existing.displayName,
        avatarUrl: existing.avatarUrl || avatarUrl,
        role: existing.role ?? participant.role ?? 'person',
      });
      continue;
    }
    byAccountId.set(accountId, {
      accountId,
      displayName,
      avatarUrl,
      role: participant.role ?? 'person',
    });
  }
  return [...byAccountId.values()];
}

export function cloudGroupUniqueParticipants(participants: CloudGroupParticipant[]): CloudGroupParticipant[] {
  return uniqueByAccount(participants);
}

export type CloudGroupRelatedControl = {
  envelope: CloudGroupControlEnvelope;
  createdAtMs: number;
};

export function cloudGroupRelatedControlsForSend(
  controls: CloudGroupRelatedControl[],
  input: { groupId: string; groupSpaceId?: string | null },
): CloudGroupRelatedControl[] {
  const groupId = cleanText(input.groupId);
  const groupSpaceId = cleanText(input.groupSpaceId);
  const ids = new Set([groupId, groupSpaceId].filter(Boolean));
  if (ids.size === 0) return [];
  return controls.filter(({ envelope }) => {
    const envelopeGroupId = cleanText(envelope.groupId);
    const envelopeGroupSpaceId = cleanText(envelope.groupSpaceId);
    return Boolean((envelopeGroupId && ids.has(envelopeGroupId)) || (envelopeGroupSpaceId && ids.has(envelopeGroupSpaceId)));
  });
}

export function cloudGroupNonGenericTitle(value?: string | null) {
  const title = cleanText(value);
  return title && !/^(#\s*)?(new session|untitled session)$/i.test(title) ? title : null;
}

export function cloudGroupTitleForOutgoingControl(input: {
  kind: CloudGroupControlKind;
  groupTitle?: string | null;
  relatedGroupTitles?: Array<string | null | undefined>;
}) {
  const explicitTitle = cloudGroupNonGenericTitle(input.groupTitle) ?? cleanText(input.groupTitle) ?? null;
  if (input.kind === 'group-message') return null;
  return explicitTitle
    ?? [...(input.relatedGroupTitles ?? [])].reverse().map((title) => cloudGroupNonGenericTitle(title)).find(Boolean)
    ?? null;
}

export function shouldApplyCloudGroupTitleUpdate(input: Pick<CloudGroupControlEnvelope, 'kind' | 'groupTitle'>) {
  return ['group-invite', 'group-update', 'group-title-update'].includes(input.kind) && Boolean(cloudGroupNonGenericTitle(input.groupTitle));
}

export function cloudSessionTitleUpdateTitle(input: Pick<CloudGroupControlEnvelope, 'kind' | 'groupTitle'>) {
  return input.kind === 'session-title-update' ? cloudGroupNonGenericTitle(input.groupTitle) : null;
}

function cloudTitleUpdateNoticeRequest(input: {
  envelope: CloudGroupControlEnvelope;
  actorIdentityId: string;
  createdAtMs: number;
  cloudMessageId: string;
  scope: 'group' | 'session';
  title: string | null;
}): AppendCanonicalMessageRequest | null {
  const title = cloudGroupNonGenericTitle(input.title);
  const actorIdentityId = cleanText(input.actorIdentityId);
  if (!title || !actorIdentityId) return null;
  const actorDisplayName = cleanText(input.envelope.actor.displayName) || 'Someone';
  const cloudMessageId = cleanText(input.cloudMessageId) || `${input.envelope.groupId}:${input.createdAtMs}`;
  const noticeKind = input.scope === 'group' ? 'group-title-update' : 'session-title-update';
  const transport = input.scope === 'group' ? 'cloud-group-title-update' : 'cloud-group-session-title-update';
  return {
    id: `cloud-${input.scope}-title-notice:${cloudMessageId}`,
    sessionId: input.envelope.groupId,
    senderIdentityId: actorIdentityId,
    senderRole: 'system',
    messageKind: 'status',
    contentText: `${actorDisplayName} changed the ${input.scope} name to ${title}`,
    content: {
      kind: noticeKind,
      scope: input.scope,
      title,
      actorDisplayName,
    },
    createdAtMs: input.createdAtMs,
    status: 'complete',
    sourceTransport: transport,
    sourceEventId: `${transport}:${cloudMessageId}`,
  };
}

export function cloudGroupTitleUpdateNoticeRequest(input: {
  envelope: CloudGroupControlEnvelope;
  actorIdentityId: string;
  createdAtMs: number;
  cloudMessageId: string;
}): AppendCanonicalMessageRequest | null {
  return cloudTitleUpdateNoticeRequest({
    ...input,
    scope: 'group',
    title: shouldApplyCloudGroupTitleUpdate(input.envelope) ? input.envelope.groupTitle : null,
  });
}

export function cloudSessionTitleUpdateNoticeRequest(input: {
  envelope: CloudGroupControlEnvelope;
  actorIdentityId: string;
  createdAtMs: number;
  cloudMessageId: string;
}): AppendCanonicalMessageRequest | null {
  return cloudTitleUpdateNoticeRequest({
    ...input,
    scope: 'session',
    title: cloudSessionTitleUpdateTitle(input.envelope),
  });
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeCloudGroupControl(input: CloudGroupControlEnvelope): string {
  const envelope: CloudGroupControlEnvelope = {
    ...input,
    groupId: cleanText(input.groupId),
    groupSpaceId: cleanText(input.groupSpaceId) || null,
    groupTitle: cleanText(input.groupTitle) || null,
    createdByAccountId: cleanText(input.createdByAccountId),
    actor: cloudGroupNormalizeParticipant(input.actor),
    participants: uniqueByAccount(input.participants),
  };
  return `${CLOUD_GROUP_PREFIX}${encodeBase64Url(JSON.stringify(envelope))}`;
}

export function parseCloudGroupControl(body: string): CloudGroupControlEnvelope | null {
  if (!body.startsWith(CLOUD_GROUP_PREFIX)) return null;
  try {
    const parsed = JSON.parse(decodeBase64Url(body.slice(CLOUD_GROUP_PREFIX.length))) as Partial<CloudGroupControlEnvelope>;
    if (!['group-invite', 'group-message', 'group-update', 'group-title-update', 'session-title-update'].includes(parsed.kind ?? '')) return null;
    const kind = parsed.kind as CloudGroupControlKind;
    if (typeof parsed.groupId !== 'string' || !parsed.groupId.trim()) return null;
    if (typeof parsed.createdByAccountId !== 'string' || !parsed.createdByAccountId.trim()) return null;
    if (!parsed.actor || typeof parsed.actor !== 'object') return null;
    if (!Array.isArray(parsed.participants)) return null;
    const actor = cloudGroupNormalizeParticipant(parsed.actor as CloudGroupParticipant);
    const participants = uniqueByAccount(parsed.participants as CloudGroupParticipant[]);
    if (!actor.accountId || participants.length === 0) return null;
    let message: CloudGroupControlEnvelope['message'] = null;
    if (kind === 'group-message') {
      const candidate = parsed.message;
      if (!candidate || typeof candidate !== 'object') return null;
      if (typeof candidate.id !== 'string' || typeof candidate.senderAccountId !== 'string' || typeof candidate.text !== 'string') return null;
      const createdAtMs = typeof candidate.createdAtMs === 'number' && Number.isFinite(candidate.createdAtMs)
        ? candidate.createdAtMs
        : Date.now();
      message = {
        id: candidate.id,
        senderAccountId: candidate.senderAccountId,
        text: candidate.text,
        createdAtMs,
        senderKind: candidate.senderKind === 'agent' ? 'agent' : 'human',
        senderDisplayName: typeof candidate.senderDisplayName === 'string' && candidate.senderDisplayName.trim() ? candidate.senderDisplayName.trim() : null,
        deliveryState: typeof candidate.deliveryState === 'string' && candidate.deliveryState.trim() ? candidate.deliveryState.trim() : null,
        replyToMessageId: typeof candidate.replyToMessageId === 'string' && candidate.replyToMessageId.trim() ? candidate.replyToMessageId.trim() : null,
        requestId: typeof candidate.requestId === 'string' && candidate.requestId.trim() ? candidate.requestId.trim() : null,
      };
    }
    return {
      kind,
      groupId: parsed.groupId.trim(),
      groupSpaceId: typeof parsed.groupSpaceId === 'string' && parsed.groupSpaceId.trim() ? parsed.groupSpaceId.trim() : null,
      groupTitle: typeof parsed.groupTitle === 'string' && parsed.groupTitle.trim() ? parsed.groupTitle.trim() : null,
      createdByAccountId: parsed.createdByAccountId.trim(),
      actor,
      participants,
      message,
    };
  } catch {
    return null;
  }
}

export function isCloudGroupControlMessage(body: string): boolean {
  return Boolean(parseCloudGroupControl(body));
}

export function cloudGroupNormalizeParticipant(participant: CloudGroupParticipant): CloudGroupParticipant {
  const accountId = cleanText(participant.accountId);
  return {
    accountId,
    displayName: cleanText(participant.displayName) || accountId || 'Cloud user',
    avatarUrl: cleanText(participant.avatarUrl) || null,
    role: participant.role ?? 'person',
  };
}

export function cloudGroupSelfParticipant(account: CloudAccount, role: CloudGroupParticipant['role'] = 'admin'): CloudGroupParticipant {
  return {
    accountId: account.accountId,
    displayName: cleanText(account.displayName) || cleanText(account.primaryEmail) || account.accountId,
    avatarUrl: account.avatarUrl,
    role,
  };
}

export function cloudGroupParticipantFromContact(contact: Contact, role: CloudGroupParticipant['role'] = 'person'): CloudGroupParticipant | null {
  const accountId = cleanText(contact.bridgeHumanId) || cleanText(contact.bridgePeerNodeId) || cleanText(contact.id.replace(/^cloud:/, ''));
  if (!accountId) return null;
  return {
    accountId,
    displayName: cleanText(contact.name) || cleanText(contact.owner) || accountId,
    avatarUrl: contact.profileImageUrl ?? pixelAvatarUrlFromSeed(contact.avatarSeed),
    role,
  };
}

export function cloudGroupParticipantFromConversationParticipant(
  participant: ConversationParticipant,
  account: CloudAccount,
): CloudGroupParticipant | null {
  const isSelf = participant.role === 'self' || participant.source === 'local';
  if (isSelf) return cloudGroupSelfParticipant(account, participant.role || 'self');
  const accountId = cleanText(participant.humanId) || cleanText(participant.bridgeNodeId);
  if (!accountId) return null;
  return {
    accountId,
    displayName: cleanText(participant.name) || accountId,
    avatarUrl: participant.profileImageUrl ?? pixelAvatarUrlFromSeed(participant.avatarKey),
    role: participant.role || 'person',
  };
}

export function cloudGroupParticipantsForContacts(account: CloudAccount, contacts: Contact[]): CloudGroupParticipant[] {
  return uniqueByAccount([
    cloudGroupSelfParticipant(account, 'admin'),
    ...contacts.map((contact) => cloudGroupParticipantFromContact(contact)).filter((value): value is CloudGroupParticipant => Boolean(value)),
  ]);
}

export function cloudGroupParticipantsForConversation(
  account: CloudAccount,
  conversation: Pick<Conversation, 'canonicalParticipants'>,
): CloudGroupParticipant[] {
  return uniqueByAccount([
    cloudGroupSelfParticipant(account, 'admin'),
    ...(conversation.canonicalParticipants ?? [])
      .filter((participant) => participant.kind === 'human')
      .map((participant) => cloudGroupParticipantFromConversationParticipant(participant, account))
      .filter((value): value is CloudGroupParticipant => Boolean(value)),
  ]);
}

export function cloudGroupParticipantsForBridgeSessionParticipants(
  account: CloudAccount,
  participants: DesktopBridgeSessionParticipant[],
): CloudGroupParticipant[] {
  return uniqueByAccount([
    cloudGroupSelfParticipant(account, 'admin'),
    ...participants.flatMap((participant): CloudGroupParticipant[] => {
      const accountId = cleanText(participant.humanId) || cleanText(participant.bridgeNodeId);
      if (!accountId) return [];
      return [{
        accountId,
        displayName: cleanText(participant.displayName) || accountId,
        avatarUrl: null,
        role: participant.role || 'person',
      }];
    }),
  ]);
}

export function cloudGroupMessageSessionId(input: {
  activeConvCanonicalSessionId?: string | null;
  activeGroupSessionSpaceId?: string | null;
}): string {
  return cleanText(input.activeConvCanonicalSessionId) || cleanText(input.activeGroupSessionSpaceId);
}

export function shouldCountCloudGroupMessageUnread(input: {
  activeConversationId?: string | null;
  groupId: string;
  groupSpaceId?: string | null;
}): boolean {
  const active = cleanText(input.activeConversationId);
  const sessionId = cleanText(input.groupId);
  const spaceId = cleanText(input.groupSpaceId) || sessionId;
  if (!active) return true;
  return active !== sessionId && active !== spaceId && active !== `group:${spaceId}`;
}

export function cloudGroupAgentResponseTargetAccountIds(input: {
  localAccountId: string;
  envelope: CloudGroupControlEnvelope;
  requestCloudMessage?: Pick<CloudMessage, 'fromAccountId' | 'toAccountId'> | null;
}): string[] {
  const localAccountId = cleanText(input.localAccountId);
  const ids = new Set<string>();
  const add = (value?: string | null) => {
    const accountId = cleanText(value);
    if (accountId && accountId !== localAccountId) ids.add(accountId);
  };
  add(input.requestCloudMessage?.fromAccountId);
  add(input.requestCloudMessage?.toAccountId);
  add(input.envelope.createdByAccountId);
  add(input.envelope.actor.accountId);
  add(input.envelope.message?.senderAccountId);
  for (const participant of input.envelope.participants) add(participant.accountId);
  return [...ids].sort();
}

export function cloudGroupPeerIdsFromMessages(input: {
  accountId: string;
  contactPeerIds: string[];
  messages: CloudMessage[];
}): string[] {
  const accountId = cleanText(input.accountId);
  const peerIds = new Set(input.contactPeerIds.map(cleanText).filter(Boolean));
  if (!accountId) return [...peerIds];
  for (const message of input.messages) {
    if (message.fromAccountId !== accountId && message.toAccountId !== accountId) continue;
    const envelope = parseCloudGroupControl(message.body);
    if (!envelope) continue;
    for (const participant of envelope.participants) {
      const participantId = cleanText(participant.accountId);
      if (participantId && participantId !== accountId) peerIds.add(participantId);
    }
    const actorId = cleanText(envelope.actor.accountId);
    if (actorId && actorId !== accountId) peerIds.add(actorId);
  }
  return [...peerIds].sort();
}

export function cloudGroupControlReplayKey(message: CloudMessage): string | null {
  const envelope = parseCloudGroupControl(message.body);
  if (!envelope) return null;
  if (envelope.kind === 'group-message' && envelope.message?.id) {
    return `${envelope.kind}:${envelope.groupId}:${envelope.message.id}`;
  }
  return `${envelope.kind}:${envelope.groupId}:${message.body}`;
}

export function cloudGroupAgentMentionHasResponse(input: {
  requestMessageId: string;
  targetAccountId: string;
  messages: CanonicalSessionMessage[];
}): boolean {
  const requestMessageId = cleanText(input.requestMessageId);
  const targetAccountId = cleanText(input.targetAccountId);
  if (!requestMessageId || !targetAccountId) return false;
  const targetAgentIdentityId = `agent:cloud:${targetAccountId}`;
  return input.messages.some((message) => {
    if (message.senderIdentityId !== targetAgentIdentityId) return false;
    if (message.sourceTransport !== 'cloud-group-agent') return false;
    const content = objectRecord(message.content);
    const linkedRequestId = cleanText(message.parentMessageId)
      || cleanText(typeof content.requestId === 'string' ? content.requestId : null)
      || cleanText(typeof content.replyToMessageId === 'string' ? content.replyToMessageId : null);
    return linkedRequestId === requestMessageId;
  });
}

export function cloudGroupAgentRequestingNoticeMessage(input: {
  sessionId: string;
  requestMessageId: string;
  targetAccountId: string;
  targetAgentDisplayName?: string | null;
  createdAtMs?: number | null;
  sequenceNum?: number | null;
}): CanonicalSessionMessage {
  const sessionId = cleanText(input.sessionId);
  const requestMessageId = cleanText(input.requestMessageId);
  const targetAccountId = cleanText(input.targetAccountId);
  const targetAgentDisplayName = cleanText(input.targetAgentDisplayName) || 'Kordi';
  const createdAtMs = typeof input.createdAtMs === 'number' && Number.isFinite(input.createdAtMs)
    ? input.createdAtMs
    : Date.now();
  return {
    id: `msg:cloud-agent-offline:${requestMessageId}:${targetAccountId}`,
    sessionId,
    senderIdentityId: `agent:cloud:${targetAccountId}`,
    senderRole: 'external-agent',
    messageKind: 'agent-turn',
    contentText: 'Requesting…',
    content: {
      sender: targetAgentDisplayName,
      timestampMs: createdAtMs,
      deliveryState: 'processing',
      requestId: requestMessageId,
      replyToMessageId: requestMessageId,
    },
    parentMessageId: requestMessageId,
    status: 'processing',
    sequenceNum: typeof input.sequenceNum === 'number' && Number.isFinite(input.sequenceNum) ? input.sequenceNum : 0,
    createdAtMs,
    updatedAtMs: createdAtMs,
    contentHash: null,
    sourceTransport: 'cloud-group-agent-offline',
    sourceEventId: `cloud-group-agent-offline:${requestMessageId}:${targetAccountId}`,
  };
}

export function cloudGroupAgentOfflineNoticeRequest(input: {
  sessionId: string;
  requestMessageId: string;
  targetAccountId: string;
  targetHumanDisplayName?: string | null;
  targetAgentDisplayName?: string | null;
  createdAtMs?: number | null;
}): AppendCanonicalMessageRequest {
  const sessionId = cleanText(input.sessionId);
  const requestMessageId = cleanText(input.requestMessageId);
  const targetAccountId = cleanText(input.targetAccountId);
  const targetHumanDisplayName = cleanText(input.targetHumanDisplayName) || 'The user';
  const targetAgentDisplayName = cleanText(input.targetAgentDisplayName) || `${targetHumanDisplayName}'s Kordi`;
  const createdAtMs = typeof input.createdAtMs === 'number' && Number.isFinite(input.createdAtMs)
    ? input.createdAtMs
    : Date.now();
  const text = `${targetHumanDisplayName} and ${targetAgentDisplayName} are offline.`;
  return {
    id: `msg:cloud-agent-offline:${requestMessageId}:${targetAccountId}`,
    sessionId,
    senderIdentityId: `agent:cloud:${targetAccountId}`,
    senderRole: 'external-agent',
    messageKind: 'agent-turn',
    contentText: '',
    content: {
      sender: targetAgentDisplayName,
      timestampMs: createdAtMs,
      deliveryState: 'failed',
      requestId: requestMessageId,
      replyToMessageId: requestMessageId,
      error: text,
    },
    parentMessageId: requestMessageId,
    status: 'failed',
    createdAtMs,
    sourceTransport: 'cloud-group-agent',
    sourceEventId: `cloud-group-agent-offline:${requestMessageId}:${targetAccountId}`,
  };
}

export function cloudGroupLocalAgentRequestAlreadyHandled(input: {
  localAccountId: string;
  requestMessageId: string;
  messages: CloudMessage[];
}): boolean {
  const localAccountId = cleanText(input.localAccountId);
  const requestMessageId = cleanText(input.requestMessageId);
  if (!localAccountId || !requestMessageId) return false;
  return input.messages.some((message) => {
    if (message.fromAccountId !== localAccountId) return false;
    const envelope = parseCloudGroupControl(message.body);
    const groupMessage = envelope?.kind === 'group-message' ? envelope.message : null;
    if (!groupMessage || groupMessage.senderAccountId !== localAccountId || groupMessage.senderKind !== 'agent') return false;
    const linkedRequestId = cleanText(groupMessage.requestId) || cleanText(groupMessage.replyToMessageId);
    return linkedRequestId === requestMessageId;
  });
}

export function cloudGroupControlMessagesForAccount(input: {
  accountId: string;
  messages: CloudMessage[];
}): CloudMessage[] {
  const accountId = cleanText(input.accountId);
  if (!accountId) return [];
  const seen = new Set<string>();
  const result: CloudMessage[] = [];
  for (const message of input.messages) {
    if (message.fromAccountId !== accountId && message.toAccountId !== accountId) continue;
    const replayKey = cloudGroupControlReplayKey(message);
    if (!replayKey || seen.has(replayKey)) continue;
    seen.add(replayKey);
    result.push(message);
  }
  return result;
}

export function cloudGroupPeerIdsFromContactsAndRequests(input: {
  accountId: string;
  contactPeerIds: string[];
  contacts?: Array<Pick<CloudContactSummary, 'accountId'>>;
  requests?: Array<{ requesterNodeId?: string | null; targetNodeId?: string | null }>;
}): string[] {
  const accountId = cleanText(input.accountId);
  const peerIds = new Set(input.contactPeerIds.map(cleanText).filter(Boolean));
  for (const contact of input.contacts ?? []) {
    const peerId = cleanText(contact.accountId);
    if (peerId && peerId !== accountId) peerIds.add(peerId);
  }
  for (const request of input.requests ?? []) {
    const requesterId = cleanText(request.requesterNodeId);
    const targetId = cleanText(request.targetNodeId);
    const peerId = requesterId === accountId ? targetId : requesterId;
    if (peerId && peerId !== accountId) peerIds.add(peerId);
  }
  return [...peerIds].sort();
}

export function cloudGroupMessageReadPeerIds(input: {
  accountId: string;
  activeConversationId?: string | null;
  messages: CloudMessage[];
}): string[] {
  const accountId = cleanText(input.accountId);
  const peerIds = new Set<string>();
  if (!accountId) return [];
  for (const message of input.messages) {
    if (message.toAccountId !== accountId || message.direction !== 'incoming' || message.readAt) continue;
    const envelope = parseCloudGroupControl(message.body);
    if (!envelope || envelope.kind !== 'group-message') continue;
    if (shouldCountCloudGroupMessageUnread({
      activeConversationId: input.activeConversationId,
      groupId: envelope.groupId,
      groupSpaceId: envelope.groupSpaceId,
    })) continue;
    const peerId = cleanText(message.fromAccountId);
    if (peerId) peerIds.add(peerId);
  }
  return [...peerIds].sort();
}

export function cloudGroupUnreadCountsBySessionId(input: {
  accountId: string;
  activeConversationId?: string | null;
  messages: CloudMessage[];
}): Record<string, number> {
  const accountId = cleanText(input.accountId);
  if (!accountId) return {};
  const counts: Record<string, number> = {};
  const seenGroupMessageIds = new Set<string>();
  for (const message of input.messages) {
    if (message.toAccountId !== accountId || message.direction !== 'incoming' || message.readAt) continue;
    const envelope = parseCloudGroupControl(message.body);
    if (!envelope || envelope.kind !== 'group-message') continue;
    if (!shouldCountCloudGroupMessageUnread({
      activeConversationId: input.activeConversationId,
      groupId: envelope.groupId,
      groupSpaceId: envelope.groupSpaceId,
    })) continue;
    const sessionId = cleanText(envelope.groupId);
    if (!sessionId) continue;
    const groupMessageId = cleanText(envelope.message?.id) || cleanText(message.messageId);
    const unreadKey = `${sessionId}:${groupMessageId}`;
    if (seenGroupMessageIds.has(unreadKey)) continue;
    seenGroupMessageIds.add(unreadKey);
    counts[sessionId] = (counts[sessionId] ?? 0) + 1;
  }
  return counts;
}

export type CloudGroupDeliveryState = 'delivered' | 'read';

export function cloudGroupDeliveryStateFromMessages(input: {
  accountId: string;
  messageId: string;
  messages: CloudMessage[];
}): CloudGroupDeliveryState | null {
  const accountId = cleanText(input.accountId);
  const messageId = cleanText(input.messageId);
  if (!accountId || !messageId) return null;

  const matching = input.messages.filter((message) => {
    if (message.fromAccountId !== accountId || message.direction !== 'outgoing') return false;
    const envelope = parseCloudGroupControl(message.body);
    return envelope?.kind === 'group-message' && envelope.message?.id === messageId;
  });
  if (matching.length === 0) return null;
  if (matching.every((message) => Boolean(message.readAt))) return 'read';
  return 'delivered';
}

export function shouldRouteMentionThroughCloudGroup(input: {
  mentionedHostId?: string | null;
  activeGroupSessionIsGroup: boolean;
  mentionsLocalAgent?: boolean;
  mentionsBridgeAgent?: boolean;
  hasCloudGroupRecipients?: boolean;
}): boolean {
  if (!input.activeGroupSessionIsGroup) return false;
  if (cleanText(input.mentionedHostId) === CLOUD_HOST_SENTINEL) return true;
  if (input.mentionsLocalAgent === true) return true;
  return input.mentionsBridgeAgent === true && input.hasCloudGroupRecipients === true;
}

export function cloudGroupTargetAccountIds<T extends { hostId?: string | null; nodeId?: string | null }>(targets: T[]): string[] {
  return [...new Set(targets
    .filter((target) => target.hostId === CLOUD_HOST_SENTINEL)
    .map((target) => cleanText(target.nodeId))
    .filter(Boolean))];
}

export function nonCloudGroupTargets<T extends { hostId?: string | null }>(targets: T[]): T[] {
  return targets.filter((target) => target.hostId !== CLOUD_HOST_SENTINEL);
}

export function fulfilledCloudGroupSends<T>(results: PromiseSettledResult<T>[]): T[] {
  return results
    .filter((result): result is PromiseFulfilledResult<T> => result.status === 'fulfilled')
    .map((result) => result.value);
}

export function firstCloudGroupSendFailure(results: PromiseSettledResult<unknown>[]): unknown {
  return results.find((result): result is PromiseRejectedResult => result.status === 'rejected')?.reason;
}

export function cloudGroupIdentityRequest(
  participant: CloudGroupParticipant,
  account: CloudAccount,
  localHumanIdentityId: string,
): UpsertCanonicalIdentityRequest {
  const isSelf = participant.accountId === account.accountId;
  const id = isSelf ? localHumanIdentityId : `human:${participant.accountId}`;
  return {
    id,
    kind: 'human',
    displayName: participant.displayName,
    source: isSelf ? 'local' : 'bridge',
    sourceHostId: isSelf ? null : CLOUD_HOST_SENTINEL,
    bridgeNodeId: isSelf ? null : participant.accountId,
    humanId: participant.accountId,
    agentId: null,
    avatarKey: cloudAvatarSeedForAccount(participant.accountId, participant.avatarUrl),
    profileImageUrl: cloudAvatarImageUrl(participant.avatarUrl),
    metadata: {
      accountId: participant.accountId,
      cloudGroupParticipant: true,
    },
  };
}
