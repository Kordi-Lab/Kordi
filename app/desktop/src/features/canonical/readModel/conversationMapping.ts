import type {
  CanonicalSessionMessage,
  CanonicalSessionState,
  Conversation,
  ConversationBridgeTarget,
  ConversationParticipant,
  Message,
} from '@/kordi-app/types';
import {
  deriveSessionTitle,
  isExplicitPlaceholderSessionTitle,
  isGenericSessionTitle,
  isRawSessionIdentifier,
  titleSourceFromMetadata,
} from '@/features/chat/sessionTitlePolicy';
import { conversationChatKindLabel } from '@/features/chat/sessionKindLabels';
import { formatDesktopLastActiveLabel } from '@/lib/time';

import { stringValue } from './messageMapping';

export type ConversationSubtitleBuilder = (messages: Message[], fallback?: string) => string;

function messageResponseText(message: Message) {
  return message.turn?.assistantText.trim()
    || message.turn?.error?.trim()
    || message.text.trim();
}

function normalizedMessageResponseText(message: Message) {
  return messageResponseText(message).replace(/\s+/g, ' ').toLowerCase();
}

function canonicalHasMissingCompletedAgentResponse(existingMessages: Message[], canonicalMessages: Message[]) {
  const existingTexts = new Set(
    existingMessages
      .map(normalizedMessageResponseText)
      .filter(Boolean),
  );

  return canonicalMessages.some((message) => {
    if (!message.turn?.assistantText.trim()) return false;
    if (message.turn.completed === false) return false;
    if (message.role !== 'owned-agent' && message.role !== 'external-agent') return false;
    return !existingTexts.has(normalizedMessageResponseText(message));
  });
}

function transcriptTurnRichness(messages: Message[]) {
  return messages.reduce(
    (richness, message) => ({
      thinkingLength: richness.thinkingLength + (message.turn?.thinkingText.trim().length ?? 0),
      toolCount: richness.toolCount + (message.turn?.tools.length ?? 0),
    }),
    { thinkingLength: 0, toolCount: 0 },
  );
}

function agentReplyTargetId(message: Message) {
  return message.replyToMessageId?.trim() || message.turn?.replyToMessageId?.trim() || null;
}

function agentReplyTargetKey(message: Message) {
  const targetId = agentReplyTargetId(message);
  if (!targetId || (message.role !== 'owned-agent' && message.role !== 'external-agent')) return null;
  return `${message.role}\u0000${targetId}`;
}

function canonicalSupersedesExistingLiveAgentTurn(existingMessages: Message[], canonicalMessages: Message[]) {
  const completedCanonicalReplyTargets = new Set(
    canonicalMessages.flatMap((message) => {
      if (!message.turn || message.turn.completed === false) return [];
      if (!messageResponseText(message)) return [];
      const key = agentReplyTargetKey(message);
      return key ? [key] : [];
    }),
  );
  if (completedCanonicalReplyTargets.size === 0) return false;

  return existingMessages.some((message) => {
    if (!message.turn || message.turn.completed) return false;
    const key = agentReplyTargetKey(message);
    return Boolean(key && completedCanonicalReplyTargets.has(key));
  });
}

export function shouldUseCanonicalMessages(existingMessages: Message[], canonicalMessages: Message[]) {
  if (canonicalMessages.length === 0) return false;
  const existingHasLiveTurn = existingMessages.some((message) => message.turn && !message.turn.completed);
  if (existingHasLiveTurn) {
    const canonicalHasLiveTurn = canonicalMessages.some((message) => message.turn && !message.turn.completed);
    if (!canonicalHasLiveTurn && canonicalMessages.length <= existingMessages.length) {
      return canonicalSupersedesExistingLiveAgentTurn(existingMessages, canonicalMessages);
    }
  }

  const existingRichness = transcriptTurnRichness(existingMessages);
  const canonicalRichness = transcriptTurnRichness(canonicalMessages);
  if (
    existingRichness.thinkingLength > canonicalRichness.thinkingLength
    || existingRichness.toolCount > canonicalRichness.toolCount
  ) {
    return false;
  }

  const canonicalHasForkSnapshotMarkers = canonicalMessages.some((message) => message.isForkSnapshot === true);
  const existingHasForkSnapshotMarkers = existingMessages.some((message) => message.isForkSnapshot === true);
  if (canonicalHasForkSnapshotMarkers && !existingHasForkSnapshotMarkers) return true;

  if (canonicalHasMissingCompletedAgentResponse(existingMessages, canonicalMessages)) return true;

  const placeholderOnly = existingMessages.length === 1
    && existingMessages[0]?.role === 'system'
    && /^(Draft session|Session ready|Opening (?:my|your) local chat history|Select a local session)/.test(existingMessages[0]?.text ?? '');

  return placeholderOnly || canonicalMessages.length > existingMessages.length;
}

export function sessionMetadata(session: CanonicalSessionState['sessions'][number]) {
  return session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
    ? session.metadata as Record<string, unknown>
    : {};
}

export function sessionViewMetadata(session: CanonicalSessionState['sessions'][number]) {
  return session.metadata;
}

export function syntheticBridgeTarget(
  session: CanonicalSessionState['sessions'][number],
  participants: ConversationParticipant[],
): ConversationBridgeTarget | null {
  const metadata = sessionMetadata(session);
  const metadataHostId = stringValue(metadata.bridgeHostId);
  const metadataNodeId = stringValue(metadata.peerNodeId);
  const runtime = stringValue(metadata.peerRuntime);
  const metadataDisplayName = stringValue(metadata.peerDisplayName);
  const metadataOwnerName = stringValue(metadata.peerOwnerName);
  const metadataHumanId = stringValue(metadata.peerHumanId);
  const metadataAgentId = stringValue(metadata.peerAgentId) ?? stringValue(metadata.targetAgentId);

  const matchingParticipant = metadataNodeId
    ? participants.find((participant) => participant.bridgeNodeId === metadataNodeId)
    : participants.find((participant) => (
        participant.source === 'bridge'
        && participant.kind === 'human'
        && participant.role !== 'self'
        && participant.bridgeHostId
        && participant.bridgeNodeId
      ));
  const hostId = metadataHostId ?? matchingParticipant?.bridgeHostId;
  const nodeId = metadataNodeId ?? matchingParticipant?.bridgeNodeId;
  if (!hostId || !nodeId) return null;

  return {
    hostId,
    nodeId,
    displayName: matchingParticipant?.name ?? metadataDisplayName ?? null,
    ownerName: matchingParticipant?.ownerName ?? (matchingParticipant?.humanId ? matchingParticipant.name : null) ?? metadataOwnerName ?? null,
    runtime: runtime ?? (matchingParticipant?.kind === 'human' ? 'person' : null),
    humanId: matchingParticipant?.humanId ?? metadataHumanId ?? null,
    agentId: matchingParticipant?.agentId ?? metadataAgentId ?? null,
  };
}

export function syntheticConversationType(
  session: CanonicalSessionState['sessions'][number],
  participants: ConversationParticipant[],
): Conversation['type'] {
  if (session.kind === 'self-agent') return 'owned-agent';
  if (session.kind === 'direct-agent') return 'external-agent';
  if (session.kind === 'direct-person' || session.kind === 'relationship') {
    const primary = participants.find((participant) => participant.id === session.primaryIdentityId);
    return primary?.kind === 'agent' ? 'external-agent' : 'person';
  }
  return 'owned-agent';
}

function normalizeParticipantSpaceId(value: string) {
  const trimmed = value.trim();
  return trimmed.startsWith('group:') ? trimmed.slice('group:'.length) : trimmed;
}

export function syntheticParticipantSpaceId(session: CanonicalSessionState['sessions'][number]) {
  if (session.kind !== 'group') return null;
  const metadata = sessionMetadata(session);
  const groupSpaceId = stringValue(metadata.continuedFromSpaceId) ?? stringValue(metadata.groupSpaceId) ?? stringValue(metadata.groupId);
  return groupSpaceId ? normalizeParticipantSpaceId(groupSpaceId) || null : null;
}

function firstMessageTitle(messages: Message[]) {
  const visible = messages.filter((message) => !message.isForkSnapshot && message.role !== 'system');
  for (const message of [...visible.filter((message) => message.role === 'user'), ...visible.filter((message) => message.role !== 'user')]) {
    const title = deriveSessionTitle(message.text);
    if (title) return title;
  }
  return null;
}

function legacyFirstMessageTitle(messages: Message[]) {
  const text = messages
    .find((message) => !message.isForkSnapshot && message.role !== 'system' && message.text.trim().length > 0)
    ?.text
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 8)
    .join(' ')
    .slice(0, 60)
    .trim();
  return text || null;
}

export function sessionHasManualTitle(session: CanonicalSessionState['sessions'][number]) {
  const metadata = sessionMetadata(session);
  if (isRawSessionIdentifier(session.title) || isExplicitPlaceholderSessionTitle(session.title)) return false;
  if (stringValue(metadata.sessionTitleSource) === 'manual') return Boolean(session.title.trim());
  if (isGenericSessionTitle(session.title)) return false;
  if (session.kind === 'group') return false;
  return stringValue(metadata.titleSource) === 'manual';
}

export function sessionPrefersPersistedTitle(session: CanonicalSessionState['sessions'][number]) {
  if (session.kind !== 'self-agent' && session.kind !== 'project') {
    return sessionHasManualTitle(session);
  }
  const metadata = sessionMetadata(session);
  const source = titleSourceFromMetadata(metadata, session.title);
  if (isRawSessionIdentifier(session.title) || isExplicitPlaceholderSessionTitle(session.title)) return false;
  if (source === 'manual' || source === 'imported' || source === 'external') {
    return Boolean(session.title.trim());
  }
  return source !== 'placeholder'
    && !isGenericSessionTitle(session.title);
}

export function sessionDisplayTitle(messages: Message[], fallback: string, options: { preferFallback?: boolean } = {}) {
  const fallbackTitle = fallback.trim();
  if (options.preferFallback && fallbackTitle) return fallbackTitle;
  return firstMessageTitle(messages) ?? fallback;
}

function participantIsSelf(participant: ConversationParticipant) {
  return participant.role === 'self'
    || (participant.source === 'local' && participant.kind === 'human');
}

function directPersonContactTitle(
  session: CanonicalSessionState['sessions'][number],
  participants: ConversationParticipant[],
) {
  if (session.kind !== 'direct-person' && session.kind !== 'relationship') return null;
  const metadata = sessionMetadata(session);
  const isBridgeDirectPerson = stringValue(metadata.source) === 'bridge-session-thread'
    || Boolean(stringValue(metadata.bridgeHostId) || stringValue(metadata.peerNodeId));
  if (!isBridgeDirectPerson) return null;
  const primary = session.primaryIdentityId
    ? participants.find((participant) => participant.id === session.primaryIdentityId && participant.kind === 'human')
    : null;
  const contact = primary ?? participants.find((participant) => participant.kind === 'human' && !participantIsSelf(participant));
  const name = contact?.name.trim();
  return name || null;
}

export function sessionConversationDisplayTitle(
  session: CanonicalSessionState['sessions'][number],
  participants: ConversationParticipant[],
  messages: Message[],
  fallback: string,
  options: { preferFallback?: boolean } = {},
) {
  return directPersonContactTitle(session, participants)
    ?? ((session.kind === 'self-agent' || session.kind === 'project')
      ? sessionDisplayTitle(messages, fallback, options)
      : (options.preferFallback && fallback.trim()) || legacyFirstMessageTitle(messages) || fallback);
}

export function sessionHasActiveProcessing(messages: Message[]) {
  return messages.some((message) => message.turn && !message.turn.completed)
    || messages.some((message) => message.statusChips?.some((chip) => ['sending', 'processing', 'pending'].includes(chip.trim().toLowerCase())));
}

export function canonicalMessageCountsForLastActive(message: CanonicalSessionMessage) {
  if (message.sourceTransport === 'canonical-fork-snapshot' || message.sourceTransport === 'cloud-group-fork-snapshot') return false;
  const status = message.status.trim().toLowerCase();
  if (['sending', 'processing'].includes(status)) return false;
  return true;
}

export function sessionChatActivityAtMs(
  session: CanonicalSessionState['sessions'][number],
  rawMessages: CanonicalSessionMessage[] = [],
) {
  const latestRealMessageAtMs = rawMessages
    .filter(canonicalMessageCountsForLastActive)
    .reduce((latest, message) => Math.max(latest, message.createdAtMs), 0);
  return latestRealMessageAtMs || (session.lastMessageAtMs ?? session.createdAtMs ?? session.updatedAtMs ?? 0);
}

export function sessionUnreadCount(session: CanonicalSessionState['sessions'][number]) {
  const value = sessionMetadata(session).cloudUnreadCount;
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function syntheticConversation(
  session: CanonicalSessionState['sessions'][number],
  participants: ConversationParticipant[],
  messages: Message[],
  buildSubtitle: ConversationSubtitleBuilder,
  rawMessages: CanonicalSessionMessage[] = [],
): Conversation {
  const primary = participants.find((participant) => participant.id === session.primaryIdentityId) ?? participants[0];
  const participantNames = participants.map((participant) => participant.name);
  const participantAvatarSeeds = participants.reduce<Record<string, string>>((acc, participant) => {
    if (participant.avatarKey) {
      acc[participant.name] = participant.avatarKey;
    }
    return acc;
  }, {});
  const bridgeTarget = syntheticBridgeTarget(session, participants);
  const updatedAtLabel = formatDesktopLastActiveLabel(sessionChatActivityAtMs(session, rawMessages));

  const displayTitle = sessionConversationDisplayTitle(session, participants, messages, session.title, { preferFallback: sessionPrefersPersistedTitle(session) });

  return {
    id: session.id,
    canonicalSessionId: session.id,
    canonicalCreatedByIdentityId: session.createdByIdentityId,
    canonicalCreatedAtMs: session.createdAtMs,
    name: displayTitle,
    type: syntheticConversationType(session, participants),
    subtitle: buildSubtitle(messages, session.title),
    unread: sessionUnreadCount(session),
    bridges: bridgeTarget ? ['Bridge'] : ['Local'],
    trust: bridgeTarget ? 'Bridge' : 'Owned',
    directness: conversationChatKindLabel({
      id: session.id,
      canonicalSessionId: session.id,
      type: syntheticConversationType(session, participants),
    }),
    participants: participantNames,
    canonicalParticipants: participants,
    messages,
    updatedAtLabel,
    avatarSeed: primary?.avatarKey ?? null,
    profileImageUrl: primary?.profileImageUrl ?? null,
    participantAvatarSeeds,
    participantSpaceId: syntheticParticipantSpaceId(session),
    metadata: sessionViewMetadata(session),
    bridgeTarget,
    canonicalStoragePath: undefined,
    canonicalParticipantCount: participants.length,
    canonicalMessageCount: messages.length,
    canonicalDelegatedExchangeCount: 0,
    canonicalContextSnapshotCount: 0,
    statusIndicator: sessionHasActiveProcessing(messages)
      ? { label: 'Running', tone: 'running', live: true }
      : undefined,
  };
}
