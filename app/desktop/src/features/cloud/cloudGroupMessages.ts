import type {
  Contact,
  Conversation,
  ConversationParticipant,
  AppendCanonicalMessageRequest,
  CanonicalIdentity,
  CanonicalSession,
  CanonicalSessionMessage,
  DesktopCollaborationSessionParticipant,
} from '@/kordi-app/types';
import { groupMentionTargetIdentityId, normalizedMessageMentions } from '@/features/chat/messageMentions';
import type { MessageActionMetadata, MessageMention, MessageVoiceDraft } from '@/kordi-app/types/message';
import { isExplicitPlaceholderSessionTitle } from '@/features/chat/sessionTitlePolicy';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import {
  cloudGroupAttachmentReferences,
  type CloudGroupAttachmentReferenceInput,
} from './cloudGroupAttachmentReferences';
import { cloudGroupMessageRuntimeFields, cloudVoiceAttachmentReference, integerMilliseconds } from './cloudGroupDecoding';
import { cloudMessageActionFromRecord } from './cloudMessageActionCodec';
import { cloudMessageAttachmentsFromRecord } from './cloudGroupAttachmentCodec';
import { cloudGroupMessageIsUnreadForAccount } from './cloudGroupUnreadPolicy';
import type { CloudAccount, CloudContactSummary, CloudMessage, CloudMessageAttachment, CloudPublicProfile } from './authClient';
import type { IndexedCloudGroupRow } from './cloudMessageIndex';
import { cloudAccountIdOrNull, isCloudAccountId, rejectNonCloudCollaborationTargets } from './cloudTransportGuards';
import { CLOUD_HOST_SENTINEL } from './cloudContactMapping';
import { normalizeKordiId } from './kordiId';
import { canonicalAvatarImageSource } from './canonicalAvatar';
import { cloudAgentCanonicalIdentityId } from './cloudAgentIdentity';
export { cloudGroupAgentMentionHasResponse, cloudGroupAgentMentionResponseState } from './cloudGroupAgentResponseState';
export type { CloudGroupAgentMentionResponseState } from './cloudGroupAgentResponseState';
import { cloudGroupTransportParticipant, type CloudGroupActor, type CloudGroupParticipant } from './cloudGroupParticipantTypes';
const CLOUD_GROUP_PREFIX = 'kordi-cloud-group:'; const CLOUD_GROUP_MEMBER_JOIN_EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
export const CLOUD_GROUP_AGENT_CONVERSATION_PREFIX = 'cloud-group-agent:';
export type CloudGroupControlKind = 'group-invite' | 'group-message' | 'group-update' | 'group-title-update' | 'session-title-update' | 'session-fork';

export type { CloudGroupActor, CloudGroupParticipant } from './cloudGroupParticipantTypes';

export { cloudGroupIdentityRequest } from './cloudGroupIdentity';

export type CloudGroupMemberJoin = {
  eventId: string;
  accountId: string;
  displayName: string;
  createdAtMs: number;
};

export type CloudGroupMemberLeave = {
  eventId: string;
  accountId: string;
  createdAtMs: number;
};

export type CloudGroupSessionTitleSnapshot = {
  title: string;
  titleSource: 'manual';
  titleRevision: number;
  titlePolicyVersion: number;
  updatedAtMs: number;
  updatedByAccountId: string;
};

export type CloudGroupControlEnvelope = {
  kind: CloudGroupControlKind;
  groupId: string;
  groupSpaceId?: string | null;
  groupTitle: string | null;
  createdByAccountId: string;
  actor: CloudGroupActor;
  participants: CloudGroupParticipant[];
  sessionTitle?: CloudGroupSessionTitleSnapshot | null;
  sessionTitleSyncOnly?: boolean;
  memberJoins?: CloudGroupMemberJoin[];
  memberLeaves?: CloudGroupMemberLeave[];
  fork?: {
    forkSessionId: string;
    parentSessionId: string;
    parentMessageId?: string | null;
    createdAtMs?: number | null;
  } | null;
  message?: ({
    id: string;
    senderAccountId: string;
    text: string;
    createdAtMs: number;
    senderKind?: 'human' | 'agent' | null;
    senderAgentId?: string | null;
    senderDisplayName?: string | null;
    deliveryState?: 'processing' | 'complete' | 'failed' | 'cancelled' | string | null;
    replyToMessageId?: string | null;
    requestId?: string | null;
    forkSnapshot?: boolean | null;
    attachments?: CloudMessageAttachment[];
    mentions?: MessageMention[];
    messageAction?: MessageActionMetadata | null;
    targetCloudAgentId?: string | null;
    targetCloudAgentName?: string | null;
    targetCloudAgentOwnerAccountId?: string | null;
    targetCloudAgentOwnerName?: string | null;
    agentMentionDepth?: number | null;
    agentRuntimeRoute?: DesktopChatMessageRoute | null; voiceMessage?: (MessageVoiceDraft & { mediaId?: string | null }) | null;
  } & ReturnType<typeof cloudGroupMessageRuntimeFields>) | null;
};
export { cloudGroupAttachmentReferences } from './cloudGroupAttachmentReferences';

export function cloudGroupControlWithAttachmentReferences(
  body: string,
  attachments: readonly CloudGroupAttachmentReferenceInput[],
): string {
  const envelope = parseCloudGroupControl(body);
  if (!envelope?.message) {
    throw new Error('Cloud group outbox envelope has no message payload.');
  }
  return encodeCloudGroupControl({
    ...envelope,
    message: {
      ...envelope.message, attachments: envelope.message.voiceMessage ? undefined : cloudGroupAttachmentReferences(attachments),
      ...cloudVoiceAttachmentReference(envelope.message.voiceMessage, attachments[0]),
    },
  });
}

function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveInteger(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

export function normalizeCloudGroupSessionTitleSnapshot(
  value: unknown,
): CloudGroupSessionTitleSnapshot | null {
  const record = objectRecord(value);
  const title = cloudGroupNonGenericTitle(typeof record.title === 'string' ? record.title : null);
  const updatedByAccountId = cloudAccountIdOrNull(
    typeof record.updatedByAccountId === 'string' ? record.updatedByAccountId : null,
  );
  const updatedAtMs = typeof record.updatedAtMs === 'number' && Number.isFinite(record.updatedAtMs)
    ? Math.floor(record.updatedAtMs)
    : 0;
  if (!title || record.titleSource !== 'manual' || !updatedByAccountId || updatedAtMs <= 0) return null;
  return {
    title,
    titleSource: 'manual',
    titleRevision: positiveInteger(record.titleRevision, 1),
    titlePolicyVersion: positiveInteger(record.titlePolicyVersion, 1),
    updatedAtMs,
    updatedByAccountId,
  };
}

export function cloudGroupManualSessionTitleSnapshot(input: {
  session?: Pick<CanonicalSession, 'title' | 'metadata' | 'createdByIdentityId' | 'updatedAtMs'> | null;
  identities?: Array<Pick<CanonicalIdentity, 'id' | 'humanId' | 'sourceIdentityId'>>;
}): CloudGroupSessionTitleSnapshot | null {
  const session = input.session;
  if (!session) return null;
  const metadata = objectRecord(session.metadata);
  if (cleanText(typeof metadata.sessionTitleSource === 'string' ? metadata.sessionTitleSource : null).toLowerCase() !== 'manual') {
    return null;
  }
  const identityById = new Map((input.identities ?? []).map((identity) => [identity.id, identity]));
  const creatorIdentityId = cleanText(
    typeof metadata.groupCreatorIdentityId === 'string'
      ? metadata.groupCreatorIdentityId
      : session.createdByIdentityId,
  );
  const creatorIdentity = identityById.get(creatorIdentityId);
  const fallbackCreatorAccountId = cloudAccountIdOrNull(creatorIdentity?.humanId)
    ?? cloudAccountIdOrNull(creatorIdentity?.sourceIdentityId)
    ?? cloudAccountIdOrNull(creatorIdentityId.replace(/^human:/, ''));
  return normalizeCloudGroupSessionTitleSnapshot({
    title: session.title,
    titleSource: 'manual',
    titleRevision: metadata.sessionTitleRevision,
    titlePolicyVersion: metadata.sessionTitlePolicyVersion,
    updatedAtMs: typeof metadata.sessionTitleUpdatedAtMs === 'number'
      ? metadata.sessionTitleUpdatedAtMs
      : session.updatedAtMs,
    updatedByAccountId: cloudAccountIdOrNull(
      typeof metadata.sessionTitleUpdatedByAccountId === 'string'
        ? metadata.sessionTitleUpdatedByAccountId
        : null,
    ) ?? fallbackCreatorAccountId,
  });
}

function cloudGroupMemberJoins(value: unknown): CloudGroupMemberJoin[] {
  if (!Array.isArray(value)) return [];
  const seenEventIds = new Set<string>();
  const joins: CloudGroupMemberJoin[] = [];
  value.forEach((candidate) => {
    const record = objectRecord(candidate);
    const eventId = cleanText(typeof record.eventId === 'string' ? record.eventId : null);
    const accountId = cleanText(typeof record.accountId === 'string' ? record.accountId : null);
    const displayName = cleanText(typeof record.displayName === 'string' ? record.displayName : null);
    const createdAtMs = integerMilliseconds(record.createdAtMs);
    if (!CLOUD_GROUP_MEMBER_JOIN_EVENT_ID_PATTERN.test(eventId)
      || !isCloudAccountId(accountId)
      || createdAtMs === null
      || seenEventIds.has(eventId)) return;
    seenEventIds.add(eventId);
    joins.push({
      eventId,
      accountId,
      displayName: displayName || accountId,
      createdAtMs,
    });
  });
  return joins;
}

function cloudGroupMemberLeaves(value: unknown): CloudGroupMemberLeave[] {
  if (!Array.isArray(value)) return [];
  const seenEventIds = new Set<string>();
  const leaves: CloudGroupMemberLeave[] = [];
  value.forEach((candidate) => {
    const record = objectRecord(candidate);
    const eventId = cleanText(typeof record.eventId === 'string' ? record.eventId : null);
    const accountId = cleanText(typeof record.accountId === 'string' ? record.accountId : null);
    const createdAtMs = integerMilliseconds(record.createdAtMs);
    if (!CLOUD_GROUP_MEMBER_JOIN_EVENT_ID_PATTERN.test(eventId)
      || !isCloudAccountId(accountId)
      || createdAtMs === null
      || seenEventIds.has(eventId)) return;
    seenEventIds.add(eventId);
    leaves.push({ eventId, accountId, createdAtMs });
  });
  return leaves;
}

export function cloudGroupForkPayloadFromSessionMetadata(
  metadata: unknown,
  forkSessionId: string,
): NonNullable<CloudGroupControlEnvelope['fork']> | null {
  const forkSessionIdValue = cleanText(forkSessionId);
  const forkRecord = objectRecord(objectRecord(metadata).fork);
  const parentSessionId = cleanText(typeof forkRecord.forkedFromSessionId === 'string' ? forkRecord.forkedFromSessionId : null);
  if (!forkSessionIdValue || !parentSessionId) return null;
  const parentMessageId = cleanText(typeof forkRecord.forkedFromMessageId === 'string' ? forkRecord.forkedFromMessageId : null);
  const createdAtMs = integerMilliseconds(forkRecord.createdAtMs);
  return {
    forkSessionId: forkSessionIdValue,
    parentSessionId,
    parentMessageId: parentMessageId || null,
    createdAtMs,
  };
}

export function isCloudGroupSessionId(value?: string | null): boolean {
  const sessionId = cleanText(value);
  return Boolean(sessionId) && !sessionId.startsWith('session:direct-');
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

function cloudAvatarUrlForLimit(value: string | null | undefined, maxDataUrlLength: number): string | null {
  const url = cleanText(value);
  if (!url) return null;
  if (url.startsWith('kordi-avatar://') || /^https?:\/\//i.test(url)) return url.length <= 4096 ? url : null;
  if (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(url)) return null;
  return url.length <= maxDataUrlLength ? url : null;
}

function syncableCloudGroupAvatarUrl(value?: string | null): string | null {
  return cloudAvatarUrlForLimit(value, 4096);
}

function storedCloudProfileAvatarUrl(value?: string | null): string | null {
  return cloudAvatarUrlForLimit(value, 256 * 1024);
}

function uniqueByAccount(
  participants: CloudGroupParticipant[],
  avatarUrlForParticipant: (value?: string | null) => string | null = syncableCloudGroupAvatarUrl,
) {
  const byAccountId = new Map<string, CloudGroupParticipant>();
  for (const participant of participants) {
    const accountId = cloudAccountIdOrNull(participant.accountId) ?? '';
    const displayName = cleanText(participant.displayName) || accountId;
    if (!accountId) continue;
    const avatarUrl = avatarUrlForParticipant(participant.avatarUrl);
    const existing = byAccountId.get(accountId);
    if (existing) {
      const kordiId = existing.kordiId || normalizeKordiId(participant.kordiId);
      byAccountId.set(accountId, {
        ...existing,
        ...(kordiId ? { kordiId } : {}),
        displayName: existing.displayName === accountId ? displayName : existing.displayName,
        avatarUrl: existing.avatarUrl || avatarUrl,
        role: existing.role ?? participant.role ?? 'person',
        ...((existing.joinedAt || participant.joinedAt)
          ? { joinedAt: existing.joinedAt || participant.joinedAt }
          : {}),
      });
      continue;
    }
    const kordiId = normalizeKordiId(participant.kordiId);
    byAccountId.set(accountId, {
      accountId,
      ...(kordiId ? { kordiId } : {}),
      displayName,
      avatarUrl,
      role: participant.role ?? 'person',
      ...(participant.joinedAt ? { joinedAt: participant.joinedAt } : {}),
    });
  }
  return [...byAccountId.values()];
}


export function cloudGroupUniqueParticipants(participants: CloudGroupParticipant[]): CloudGroupParticipant[] {
  return uniqueByAccount(participants);
}

export function cloudGroupOutgoingParticipantSnapshot(input: {
  currentParticipants: CloudGroupParticipant[];
  historicalParticipants: CloudGroupParticipant[];
  hasExplicitCurrentSnapshot: boolean;
}): CloudGroupParticipant[] {
  return uniqueByAccount(input.hasExplicitCurrentSnapshot
    ? input.currentParticipants
    : [...input.currentParticipants, ...input.historicalParticipants]);
}

export function cloudGroupParticipantsWithProfiles(
  participants: CloudGroupParticipant[],
  profiles: Pick<CloudPublicProfile, 'accountId' | 'kordiId' | 'displayName' | 'avatarUrl' | 'defaultAgent'>[],
): CloudGroupParticipant[] {
  const profileByAccountId = new Map(profiles.map((profile) => [profile.accountId, profile]));
  return uniqueByAccount(participants.map((participant) => {
    const profile = profileByAccountId.get(participant.accountId);
    if (!profile) return participant;
    const kordiId = normalizeKordiId(profile.kordiId) || normalizeKordiId(participant.kordiId);
    return {
      ...participant,
      ...(kordiId ? { kordiId } : {}),
      displayName: cleanText(profile.displayName) || participant.displayName,
      avatarUrl: storedCloudProfileAvatarUrl(profile.avatarUrl) || participant.avatarUrl,
      agentId: profile.defaultAgent?.agentId ?? participant.agentId,
      agentDisplayName: profile.defaultAgent?.displayName ?? participant.agentDisplayName,
      agentAvatarUrl: storedCloudProfileAvatarUrl(profile.defaultAgent?.avatarUrl) || participant.agentAvatarUrl,
      agentAvatarSeed: profile.defaultAgent?.avatar.seed ?? participant.agentAvatarSeed,
    };
  }), storedCloudProfileAvatarUrl);
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
  return title && !isExplicitPlaceholderSessionTitle(title) ? title : null;
}

export function cloudGroupTitleForOutgoingControl(input: {
  kind: CloudGroupControlKind;
  groupTitle?: string | null;
  relatedGroupTitles?: Array<string | null | undefined>;
}) {
  if (input.kind === 'group-message') return null;
  if (input.kind === 'group-title-update' || input.kind === 'session-title-update') {
    return cloudGroupNonGenericTitle(input.groupTitle);
  }
  const explicitTitle = cloudGroupNonGenericTitle(input.groupTitle) ?? cleanText(input.groupTitle) ?? null;
  return explicitTitle
    ?? [...(input.relatedGroupTitles ?? [])].reverse().map((title) => cloudGroupNonGenericTitle(title)).find(Boolean)
    ?? null;
}

export function shouldApplyCloudGroupTitleUpdate(input: Pick<CloudGroupControlEnvelope, 'kind' | 'groupTitle'>) {
  return ['group-invite', 'group-update', 'group-title-update'].includes(input.kind) && Boolean(cloudGroupNonGenericTitle(input.groupTitle));
}

export function cloudGroupAdminAccountIds(
  envelope: Pick<CloudGroupControlEnvelope, 'kind' | 'createdByAccountId' | 'participants'>,
) {
  if (!['group-invite', 'group-update'].includes(envelope.kind)) return [];
  return [...new Set([
    cleanText(envelope.createdByAccountId),
    ...envelope.participants
      .filter((participant) => participant.role === 'admin')
      .map((participant) => cleanText(participant.accountId)),
  ].filter(Boolean))];
}

export function cloudSessionTitleUpdateTitle(input: Pick<CloudGroupControlEnvelope, 'kind' | 'groupTitle'>) {
  return input.kind === 'session-title-update' ? cloudGroupNonGenericTitle(input.groupTitle) : null;
}

export function cloudGroupSessionTitleSnapshotForControl(
  envelope: Pick<CloudGroupControlEnvelope, 'kind' | 'groupTitle' | 'actor' | 'sessionTitle'>,
  controlCreatedAtMs: number,
): CloudGroupSessionTitleSnapshot | null {
  const snapshot = normalizeCloudGroupSessionTitleSnapshot(envelope.sessionTitle);
  if (snapshot) return snapshot;
  const legacyTitle = cloudSessionTitleUpdateTitle(envelope);
  if (!legacyTitle) return null;
  return normalizeCloudGroupSessionTitleSnapshot({
    title: legacyTitle,
    titleSource: 'manual',
    titleRevision: 1,
    titlePolicyVersion: 1,
    updatedAtMs: controlCreatedAtMs,
    updatedByAccountId: envelope.actor.accountId,
  });
}

function cloudTitleUpdateNoticeRequest(input: {
  envelope: CloudGroupControlEnvelope;
  actorIdentityId: string;
  actorDisplayName?: string | null;
  createdAtMs: number;
  cloudMessageId: string;
  scope: 'group' | 'session';
  title: string | null;
}): AppendCanonicalMessageRequest | null {
  const title = cloudGroupNonGenericTitle(input.title);
  const actorIdentityId = cleanText(input.actorIdentityId);
  if (!title || !actorIdentityId) return null;
  const actorDisplayName = cleanText(input.actorDisplayName ?? input.envelope.actor.displayName) || 'Someone';
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
      ...(input.scope === 'group' ? { sourceControlKind: 'group-title-update' } : {}),
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
    title: input.envelope.kind === 'group-title-update' && cloudGroupNonGenericTitle(input.envelope.groupTitle) ? input.envelope.groupTitle : null,
  });
}

export function cloudSessionTitleUpdateNoticeRequest(input: {
  envelope: CloudGroupControlEnvelope;
  actorIdentityId: string;
  actorDisplayName?: string | null;
  createdAtMs: number;
  cloudMessageId: string;
}): AppendCanonicalMessageRequest | null {
  if (input.envelope.sessionTitleSyncOnly) return null;
  return cloudTitleUpdateNoticeRequest({
    ...input,
    scope: 'session',
    title: cloudSessionTitleUpdateTitle(input.envelope),
  });
}

export function groupMemberJoinNoticeText(memberDisplayName: string, invitedByDisplayName: string) {
  const memberName = cleanText(memberDisplayName) || 'Someone';
  const inviterName = cleanText(invitedByDisplayName) || 'Someone';
  return `${memberName} joined the group, invited by ${inviterName}.`;
}

export function cloudGroupMemberJoinNoticeRequests(input: {
  envelope: CloudGroupControlEnvelope;
  actorIdentityId: string;
  identityIdByAccount: ReadonlyMap<string, string>; existingMessageIds?: ReadonlySet<string>;
}): AppendCanonicalMessageRequest[] {
  if (input.envelope.kind !== 'group-invite') return [];
  const actorIdentityId = cleanText(input.actorIdentityId);
  if (!actorIdentityId) return [];
  const invitedByDisplayName = cleanText(input.envelope.actor.displayName) || 'Someone';
  return (input.envelope.memberJoins ?? []).flatMap((join) => {
    const memberIdentityId = cleanText(input.identityIdByAccount.get(join.accountId));
    const messageId = `msg:group-member-join:${join.eventId}:${input.envelope.groupId}`;
    if (!memberIdentityId || input.existingMessageIds?.has(messageId)) return [];
    return [{
      id: messageId,
      sessionId: input.envelope.groupId,
      senderIdentityId: actorIdentityId,
      senderRole: 'system',
      messageKind: 'status',
      contentText: groupMemberJoinNoticeText(join.displayName, invitedByDisplayName),
      content: {
        kind: 'group-member-joined',
        eventId: join.eventId,
        memberIdentityId,
        memberDisplayName: join.displayName,
        invitedByIdentityId: actorIdentityId,
        invitedByDisplayName,
      },
      createdAtMs: join.createdAtMs,
      status: 'complete',
      sourceTransport: 'group-member-join',
      sourceEventId: messageId,
    } satisfies AppendCanonicalMessageRequest];
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
  const memberJoins = input.kind === 'group-invite' ? cloudGroupMemberJoins(input.memberJoins) : [];
  const memberLeaves = input.kind === 'group-update' ? cloudGroupMemberLeaves(input.memberLeaves) : [];
  const sessionTitle = normalizeCloudGroupSessionTitleSnapshot(input.sessionTitle);
  const envelope: CloudGroupControlEnvelope = {
    ...input,
    groupId: cleanText(input.groupId),
    groupSpaceId: cleanText(input.groupSpaceId) || null,
    groupTitle: cleanText(input.groupTitle) || null,
    createdByAccountId: cleanText(input.createdByAccountId),
    actor: cloudGroupTransportParticipant(cloudGroupNormalizeParticipant(input.actor)),
    participants: uniqueByAccount(input.participants).map(cloudGroupTransportParticipant),
    sessionTitle,
    message: input.message ? {
      ...input.message,
      createdAtMs: integerMilliseconds(input.message.createdAtMs, Date.now())!,
    } : input.message,
    ...(input.sessionTitleSyncOnly ? { sessionTitleSyncOnly: true } : {}),
    ...(memberJoins.length > 0 ? { memberJoins } : {}),
    ...(memberLeaves.length > 0 ? { memberLeaves } : {}),
  };
  return `${CLOUD_GROUP_PREFIX}${encodeBase64Url(JSON.stringify(envelope))}`;
}

export function parseCloudGroupControl(body: string): CloudGroupControlEnvelope | null {
  if (!body.startsWith(CLOUD_GROUP_PREFIX)) return null;
  try {
    const parsed = JSON.parse(decodeBase64Url(body.slice(CLOUD_GROUP_PREFIX.length))) as Partial<CloudGroupControlEnvelope>;
    if (!['group-invite', 'group-message', 'group-update', 'group-title-update', 'session-title-update', 'session-fork'].includes(parsed.kind ?? '')) return null;
    const kind = parsed.kind as CloudGroupControlKind;
    if (typeof parsed.groupId !== 'string' || !parsed.groupId.trim()) return null;
    if (!isCloudGroupSessionId(parsed.groupId)) return null;
    if (typeof parsed.createdByAccountId !== 'string' || !parsed.createdByAccountId.trim()) return null;
    if (!parsed.actor || typeof parsed.actor !== 'object') return null;
    if (!Array.isArray(parsed.participants)) return null;
    const actor = cloudGroupNormalizeParticipant(parsed.actor);
    const participants = uniqueByAccount(parsed.participants);
    if (!actor.accountId || participants.length === 0) return null;
    let message: CloudGroupControlEnvelope['message'] = null;
    if (kind === 'group-message') {
      const candidate = parsed.message;
      if (!candidate || typeof candidate !== 'object') return null;
      if (typeof candidate.id !== 'string' || typeof candidate.senderAccountId !== 'string' || typeof candidate.text !== 'string') return null;
      const createdAtMs = integerMilliseconds(candidate.createdAtMs, Date.now())!;
      const validMentions = normalizedMessageMentions((candidate as { mentions?: unknown }).mentions)?.filter((mention) => (
        mention.targetKind !== 'all'
        || (
          candidate.senderKind !== 'agent'
          && participants.some((participant) => participant.accountId === candidate.senderAccountId)
          && mention.targetIdentityId === groupMentionTargetIdentityId(parsed.groupId)
        )
      ));
      const mentions = validMentions?.length ? validMentions : undefined;
      message = {
        id: candidate.id,
        senderAccountId: candidate.senderAccountId,
        text: candidate.text,
        createdAtMs,
        senderKind: candidate.senderKind === 'agent' ? 'agent' : 'human',
        senderAgentId: cleanText(typeof candidate.senderAgentId === 'string' ? candidate.senderAgentId : null) || null,
        senderDisplayName: typeof candidate.senderDisplayName === 'string' && candidate.senderDisplayName.trim() ? candidate.senderDisplayName.trim() : null,
        deliveryState: typeof candidate.deliveryState === 'string' && candidate.deliveryState.trim() ? candidate.deliveryState.trim() : null,
        replyToMessageId: typeof candidate.replyToMessageId === 'string' && candidate.replyToMessageId.trim() ? candidate.replyToMessageId.trim() : null,
        requestId: typeof candidate.requestId === 'string' && candidate.requestId.trim() ? candidate.requestId.trim() : null,
        forkSnapshot: candidate.forkSnapshot === true,
        attachments: cloudMessageAttachmentsFromRecord((candidate as { attachments?: unknown }).attachments),
        ...(mentions ? { mentions } : {}),
        messageAction: cloudMessageActionFromRecord((candidate as { messageAction?: unknown }).messageAction),
        targetCloudAgentId: cleanText(typeof candidate.targetCloudAgentId === 'string' ? candidate.targetCloudAgentId : null) || null,
        targetCloudAgentName: cleanText(typeof candidate.targetCloudAgentName === 'string' ? candidate.targetCloudAgentName : null) || null,
        targetCloudAgentOwnerAccountId: cleanText(typeof candidate.targetCloudAgentOwnerAccountId === 'string' ? candidate.targetCloudAgentOwnerAccountId : null) || null,
        targetCloudAgentOwnerName: cleanText(typeof candidate.targetCloudAgentOwnerName === 'string' ? candidate.targetCloudAgentOwnerName : null) || null,
        agentMentionDepth: typeof candidate.agentMentionDepth === 'number' && Number.isInteger(candidate.agentMentionDepth) && candidate.agentMentionDepth >= 0 ? candidate.agentMentionDepth : null,
        ...cloudGroupMessageRuntimeFields(candidate),
      };
    }
    const forkRecord = objectRecord((parsed as { fork?: unknown }).fork);
    const fork = forkRecord.forkSessionId && forkRecord.parentSessionId ? {
      forkSessionId: cleanText(typeof forkRecord.forkSessionId === 'string' ? forkRecord.forkSessionId : null),
      parentSessionId: cleanText(typeof forkRecord.parentSessionId === 'string' ? forkRecord.parentSessionId : null),
      parentMessageId: cleanText(typeof forkRecord.parentMessageId === 'string' ? forkRecord.parentMessageId : null) || null,
      createdAtMs: integerMilliseconds(forkRecord.createdAtMs),
    } : null;
    const memberJoins = kind === 'group-invite'
      ? cloudGroupMemberJoins((parsed as { memberJoins?: unknown }).memberJoins)
      : [];
    const memberLeaves = kind === 'group-update'
      ? cloudGroupMemberLeaves((parsed as { memberLeaves?: unknown }).memberLeaves)
      : [];
    const sessionTitle = normalizeCloudGroupSessionTitleSnapshot(
      (parsed as { sessionTitle?: unknown }).sessionTitle,
    );
    return {
      kind,
      groupId: parsed.groupId.trim(),
      groupSpaceId: typeof parsed.groupSpaceId === 'string' && parsed.groupSpaceId.trim() ? parsed.groupSpaceId.trim() : null,
      groupTitle: typeof parsed.groupTitle === 'string' && parsed.groupTitle.trim() ? parsed.groupTitle.trim() : null,
      createdByAccountId: parsed.createdByAccountId.trim(),
      actor,
      participants,
      sessionTitle,
      ...(parsed.sessionTitleSyncOnly === true ? { sessionTitleSyncOnly: true } : {}),
      ...(memberJoins.length > 0 ? { memberJoins } : {}),
      ...(memberLeaves.length > 0 ? { memberLeaves } : {}),
      fork,
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
  const kordiId = normalizeKordiId(participant.kordiId);
  return {
    accountId: isCloudAccountId(accountId) ? accountId : '',
    ...(kordiId ? { kordiId } : {}),
    displayName: cleanText(participant.displayName) || accountId || 'Cloud user',
    avatarUrl: syncableCloudGroupAvatarUrl(participant.avatarUrl),
    agentId: cleanText(participant.agentId) || `cloud-agent:${accountId}`,
    agentDisplayName: cleanText(participant.agentDisplayName) || 'Kordi',
    agentAvatarUrl: syncableCloudGroupAvatarUrl(participant.agentAvatarUrl),
    agentAvatarSeed: cleanText(participant.agentAvatarSeed) || cleanText(participant.agentId) || `cloud-agent:${accountId}`,
    role: participant.role ?? 'person',
  };
}

export function cloudGroupSelfParticipant(account: CloudAccount, role: CloudGroupParticipant['role'] = 'admin'): CloudGroupParticipant {
  const kordiId = normalizeKordiId(account.kordiId);
  return {
    accountId: account.accountId,
    ...(kordiId ? { kordiId } : {}),
    displayName: cleanText(account.displayName) || cleanText(account.primaryEmail) || account.accountId,
    avatarUrl: syncableCloudGroupAvatarUrl(canonicalAvatarImageSource(account.avatar)),
    agentId: account.defaultAgent?.agentId ?? `cloud-agent:${account.accountId}`,
    agentDisplayName: account.defaultAgent?.displayName ?? 'Kordi',
    agentAvatarUrl: syncableCloudGroupAvatarUrl(account.defaultAgent ? canonicalAvatarImageSource(account.defaultAgent.avatar) : null),
    agentAvatarSeed: account.defaultAgent?.avatar.seed ?? `cloud-agent:${account.accountId}`,
    role,
  };
}

export function cloudGroupParticipantFromContact(contact: Contact, role: CloudGroupParticipant['role'] = 'person'): CloudGroupParticipant | null {
  const accountId = cleanText(contact.sourceHumanId) || cleanText(contact.sourceParticipantId) || cleanText(contact.id.replace(/^cloud:/, ''));
  if (!accountId) return null;
  const kordiId = normalizeKordiId(contact.detail) || normalizeKordiId(contact.subtitle);
  return {
    accountId,
    ...(kordiId ? { kordiId } : {}),
    displayName: cleanText(contact.name) || cleanText(contact.owner) || accountId,
    avatarUrl: syncableCloudGroupAvatarUrl(contact.profileImageUrl),
    agentId: contact.targetCloudAgentId ?? `cloud-agent:${accountId}`,
    agentDisplayName: contact.targetCloudAgentName ?? 'Kordi',
    agentAvatarUrl: syncableCloudGroupAvatarUrl(contact.targetCloudAgentAvatarUrl),
    agentAvatarSeed: contact.targetCloudAgentAvatarSeed ?? contact.targetCloudAgentId ?? `cloud-agent:${accountId}`,
    role,
  };
}

export function cloudGroupParticipantFromConversationParticipant(
  participant: ConversationParticipant,
  account: CloudAccount,
): CloudGroupParticipant | null {
  const isSelf = participant.role === 'self' || participant.source === 'local';
  if (isSelf) return cloudGroupSelfParticipant(account, participant.role || 'self');
  const accountId = cleanText(participant.humanId) || cleanText(participant.sourceIdentityId);
  if (!accountId) return null;
  const kordiId = normalizeKordiId(participant.kordiId);
  return {
    accountId,
    ...(kordiId ? { kordiId } : {}),
    displayName: cleanText(participant.name) || accountId,
    avatarUrl: syncableCloudGroupAvatarUrl(participant.profileImageUrl),
    agentId: cleanText(participant.defaultAgentId) || `cloud-agent:${accountId}`,
    agentDisplayName: cleanText(participant.defaultAgentDisplayName) || 'Kordi',
    agentAvatarUrl: syncableCloudGroupAvatarUrl(participant.defaultAgentAvatarUrl),
    agentAvatarSeed: cleanText(participant.defaultAgentAvatarSeed) || `cloud-agent:${accountId}`,
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
  const mapped = (conversation.canonicalParticipants ?? [])
    .filter((participant) => participant.kind === 'human')
    .map((participant) => cloudGroupParticipantFromConversationParticipant(participant, account))
    .filter((value): value is CloudGroupParticipant => Boolean(value));
  const self = mapped.find((participant) => participant.accountId === account.accountId)
    ?? cloudGroupSelfParticipant(account, 'person');
  return uniqueByAccount([self, ...mapped]);
}

export function cloudGroupParticipantsForCollaborationSession(
  account: CloudAccount,
  participants: DesktopCollaborationSessionParticipant[],
): CloudGroupParticipant[] {
  const mapped = participants.flatMap((participant): CloudGroupParticipant[] => {
      const accountId = cleanText(participant.humanId) || cleanText(participant.sourceIdentityId);
      if (!accountId) return [];
      return [{
        accountId,
        displayName: cleanText(participant.displayName) || accountId,
        avatarUrl: syncableCloudGroupAvatarUrl(participant.profileImageUrl),
        role: participant.role || 'person',
      }];
    });
  const self = mapped.find((participant) => participant.accountId === account.accountId)
    ?? cloudGroupSelfParticipant(account, 'person');
  return uniqueByAccount([self, ...mapped]);
}

export function cloudGroupMessageSessionId(input: {
  activeConvCanonicalSessionId?: string | null;
  activeGroupSessionSpaceId?: string | null;
}): string {
  return cleanText(input.activeConvCanonicalSessionId) || cleanText(input.activeGroupSessionSpaceId);
}

export function shouldCountCloudGroupMessageUnread(input: {
  activeConversationId?: string | null;
  activeConversationIds?: Array<string | null | undefined>;
  groupId: string;
  forkSnapshot?: boolean | null;
}): boolean {
  if (input.forkSnapshot === true) return false;
  const activeIds = new Set([
    input.activeConversationId,
    ...(input.activeConversationIds ?? []),
  ].map((value) => cleanText(value)).filter(Boolean));
  const sessionId = cleanText(input.groupId);
  if (activeIds.size === 0) return true;
  for (const active of activeIds) {
    if (active === sessionId || active === `group:${sessionId}`) return false;
  }
  return true;
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


export function cloudGroupAgentRequestingNoticeRequest(input: {
  sessionId: string;
  requestMessageId: string;
  targetAccountId: string;
  targetAgentId?: string | null;
  targetAgentDisplayName?: string | null;
  createdAtMs?: number | null;
}): AppendCanonicalMessageRequest {
  const sessionId = cleanText(input.sessionId);
  const requestMessageId = cleanText(input.requestMessageId);
  const targetAccountId = cleanText(input.targetAccountId);
  const targetAgentDisplayName = cleanText(input.targetAgentDisplayName) || 'Kordi';
  const createdAtMs = typeof input.createdAtMs === 'number' && Number.isFinite(input.createdAtMs)
    ? input.createdAtMs
    : Date.now();
  return {
    id: `msg:cloud-agent-processing:${requestMessageId}:${targetAccountId}`,
    sessionId,
    senderIdentityId: cloudAgentCanonicalIdentityId(input.targetAgentId, targetAccountId),
    senderRole: 'external-agent',
    messageKind: 'agent-turn',
    contentText: 'processing...',
    content: {
      sender: targetAgentDisplayName,
      senderOwnerAccountId: targetAccountId,
      timestampMs: createdAtMs,
      deliveryState: 'processing',
      requestId: requestMessageId,
      replyToMessageId: requestMessageId,
    },
    parentMessageId: requestMessageId,
    status: 'processing',
    createdAtMs,
    sourceTransport: 'cloud-group-agent-offline',
    sourceEventId: `cloud-group-agent-processing:${requestMessageId}:${targetAccountId}`,
  };
}

export function cloudGroupAgentRequestingNoticeMessage(input: {
  sessionId: string;
  requestMessageId: string;
  targetAccountId: string;
  targetAgentId?: string | null;
  targetAgentDisplayName?: string | null;
  createdAtMs?: number | null;
  sequenceNum?: number | null;
}): CanonicalSessionMessage {
  const request = cloudGroupAgentRequestingNoticeRequest(input);
  const createdAtMs = request.createdAtMs ?? Date.now();
  return {
    id: request.id ?? '',
    sessionId: request.sessionId,
    senderIdentityId: request.senderIdentityId,
    senderRole: request.senderRole,
    messageKind: request.messageKind,
    contentText: request.contentText,
    content: request.content,
    parentMessageId: request.parentMessageId,
    status: request.status ?? 'processing',
    sequenceNum: typeof input.sequenceNum === 'number' && Number.isFinite(input.sequenceNum) ? input.sequenceNum : 0,
    createdAtMs,
    updatedAtMs: createdAtMs,
    contentHash: null,
    sourceTransport: request.sourceTransport,
    sourceEventId: request.sourceEventId,
  };
}

export function cloudGroupAgentOfflineNoticeRequest(input: {
  sessionId: string;
  requestMessageId: string;
  targetAccountId: string;
  targetAgentId?: string | null;
  targetHumanDisplayName?: string | null;
  targetAgentDisplayName?: string | null;
  createdAtMs?: number | null;
}): AppendCanonicalMessageRequest {
  const sessionId = cleanText(input.sessionId);
  const requestMessageId = cleanText(input.requestMessageId);
  const targetAccountId = cleanText(input.targetAccountId);
  const targetHumanDisplayName = cleanText(input.targetHumanDisplayName) || 'The user';
  const targetAgentDisplayName = cleanText(input.targetAgentDisplayName) || 'Kordi';
  const createdAtMs = typeof input.createdAtMs === 'number' && Number.isFinite(input.createdAtMs)
    ? input.createdAtMs
    : Date.now();
  const text = `${targetHumanDisplayName} and ${targetAgentDisplayName} are offline.`;
  return {
    id: `msg:cloud-agent-offline:${requestMessageId}:${targetAccountId}`,
    sessionId,
    senderIdentityId: cloudAgentCanonicalIdentityId(input.targetAgentId, targetAccountId),
    senderRole: 'external-agent',
    messageKind: 'agent-turn',
    contentText: '',
    content: {
      sender: targetAgentDisplayName,
      senderOwnerAccountId: targetAccountId,
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

export function cloudGroupMessageReadTargets(input: {
  accountId: string;
  activeConversationId?: string | null;
  activeConversationIds?: Array<string | null | undefined>;
  messages?: CloudMessage[];
  groupRows?: readonly IndexedCloudGroupRow[];
}): { peerIds: string[]; sessionIds: string[] } {
  const accountId = cleanText(input.accountId);
  const peerIds = new Set<string>();
  const sessionIds = new Set<string>();
  if (!accountId) return { peerIds: [], sessionIds: [] };
  const rows = input.groupRows ?? (input.messages ?? []).flatMap((wire) => {
    const envelope = parseCloudGroupControl(wire.body);
    return envelope ? [{ wire, envelope, canonicalMessageId: cleanText(envelope.message?.id) || null }] : [];
  });
  for (const { wire: message, envelope } of rows) {
    if (!cloudGroupMessageIsUnreadForAccount(message, envelope, accountId)) continue;
    if (shouldCountCloudGroupMessageUnread({
      activeConversationId: input.activeConversationId,
      activeConversationIds: input.activeConversationIds,
      groupId: envelope.groupId,
      forkSnapshot: envelope.message?.forkSnapshot,
    })) continue;
    const peerId = cleanText(message.fromAccountId);
    if (peerId) peerIds.add(peerId);
    const sessionId = cleanText(envelope.groupId);
    if (sessionId) sessionIds.add(sessionId);
  }
  return { peerIds: [...peerIds].sort(), sessionIds: [...sessionIds].sort() };
}

export function cloudGroupMessageReadPeerIds(input: {
  accountId: string;
  activeConversationId?: string | null;
  activeConversationIds?: Array<string | null | undefined>;
  messages: CloudMessage[];
}): string[] {
  return cloudGroupMessageReadTargets(input).peerIds;
}

export type CloudGroupReadCursor = {
  lastReadMessageId?: string | null;
  lastReadCreatedAtMs?: number | null;
};

function cloudGroupMessageCreatedAtMs(message: CloudMessage, envelope: CloudGroupControlEnvelope) {
  const explicitCreatedAtMs = typeof envelope.message?.createdAtMs === 'number' && Number.isFinite(envelope.message.createdAtMs)
    ? envelope.message.createdAtMs
    : null;
  if (explicitCreatedAtMs !== null) return explicitCreatedAtMs;
  const parsedCloudCreatedAt = Date.parse(message.createdAt);
  return Number.isFinite(parsedCloudCreatedAt) ? parsedCloudCreatedAt : null;
}

function cloudGroupMessageIsAtOrBeforeReadCursor(message: CloudMessage, envelope: CloudGroupControlEnvelope, cursor?: CloudGroupReadCursor | null) {
  if (!cursor) return false;
  const groupMessageId = cleanText(envelope.message?.id) || cleanText(message.messageId);
  const lastReadMessageId = cleanText(cursor.lastReadMessageId);
  if (groupMessageId && lastReadMessageId && groupMessageId === lastReadMessageId) return true;
  const lastReadCreatedAtMs = typeof cursor.lastReadCreatedAtMs === 'number' && Number.isFinite(cursor.lastReadCreatedAtMs)
    ? cursor.lastReadCreatedAtMs
    : null;
  if (lastReadCreatedAtMs === null) return false;
  const createdAtMs = cloudGroupMessageCreatedAtMs(message, envelope);
  return createdAtMs !== null && createdAtMs <= lastReadCreatedAtMs;
}

export function cloudGroupUnreadCountsBySessionId(input: {
  accountId: string;
  readCursorsBySessionId?: Record<string, CloudGroupReadCursor | null | undefined>;
  messages?: CloudMessage[];
  groupRows?: readonly IndexedCloudGroupRow[];
}): Record<string, number> {
  const accountId = cleanText(input.accountId);
  if (!accountId) return {};
  const counts: Record<string, number> = {};
  const seenGroupMessageIds = new Set<string>();
  const rows = input.groupRows ?? (input.messages ?? []).flatMap((wire) => {
    const envelope = parseCloudGroupControl(wire.body);
    return envelope ? [{ wire, envelope, canonicalMessageId: cleanText(envelope.message?.id) || null }] : [];
  });
  for (const { wire: message, envelope } of rows) {
    if (!cloudGroupMessageIsUnreadForAccount(message, envelope, accountId)) continue;
    if (envelope.message?.forkSnapshot === true) continue;
    const sessionId = cleanText(envelope.groupId);
    if (!sessionId) continue;
    if (cloudGroupMessageIsAtOrBeforeReadCursor(message, envelope, input.readCursorsBySessionId?.[sessionId])) continue;
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
  if (matching.some((message) => Boolean(message.readAt))) return 'read';
  return 'delivered';
}

export type CloudGroupReadReceiptSummary = {
  count: number;
  participants: Array<{
    accountId: string;
    identityId: string;
    readAt: string;
  }>;
};

export function cloudGroupReadReceiptSummaryFromMessages(input: {
  accountId: string;
  messageId: string;
  messages: CloudMessage[];
}): CloudGroupReadReceiptSummary | null {
  const accountId = cleanText(input.accountId);
  const messageId = cleanText(input.messageId);
  if (!accountId || !messageId) return null;

  const participantsByAccountId = new Map<string, { accountId: string; identityId: string; readAt: string }>();
  for (const message of input.messages) {
    if (message.fromAccountId !== accountId || message.direction !== 'outgoing' || !message.readAt) continue;
    const envelope = parseCloudGroupControl(message.body);
    if (envelope?.kind !== 'group-message' || envelope.message?.id !== messageId) continue;
    const recipientAccountId = cleanText(message.toAccountId);
    const readAt = cleanText(message.readAt);
    if (!recipientAccountId || !readAt) continue;
    participantsByAccountId.set(recipientAccountId, {
      accountId: recipientAccountId,
      identityId: `human:${recipientAccountId}`,
      readAt,
    });
  }

  const participants = [...participantsByAccountId.values()]
    .sort((left, right) => left.accountId.localeCompare(right.accountId));
  return participants.length > 0 ? { count: participants.length, participants } : null;
}

export function shouldRouteMentionThroughCloudGroup(input: {
  mentionedHostId?: string | null;
  activeGroupSessionIsGroup: boolean;
  mentionsLocalAgent?: boolean;
  mentionsCollaborationAgent?: boolean;
  hasCloudGroupRecipients?: boolean;
}): boolean {
  const mentionedCloudTarget = cleanText(input.mentionedHostId) === CLOUD_HOST_SENTINEL;
  if (!input.activeGroupSessionIsGroup) {
    return false;
  }
  if (mentionedCloudTarget) return true;
  if (input.hasCloudGroupRecipients === true) return true;
  if (input.mentionsLocalAgent === true) return true;
  return false;
}

export function cloudGroupTargetAccountIds<T extends { hostId?: string | null; nodeId?: string | null }>(targets: T[]): string[] {
  return [...new Set(targets
    .filter((target) => target.hostId === CLOUD_HOST_SENTINEL)
    .map((target) => cloudAccountIdOrNull(target.nodeId))
    .filter((accountId): accountId is string => Boolean(accountId)))];
}

export const cloudOnlyGroupTargetAccountIds = (targets: Array<{ hostId?: string | null; nodeId?: string | null }>): string[] => rejectNonCloudCollaborationTargets(targets);

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

export function requiredCloudGroupControlTargetAccountIds(input: {
  kind: CloudGroupControlKind;
  explicitTargetAccountIds: string[];
  memberLeaves?: CloudGroupMemberLeave[];
}): string[] {
  const requiresEveryExplicitTarget = input.kind === 'group-invite'
    || (input.kind === 'group-update' && (input.memberLeaves?.length ?? 0) > 0);
  if (!requiresEveryExplicitTarget) return [];
  return [...new Set(input.explicitTargetAccountIds.map(cleanText).filter(Boolean))];
}

export function firstRequiredCloudGroupSendFailure(
  results: PromiseSettledResult<unknown>[],
  recipientAccountIds: string[],
  requiredAccountIds: string[],
): PromiseRejectedResult | undefined {
  const required = new Set(requiredAccountIds.map(cleanText).filter(Boolean));
  return results.find((result, index): result is PromiseRejectedResult => (
    result.status === 'rejected' && required.has(cleanText(recipientAccountIds[index]))
  ));
}
