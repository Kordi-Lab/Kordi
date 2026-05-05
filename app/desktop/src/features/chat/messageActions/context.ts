import type {
  Conversation,
  ConversationBridgeTarget,
  DesktopBridgePromptIdentity,
  DesktopBridgeSessionParticipant,
  DesktopChatState,
} from '@/kordi-app/types';

import type { UseComposerControllerArgs } from '../composerController.types';
import type { ResolvedMentionedBridgeTarget } from './types';

export function renderProjectContext(state: DesktopChatState | null) {
  const project = state?.activeSession.project;
  if (!project) return null;

  const lines = [
    `Project: ${project.name}`,
    project.sharedContext ? `Context: ${project.sharedContext}` : null,
    project.backgroundSystem ? `Standing instruction: ${project.backgroundSystem}` : null,
    project.sharedSources.length > 0
      ? `Shared sources: ${project.sharedSources.map((source) => [source.label, source.detail].filter(Boolean).join(' — ')).join('; ')}`
      : null,
  ].filter((line): line is string => Boolean(line));

  return lines.length > 0 ? lines.join('\n') : null;
}

export function renderRecentMessageContext(messages: UseComposerControllerArgs['activeConvMessages']) {
  const lines = messages
    .filter((message) => message.text?.trim())
    .slice(-8)
    .map((message) => `${message.sender || message.role}: ${message.text.trim()}`);
  return lines.length > 0 ? `Recent session messages:\n${lines.join('\n')}` : null;
}

export function parentSessionMessagesForOutreach(messages: UseComposerControllerArgs['activeConvMessages']) {
  return messages.flatMap((message, index) => {
    const text = (message.turn?.assistantText || message.text || '').trim();
    if (!text) return [];
    if (message.role === 'action' || message.role === 'edit') return [];
    return [{
      role: message.role,
      sender: message.sender ?? null,
      text,
      timeLabel: message.time ?? null,
      index,
    }];
  });
}

export function combineContext(...parts: Array<string | null | undefined>) {
  const lines = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return lines.length > 0 ? lines.join('\n\n') : null;
}

function cleanText(value?: string | null) {
  return value?.trim() || null;
}

type CanonicalParticipant = NonNullable<Conversation['canonicalParticipants']>[number];

type ParticipantConversation = Pick<Conversation, 'canonicalParticipants'> | null | undefined;

function addOptionalField<T extends object>(target: T, key: string, value: string | null | undefined): T {
  if (value === null || value === undefined || value === '') return target;
  (target as Record<string, unknown>)[key] = value;
  return target;
}

function participantIsSelf(participant: Pick<CanonicalParticipant, 'kind' | 'role' | 'source'>) {
  return participant.role === 'self' || (participant.source === 'local' && participant.kind === 'human');
}

function isSelfReferencePeerLabel(value: string | null | undefined) {
  const trimmed = value?.trim().toLowerCase() ?? '';
  return trimmed === 'me' || trimmed === 'you';
}

export function promptIdentityForParticipant(participant: CanonicalParticipant): DesktopBridgePromptIdentity | null {
  const displayName = cleanText(participant.name);
  const kind = cleanText(participant.kind);
  if (!displayName || !kind) return null;

  let snapshot: DesktopBridgePromptIdentity = {
    identityId: cleanText(participant.id),
    displayName,
    kind,
  };
  snapshot = addOptionalField(snapshot, 'ownerIdentityId', cleanText(participant.ownerIdentityId));
  snapshot = addOptionalField(snapshot, 'ownerDisplayName', cleanText(participant.ownerName));
  snapshot = addOptionalField(snapshot, 'bridgeNodeId', cleanText(participant.bridgeNodeId));
  snapshot = addOptionalField(snapshot, 'humanId', cleanText(participant.humanId));
  snapshot = addOptionalField(snapshot, 'agentId', cleanText(participant.agentId));
  snapshot = addOptionalField(snapshot, 'runtime', cleanText(participant.runtime));
  return snapshot;
}

export function parentSessionParticipantsForOutreach(
  conversation: ParticipantConversation,
  options: { selfPublicName?: string | null } = {},
): DesktopBridgeSessionParticipant[] {
  const selfPublicName = cleanText(options.selfPublicName ?? undefined);
  const participants = new Map<string, DesktopBridgeSessionParticipant>();

  for (const participant of conversation?.canonicalParticipants ?? []) {
    const rawDisplayName = cleanText(participant.name);
    const kind = cleanText(participant.kind);
    if (!rawDisplayName || !kind) continue;

    const bridgeNodeId = cleanText(participant.bridgeNodeId);
    const humanId = cleanText(participant.humanId);
    const agentId = cleanText(participant.agentId);
    const isSelf = participantIsSelf(participant);
    if (isSelf && !bridgeNodeId && !humanId && !agentId) continue;

    const displayName = isSelf && kind === 'human' && isSelfReferencePeerLabel(rawDisplayName) && selfPublicName
      ? selfPublicName
      : rawDisplayName;

    let snapshot: DesktopBridgeSessionParticipant = {
      identityId: cleanText(participant.id),
      displayName,
      kind,
      role: isSelf ? 'self' : (cleanText(participant.role) ?? (kind === 'human' ? 'person' : 'delegate')),
    };
    snapshot = addOptionalField(snapshot, 'ownerIdentityId', cleanText(participant.ownerIdentityId));
    snapshot = addOptionalField(snapshot, 'ownerDisplayName', cleanText(participant.ownerName));
    snapshot = addOptionalField(snapshot, 'bridgeNodeId', bridgeNodeId);
    snapshot = addOptionalField(snapshot, 'humanId', humanId);
    snapshot = addOptionalField(snapshot, 'agentId', agentId);
    snapshot = addOptionalField(snapshot, 'runtime', cleanText(participant.runtime));

    const key = cleanText(participant.id) ?? [bridgeNodeId, humanId, agentId, kind, displayName].filter(Boolean).join(':');
    participants.set(key, snapshot);
  }

  return [...participants.values()];
}

function targetKindToParticipantKind(targetKind?: string | null) {
  return targetKind === 'bridge-agent' ? 'agent' : 'human';
}

function participantMatchesBridgeTarget(
  participant: CanonicalParticipant,
  target: Pick<ConversationBridgeTarget, 'nodeId' | 'humanId' | 'agentId'>,
) {
  const targetAgentId = cleanText(target.agentId);
  const targetHumanId = cleanText(target.humanId);
  const targetNodeId = cleanText(target.nodeId);
  if (targetAgentId && cleanText(participant.agentId) === targetAgentId) return true;
  if (targetHumanId && cleanText(participant.humanId) === targetHumanId) return true;
  if (targetNodeId && cleanText(participant.bridgeNodeId) === targetNodeId) return true;
  return false;
}

function canonicalParticipantForBridgeTarget(
  conversation: ParticipantConversation,
  target: Pick<ConversationBridgeTarget, 'nodeId' | 'humanId' | 'agentId'>,
  targetKind?: string | null,
) {
  const expectedKind = targetKindToParticipantKind(targetKind);
  const matches = (conversation?.canonicalParticipants ?? []).filter((participant) => participantMatchesBridgeTarget(participant, target));
  return matches.find((participant) => participant.kind === expectedKind) ?? matches[0] ?? null;
}

export function initiatorIdentityForOutreach(
  conversation: ParticipantConversation,
  canonicalHumanIdentityId?: string | null,
  fallbackDisplayName?: string | null,
): DesktopBridgePromptIdentity | null {
  const canonicalId = cleanText(canonicalHumanIdentityId);
  const participants = conversation?.canonicalParticipants ?? [];
  const participant = (canonicalId ? participants.find((candidate) => cleanText(candidate.id) === canonicalId) : null)
    ?? participants.find((candidate) => candidate.kind === 'human' && participantIsSelf(candidate))
    ?? null;
  if (participant) {
    const snapshot = promptIdentityForParticipant(participant);
    if (!snapshot) return null;
    const fallbackName = cleanText(fallbackDisplayName);
    if (
      participantIsSelf(participant)
      && cleanText(participant.kind) === 'human'
      && isSelfReferencePeerLabel(snapshot.displayName)
      && fallbackName
    ) {
      return { ...snapshot, displayName: fallbackName };
    }
    return snapshot;
  }
  if (!canonicalId) return null;
  return {
    identityId: canonicalId,
    displayName: cleanText(fallbackDisplayName) ?? canonicalId,
    kind: 'human',
  };
}

export function selfTargetIdentityForBridgeTarget(
  target: ConversationBridgeTarget,
  targetKind: 'bridge-agent' | 'bridge-person' | string,
  conversation?: ParticipantConversation,
): DesktopBridgePromptIdentity | null {
  const canonicalParticipant = canonicalParticipantForBridgeTarget(conversation, target, targetKind);
  const canonicalSnapshot = canonicalParticipant ? promptIdentityForParticipant(canonicalParticipant) : null;
  if (canonicalSnapshot) return canonicalSnapshot;

  const kind = targetKindToParticipantKind(targetKind);
  const displayName = cleanText(target.displayName) ?? cleanText(target.ownerName);
  if (!displayName) return null;

  let snapshot: DesktopBridgePromptIdentity = {
    identityId: null,
    displayName,
    kind,
  };
  if (kind === 'agent') {
    snapshot = addOptionalField(snapshot, 'ownerDisplayName', cleanText(target.ownerName));
  }
  snapshot = addOptionalField(snapshot, 'bridgeNodeId', cleanText(target.nodeId));
  snapshot = addOptionalField(snapshot, 'humanId', cleanText(target.humanId));
  snapshot = addOptionalField(snapshot, 'agentId', cleanText(target.agentId));
  snapshot = addOptionalField(snapshot, 'runtime', cleanText(target.runtime));
  return snapshot;
}

export function selfTargetIdentityForMentionedBridgeTarget(
  target: ResolvedMentionedBridgeTarget,
  conversation?: ParticipantConversation,
): DesktopBridgePromptIdentity | null {
  return selfTargetIdentityForBridgeTarget({
    hostId: target.host.id,
    nodeId: target.peer.nodeId,
    displayName: target.displayLabel,
    ownerName: target.peer.ownerName ?? null,
    runtime: target.peer.runtime,
    humanId: target.peer.humanId ?? null,
    agentId: target.peer.agentId ?? null,
  }, target.targetKind, conversation);
}
