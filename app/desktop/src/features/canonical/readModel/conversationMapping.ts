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

export function shouldUseCanonicalMessages(existingMessages: Message[], canonicalMessages: Message[]) {
  if (canonicalMessages.length === 0) return false;
  const existingHasLiveTurn = existingMessages.some((message) => message.turn && !message.turn.completed);
  if (existingHasLiveTurn) {
    const canonicalHasLiveTurn = canonicalMessages.some((message) => message.turn && !message.turn.completed);
    if (!canonicalHasLiveTurn && canonicalMessages.length <= existingMessages.length) return false;
  }

  const placeholderOnly = existingMessages.length === 1
    && existingMessages[0]?.role === 'system'
    && /^(Draft session|Session ready|Opening your local chat history|Select a local session)/.test(existingMessages[0]?.text ?? '');

  return placeholderOnly || canonicalMessages.length >= existingMessages.length;
}

export function sessionMetadata(session: CanonicalSessionState['sessions'][number]) {
  return session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
    ? session.metadata as Record<string, unknown>
    : {};
}

export function syntheticBridgeTarget(
  session: CanonicalSessionState['sessions'][number],
  participants: ConversationParticipant[],
): ConversationBridgeTarget | null {
  const metadata = sessionMetadata(session);
  const metadataHostId = stringValue(metadata.bridgeHostId);
  const metadataNodeId = stringValue(metadata.peerNodeId);
  const runtime = stringValue(metadata.peerRuntime);

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
    displayName: matchingParticipant?.name ?? stringValue(metadata.peerDisplayName) ?? null,
    ownerName: matchingParticipant?.humanId ? matchingParticipant.name : null,
    runtime: runtime ?? (matchingParticipant?.kind === 'human' ? 'person' : null),
    humanId: matchingParticipant?.humanId ?? null,
    agentId: matchingParticipant?.agentId ?? null,
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

export function sessionHasActiveProcessing(messages: Message[]) {
  return messages.some((message) => message.turn && !message.turn.completed)
    || messages.some((message) => message.statusChips?.some((chip) => ['sending', 'processing', 'pending'].includes(chip.trim().toLowerCase())));
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
    ?? formatDesktopClockTime(session.lastMessageAtMs ?? session.updatedAtMs ?? session.createdAtMs);

  return {
    id: session.id,
    canonicalSessionId: session.id,
    name: session.title,
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
