import type {
  CanonicalSessionState,
  Conversation,
  ConversationBridgeTarget,
  ConversationParticipant,
  Message,
} from '@/kordi-app/types';
import { formatDesktopClockTime } from '@/lib/time';

import { stringValue } from './messageMapping';

export type ConversationSubtitleBuilder = (messages: Message[], fallback?: string) => string;

function messageResponseText(message: Message) {
  return (message.turn?.assistantText ?? message.text).trim();
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

export function shouldUseCanonicalMessages(existingMessages: Message[], canonicalMessages: Message[]) {
  if (canonicalMessages.length === 0) return false;
  const existingHasLiveTurn = existingMessages.some((message) => message.turn && !message.turn.completed);
  if (existingHasLiveTurn) {
    const canonicalHasLiveTurn = canonicalMessages.some((message) => message.turn && !message.turn.completed);
    if (!canonicalHasLiveTurn && canonicalMessages.length <= existingMessages.length) return false;
  }

  const existingRichness = transcriptTurnRichness(existingMessages);
  const canonicalRichness = transcriptTurnRichness(canonicalMessages);
  if (
    existingRichness.thinkingLength > canonicalRichness.thinkingLength
    || existingRichness.toolCount > canonicalRichness.toolCount
  ) {
    return false;
  }

  if (canonicalHasMissingCompletedAgentResponse(existingMessages, canonicalMessages)) return true;

  const placeholderOnly = existingMessages.length === 1
    && existingMessages[0]?.role === 'system'
    && /^(Draft session|Session ready|Opening (?:my|your) local chat history|Select a local session)/.test(existingMessages[0]?.text ?? '');

  return placeholderOnly || canonicalMessages.length >= existingMessages.length;
}

export function sessionMetadata(session: CanonicalSessionState['sessions'][number]) {
  return session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
    ? session.metadata as Record<string, unknown>
    : {};
}

function nonPlaceholderGroupTitle(value: string) {
  const title = value.trim();
  if (!title || /^(new session|session|group)$/i.test(title)) return null;
  return title;
}

export function sessionViewMetadata(session: CanonicalSessionState['sessions'][number]) {
  if (session.kind !== 'group') return session.metadata;
  const metadata = sessionMetadata(session);
  if (stringValue(metadata.customName)) return session.metadata;
  const customName = nonPlaceholderGroupTitle(session.title);
  return customName ? { ...metadata, customName } : session.metadata;
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
  const text = messages
    .find((message) => message.role !== 'system' && message.text.trim().length > 0)
    ?.text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .join(' ')
    .slice(0, 60)
    .trim();
  return text || null;
}

export function sessionHasManualTitle(session: CanonicalSessionState['sessions'][number]) {
  return stringValue(sessionMetadata(session).titleSource) === 'manual';
}

export function sessionDisplayTitle(messages: Message[], fallback: string, options: { preferFallback?: boolean } = {}) {
  const fallbackTitle = fallback.trim();
  if (options.preferFallback && fallbackTitle) return fallbackTitle;
  return firstMessageTitle(messages) ?? fallback;
}

export function sessionHasActiveProcessing(messages: Message[]) {
  return messages.some((message) => message.turn && !message.turn.completed)
    || messages.some((message) => message.statusChips?.some((chip) => ['sending', 'processing', 'pending'].includes(chip.trim().toLowerCase())));
}

export function sessionChatActivityAtMs(session: CanonicalSessionState['sessions'][number]) {
  return session.lastMessageAtMs ?? session.createdAtMs ?? session.updatedAtMs ?? 0;
}

export function syntheticConversation(
  session: CanonicalSessionState['sessions'][number],
  participants: ConversationParticipant[],
  messages: Message[],
  buildSubtitle: ConversationSubtitleBuilder,
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
  const updatedAtLabel = messages[messages.length - 1]?.time
    ?? formatDesktopClockTime(sessionChatActivityAtMs(session));

  const displayTitle = sessionDisplayTitle(messages, session.title, { preferFallback: sessionHasManualTitle(session) });

  return {
    id: session.id,
    canonicalSessionId: session.id,
    canonicalCreatedByIdentityId: session.createdByIdentityId,
    name: displayTitle,
    type: syntheticConversationType(session, participants),
    subtitle: buildSubtitle(messages, session.title),
    unread: 0,
    bridges: bridgeTarget ? ['Bridge'] : ['Local'],
    trust: bridgeTarget ? 'Bridge' : 'Owned',
    directness: 'Direct chat',
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
