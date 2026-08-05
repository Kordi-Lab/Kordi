import { isCollaborationAgentRuntime } from '@/features/collaboration/runtime';
import type {
  Conversation,
  ConversationCollaborationTarget,
  DesktopCollaborationSessionParticipant,
  DesktopCollaborationState,
} from '@/kordi-app/types';

function cleanText(value?: string | null) {
  return value?.trim() || null;
}

function collaborationTargetIsAgent(target?: ConversationCollaborationTarget | null) {
  const runtime = cleanText(target?.runtime);
  return Boolean(cleanText(target?.agentId) || (runtime && isCollaborationAgentRuntime(runtime)));
}

function participantIsSelf(participant: NonNullable<Conversation['canonicalParticipants']>[number]) {
  return participant.role === 'self' || (participant.source === 'local' && participant.kind === 'human');
}

function asSelfCollaborationNodeIdSet(
  value?: ReadonlySet<string> | Iterable<string | null | undefined> | null,
) {
  if (!value) return new Set<string>();
  if (value instanceof Set) return value;
  const result = new Set<string>();
  for (const entry of value) {
    const cleaned = cleanText(entry);
    if (cleaned) result.add(cleaned);
  }
  return result;
}

function isSelfReferencePeerLabel(value: string | null | undefined) {
  const trimmed = value?.trim().toLowerCase() ?? '';
  return trimmed === 'me' || trimmed === 'you';
}

export function collaborationSessionOutreachTarget(target: ConversationCollaborationTarget) {
  const targetIsAgent = collaborationTargetIsAgent(target);
  const displayName = cleanText(target.displayName) ?? cleanText(target.ownerName);
  const ownerName = cleanText(target.ownerName) ?? (targetIsAgent ? null : displayName);
  return {
    targetKind: targetIsAgent ? 'agent' as const : 'person' as const,
    targetRuntime: targetIsAgent ? (cleanText(target.runtime) ?? 'kordi-desktop') : 'person',
    targetDisplayName: displayName,
    targetOwnerName: ownerName,
    targetHumanId: targetIsAgent ? null : cleanText(target.humanId),
    targetAgentId: targetIsAgent ? cleanText(target.agentId) : null,
  };
}

export function isCollaborationGroupSession(conversation?: {
  canonicalSessionId?: string | null;
  participantSpaceId?: string | null;
  directness?: string | null;
  canonicalParticipants?: Conversation['canonicalParticipants'];
} | null) {
  if (!conversation) return false;
  if (conversation.canonicalSessionId?.startsWith('session:group:')) return true;
  if (conversation.participantSpaceId?.startsWith('group:')) return true;
  if (/\bgroup\b/i.test(conversation.directness ?? '')) return true;
  const humanCount = (conversation.canonicalParticipants ?? [])
    .filter((participant) => participant.kind === 'human' && !participantIsSelf(participant))
    .length;
  return humanCount > 1;
}

export function collaborationGroupSessionSpaceId(conversation?: {
  canonicalSessionId?: string | null;
  participantSpaceId?: string | null;
} | null) {
  const participantSpaceId = cleanText(conversation?.participantSpaceId);
  if (participantSpaceId) {
    return participantSpaceId.startsWith('group:') ? participantSpaceId.slice('group:'.length) : participantSpaceId;
  }
  return cleanText(conversation?.canonicalSessionId);
}

export function collaborationGroupSessionSendTargets(
  conversation: Pick<Conversation, 'canonicalParticipants'>,
  fallbackTarget?: ConversationCollaborationTarget | null,
  selfCollaborationNodeIds?: ReadonlySet<string> | Iterable<string | null | undefined> | null,
) {
  const targets = new Map<string, ConversationCollaborationTarget>();
  const fallbackHostId = cleanText(fallbackTarget?.hostId);
  const selfNodeIdSet = asSelfCollaborationNodeIdSet(selfCollaborationNodeIds);

  for (const participant of conversation.canonicalParticipants ?? []) {
    if (participant.kind !== 'human' || participantIsSelf(participant)) continue;
    const nodeId = cleanText(participant.sourceIdentityId);
    if (nodeId && selfNodeIdSet.has(nodeId)) continue;
    const hostId = cleanText(participant.sourceHostId) ?? fallbackHostId;
    if (!nodeId || !hostId) continue;
    targets.set(`${hostId}:${nodeId}:${cleanText(participant.humanId) ?? ''}`, {
      hostId,
      nodeId,
      displayName: cleanText(participant.name),
      ownerName: cleanText(participant.ownerName) ?? cleanText(participant.name),
      runtime: 'person',
      humanId: cleanText(participant.humanId),
      agentId: null,
    });
  }

  if (targets.size === 0
    && fallbackTarget?.hostId
    && fallbackTarget.nodeId
    && !selfNodeIdSet.has(fallbackTarget.nodeId)
  ) {
    targets.set(`${fallbackTarget.hostId}:${fallbackTarget.nodeId}:${fallbackTarget.humanId ?? ''}`, {
      ...fallbackTarget,
      runtime: 'person',
      agentId: null,
    });
  }

  return [...targets.values()];
}

export function shouldUseCollaborationConversationRouting({
  activeConversationUsesCollaboration,
  activeConvCollaborationTarget,
  activeGroupSessionScope,
  selfCollaborationNodeIds,
  forceCollaborationRouting = false,
}: {
  activeConversationUsesCollaboration: boolean;
  activeConvCollaborationTarget?: ConversationCollaborationTarget | null;
  activeGroupSessionScope?: (Pick<Conversation, 'canonicalParticipants'> & {
    canonicalSessionId?: string | null;
    participantSpaceId?: string | null;
    directness?: string | null;
  }) | null;
  selfCollaborationNodeIds?: ReadonlySet<string> | Iterable<string | null | undefined> | null;
  forceCollaborationRouting?: boolean;
}) {
  return forceCollaborationRouting
    || activeConversationUsesCollaboration
    || Boolean(activeConvCollaborationTarget)
    || Boolean(
      isCollaborationGroupSession(activeGroupSessionScope)
      && collaborationGroupSessionSendTargets(
        activeGroupSessionScope ?? {},
        activeConvCollaborationTarget,
        selfCollaborationNodeIds,
      ).length > 0,
    );
}

export function collaborationLocalAgentMentionCanRelay({
  activeGroupSessionIsGroup,
  activeConvCollaborationTarget,
  hasLocalAgentMention,
}: {
  activeGroupSessionIsGroup: boolean;
  activeConvCollaborationTarget?: ConversationCollaborationTarget | null;
  hasLocalAgentMention: boolean;
}) {
  return Boolean(hasLocalAgentMention && (activeGroupSessionIsGroup || activeConvCollaborationTarget));
}

export function collaborationLocalAgentRelayTargets(
  conversation: { canonicalParticipants?: Conversation['canonicalParticipants']; directness?: string | null },
  fallbackTarget?: ConversationCollaborationTarget | null,
  selfCollaborationNodeIds?: ReadonlySet<string> | Iterable<string | null | undefined> | null,
) {
  if (isCollaborationGroupSession(conversation)) {
    return collaborationGroupSessionSendTargets(conversation, fallbackTarget, selfCollaborationNodeIds);
  }
  if (!fallbackTarget?.hostId || !fallbackTarget.nodeId) return [];
  const selfNodeIdSet = asSelfCollaborationNodeIdSet(selfCollaborationNodeIds);
  if (selfNodeIdSet.has(fallbackTarget.nodeId)) return [];
  return [{ ...fallbackTarget, runtime: 'person', agentId: null }];
}

export function collaborationGroupMentionRelayTargets(
  conversation: Pick<Conversation, 'canonicalParticipants'> & { directness?: string | null },
  mentionedTarget?: { peer?: { nodeId?: string | null; humanId?: string | null } | null } | null,
  fallbackTarget?: ConversationCollaborationTarget | null,
  selfCollaborationNodeIds?: ReadonlySet<string> | Iterable<string | null | undefined> | null,
) {
  if (!isCollaborationGroupSession(conversation)) return [];
  const mentionedNodeId = cleanText(mentionedTarget?.peer?.nodeId);
  const mentionedHumanId = cleanText(mentionedTarget?.peer?.humanId);
  return collaborationGroupSessionSendTargets(
    conversation,
    fallbackTarget,
    selfCollaborationNodeIds,
  ).filter((target) => {
    if (mentionedHumanId && target.humanId === mentionedHumanId) return false;
    if (mentionedNodeId && target.nodeId === mentionedNodeId) return false;
    return true;
  });
}

export function collaborationGroupSessionParticipants(
  conversation: Pick<Conversation, 'canonicalParticipants'>,
  options: { selfPublicName?: string | null } = {},
): DesktopCollaborationSessionParticipant[] {
  const selfPublicName = cleanText(options.selfPublicName ?? undefined);
  const participants = new Map<string, DesktopCollaborationSessionParticipant>();
  for (const participant of conversation.canonicalParticipants ?? []) {
    if (participant.kind !== 'human') continue;
    const rawDisplayName = cleanText(participant.name);
    if (!rawDisplayName) continue;
    const sourceIdentityId = cleanText(participant.sourceIdentityId);
    const humanId = cleanText(participant.humanId);
    const isSelf = participantIsSelf(participant);
    if (isSelf && !sourceIdentityId && !humanId) continue;
    const displayName = isSelf && isSelfReferencePeerLabel(rawDisplayName) && selfPublicName
      ? selfPublicName
      : rawDisplayName;
    participants.set(participant.id || `${sourceIdentityId ?? ''}:${humanId ?? ''}:${displayName}`, {
      identityId: cleanText(participant.id),
      displayName,
      kind: 'human',
      role: isSelf ? 'self' : (cleanText(participant.role) ?? 'person'),
      sourceIdentityId,
      humanId,
      runtime: 'person',
    });
  }
  return [...participants.values()];
}

export function collaborationDirectSessionParticipants(
  conversation: Pick<Conversation, 'canonicalParticipants'>,
  activeCollaborationHost: DesktopCollaborationState['hosts'][number] | null | undefined,
  activeTarget: ConversationCollaborationTarget | null | undefined,
  options: { selfPublicName?: string | null } = {},
): DesktopCollaborationSessionParticipant[] {
  const canonicalParticipants = collaborationGroupSessionParticipants(conversation, options);
  if (canonicalParticipants.length > 0) return canonicalParticipants;

  const participants: DesktopCollaborationSessionParticipant[] = [];
  const selfDisplayName = cleanText(options.selfPublicName)
    || cleanText(activeCollaborationHost?.ownerName)
    || cleanText(activeCollaborationHost?.displayName)
    || 'Me';
  const selfNodeId = cleanText(activeCollaborationHost?.nodeId);
  const selfHumanId = cleanText(activeCollaborationHost?.humanId);
  if (selfNodeId || selfHumanId) {
    participants.push({
      identityId: selfHumanId ? `human:${selfHumanId}` : null,
      displayName: selfDisplayName,
      kind: 'human',
      role: 'self',
      sourceIdentityId: selfNodeId,
      humanId: selfHumanId,
      runtime: 'person',
    });
  }

  const targetNodeId = cleanText(activeTarget?.nodeId);
  const targetHumanId = cleanText(activeTarget?.humanId);
  const targetDisplayName = cleanText(activeTarget?.ownerName)
    || cleanText(activeTarget?.displayName)
    || targetHumanId
    || targetNodeId;
  if (targetDisplayName && (targetNodeId || targetHumanId)) {
    participants.push({
      identityId: targetHumanId ? `human:${targetHumanId}` : null,
      displayName: targetDisplayName,
      kind: 'human',
      role: 'person',
      sourceIdentityId: targetNodeId,
      humanId: targetHumanId,
      runtime: 'person',
    });
  }
  return participants;
}
