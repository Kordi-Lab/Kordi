import type {
  Contact,
  Conversation,
  ConversationParticipant,
  DesktopBridgeSessionParticipant,
  UpsertCanonicalIdentityRequest,
} from '@/kordi-app/types';

import type { CloudAccount, CloudContactSummary, CloudMessage } from './authClient';
import { CLOUD_PIXEL_AVATAR_URL_PREFIX, cloudAvatarImageUrl, cloudAvatarSeedForAccount } from './avatar';
import { CLOUD_HOST_SENTINEL } from './useCloudContacts';

const CLOUD_GROUP_PREFIX = 'kordi-cloud-group:';
export const CLOUD_GROUP_AGENT_CONVERSATION_PREFIX = 'cloud-group-agent:';

export type CloudGroupControlKind = 'group-invite' | 'group-message' | 'group-update' | 'group-title-update';

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
    replyToMessageId?: string | null;
    requestId?: string | null;
  } | null;
};

function cleanText(value?: string | null) {
  return (value ?? '').trim();
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
    if (!['group-invite', 'group-message', 'group-update', 'group-title-update'].includes(parsed.kind ?? '')) return null;
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
}): boolean {
  return input.activeGroupSessionIsGroup && (cleanText(input.mentionedHostId) === CLOUD_HOST_SENTINEL || input.mentionsLocalAgent === true);
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
