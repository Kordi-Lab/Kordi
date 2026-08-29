import { isCollaborationAgentRuntime } from '@/features/collaboration/runtime';
import { possessiveScopedLabel, publicScopedAgentMentionHandle, rewriteLeadingFirstPersonAgentMention, stripSelfPossessivePrefix } from '@/lib/identityLabels';
import type { SharedCloudAgentSummary } from '@/features/cloud/cloudAgents';
import { defaultCloudAgentId } from '@/features/cloud/cloudAgentIdentity';
import type {
  Conversation,
  ConversationCollaborationTarget,
  DesktopCollaborationState,
  DesktopChatState,
} from '@/kordi-app/types';

import type { ResolvedMentionedCollaborationTarget } from './types';

export function outreachIdentityForCollaborationTarget(target: ResolvedMentionedCollaborationTarget) {
  const targetDisplayName = target.displayLabel;
  const targetOwnerName = target.peer.ownerName ?? null;
  const targetRuntime = target.peer.runtime;
  const targetHumanId = target.peer.humanId ?? null;
  const targetAgentId = target.peer.agentId ?? null;
  return {
    targetDisplayName,
    targetOwnerName,
    targetRuntime,
    targetHumanId,
    targetAgentId,
    selfTargetIdentity: {
      identityId: targetAgentId ? `agent:${targetAgentId}` : (targetHumanId ? `human:${targetHumanId}` : null),
      displayName: targetDisplayName,
      kind: target.targetKind === 'agent' ? 'agent' : 'human',
      ownerDisplayName: targetOwnerName,
      sourceIdentityId: target.peer.nodeId,
      humanId: targetHumanId,
      agentId: targetAgentId,
      runtime: targetRuntime,
    },
  };
}

export function mentionedPersonIsActiveCollaborationTarget(
  target: ResolvedMentionedCollaborationTarget,
  activeTarget?: ConversationCollaborationTarget | null,
) {
  if (target.targetKind !== 'person' || !activeTarget) return false;
  if (target.peer.humanId && activeTarget.humanId && target.peer.humanId === activeTarget.humanId) return true;
  return target.peer.nodeId === activeTarget.nodeId;
}


export type CollaborationMentionCandidate = {
  host: DesktopCollaborationState['hosts'][number];
  peer: DesktopCollaborationState['hosts'][number]['visiblePeers'][number];
  handle: string;
  normalizedHandle: string;
  displayLabel: string;
  targetKind: 'person' | 'agent';
};

function safeMentionCharacters(value: string) {
  return value.normalize('NFKC').match(/[\p{L}\p{N}]+/gu)?.join('') ?? '';
}

export function mentionHandleForLabel(value: string, fallback = 'Participant') {
  const handle = safeMentionCharacters(value) || safeMentionCharacters(fallback) || 'Participant';
  return handle.slice(0, 64);
}

export function normalizeMentionLabel(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizedOwnerKey(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? '';
}

function isSelfConversationParticipant(participant: { kind?: string | null; role?: string | null; source?: string | null }) {
  return participant.role === 'self'
    || (participant.source === 'local' && participant.kind === 'human');
}

function participantHumanIdentityKeys(participant: NonNullable<Conversation['canonicalParticipants']>[number]) {
  const participantId = participant.id?.trim() ? participant.id : null;
  return [
    participant.humanId,
    participant.sourceIdentityId,
    participantId,
    participantId?.startsWith('human:') ? participantId.slice('human:'.length) : null,
  ].map(normalizedOwnerKey).filter(Boolean);
}

function participantHumanNameKeys(participant: NonNullable<Conversation['canonicalParticipants']>[number]) {
  return [participant.ownerName, participant.name].map(normalizedOwnerKey).filter(Boolean);
}

function participantHumanOwnerKeys(participant: NonNullable<Conversation['canonicalParticipants']>[number]) {
  return [
    ...participantHumanIdentityKeys(participant),
    ...participantHumanNameKeys(participant),
  ];
}

function conversationParticipantNameKeys(participants: string[] | undefined) {
  return (participants ?? [])
    .map(normalizedOwnerKey)
    .filter((key) => key && !['me', 'you', 'my kordi', 'kordi'].includes(key));
}

export type MentionScopeConversation = object & Partial<Pick<Conversation, 'id' | 'canonicalSessionId' | 'type' | 'participantSpaceId' | 'canonicalParticipants' | 'participants' | 'directness' | 'collaborationTarget'>>;

function conversationHumanOwnerKeys(conversation: MentionScopeConversation | null | undefined) {
  const keys = new Set<string>();
  for (const participant of conversation?.canonicalParticipants ?? []) {
    if (participant.kind !== 'human') continue;
    for (const key of participantHumanOwnerKeys(participant)) {
      keys.add(key);
    }
  }
  for (const key of conversationParticipantNameKeys(conversation?.participants)) {
    keys.add(key);
  }
  return keys;
}

export function conversationHasGroupMentionScope(conversation: MentionScopeConversation | null | undefined) {
  if (!conversation) return false;
  if (conversation.participantSpaceId?.trim()) return true;
  if (/\bgroup\b/i.test(conversation.directness ?? '')) return true;
  const nonSelfHumanCount = (conversation.canonicalParticipants ?? []).filter((participant) => (
    participant.kind === 'human' && !isSelfConversationParticipant(participant)
  )).length;
  return nonSelfHumanCount > 1;
}

export function conversationHasParticipantMentionScope(conversation: MentionScopeConversation | null | undefined) {
  if (!conversation) return false;
  if (conversationHasGroupMentionScope(conversation)) return true;
  const humanKeys = conversationHumanOwnerKeys(conversation);
  const collaborationTargetIsPerson = conversation.collaborationTarget?.runtime === 'person' || conversation.collaborationTarget?.agentId === null;
  if (humanKeys.size === 0 && !collaborationTargetIsPerson) return false;
  const nonSelfHumanCount = (conversation.canonicalParticipants ?? []).filter((participant) => (
    participant.kind === 'human' && !isSelfConversationParticipant(participant)
  )).length;
  return nonSelfHumanCount > 0 || collaborationTargetIsPerson || /\b(?:direct|person|contact)\b/i.test(conversation.directness ?? '');
}

export function collaborationMentionOwnerMatchesConversationHumans(
  owner: Pick<DesktopCollaborationState['hosts'][number]['visiblePeers'][number], 'humanId' | 'ownerName'> & { nodeId?: string | null },
  conversation: MentionScopeConversation | null | undefined,
) {
  const ownerHumanKey = normalizedOwnerKey(owner.humanId);
  const ownerNodeKey = normalizedOwnerKey(owner.nodeId);
  const ownerNameKey = normalizedOwnerKey(owner.ownerName);
  let sawCanonicalNameMatch = false;

  for (const participant of conversation?.canonicalParticipants ?? []) {
    if (participant.kind !== 'human') continue;
    const identityKeys = participantHumanIdentityKeys(participant);
    if (ownerHumanKey && identityKeys.includes(ownerHumanKey)) return true;
    if (ownerNodeKey && identityKeys.includes(ownerNodeKey)) return true;

    if (!ownerNameKey || !participantHumanNameKeys(participant).includes(ownerNameKey)) continue;
    sawCanonicalNameMatch = true;
    // A same-name candidate with a different explicit human id is usually a
    // stale legacy registration; do not let the display-name fallback target it.
    if (!ownerHumanKey || identityKeys.length === 0) return true;
  }

  if (sawCanonicalNameMatch) return false;
  return Boolean(ownerNameKey && conversationParticipantNameKeys(conversation?.participants).includes(ownerNameKey));
}

export function filterCollaborationMentionCandidatesForConversation(
  candidates: CollaborationMentionCandidate[],
  conversation: MentionScopeConversation | null | undefined,
) {
  if (!conversationHasParticipantMentionScope(conversation)) return candidates;
  return dedupeCollaborationMentionCandidateHandles(
    candidates.filter((candidate) => collaborationMentionOwnerMatchesConversationHumans(candidate.peer, conversation)),
  );
}

function conversationContainsAccountId(conversation: MentionScopeConversation | null | undefined, accountId: string) {
  const key = normalizedOwnerKey(accountId);
  if (!key) return false;
  for (const participant of conversation?.canonicalParticipants ?? []) {
    if (participant.kind !== 'human') continue;
    if (participantHumanIdentityKeys(participant).includes(key)) return true;
  }
  const collaborationTarget = conversation?.collaborationTarget;
  if ((collaborationTarget?.runtime === 'person' || collaborationTarget?.agentId === null) && (
    normalizedOwnerKey(collaborationTarget.humanId) === key
    || normalizedOwnerKey(collaborationTarget.nodeId) === key
  )) return true;
  return conversationParticipantNameKeys(conversation?.participants).includes(key);
}

export type SharedCloudAgentMentionCandidate = {
  agent: SharedCloudAgentSummary;
  handle: string;
  normalizedHandle: string;
  displayLabel: string;
  detailLabel: string;
  targetKind: 'cloud-shared-agent';
  targetAgentId: string;
  targetOwnerAccountId: string;
};

export function sharedCloudAgentMentionCandidatesForConversation(
  agents: SharedCloudAgentSummary[],
  conversation: MentionScopeConversation | null | undefined,
  localAccountId?: string | null,
): SharedCloudAgentMentionCandidate[] {
  if (!conversationHasParticipantMentionScope(conversation)) return [];
  const localOwnerAccountId = normalizedOwnerKey(localAccountId);
  const localViewerIsParticipant = conversationImpliesLocalViewerParticipant(conversation);
  const candidates = agents
    .filter((agent) => conversationContainsAccountId(conversation, agent.ownerAccountId)
      || (localViewerIsParticipant && normalizedOwnerKey(agent.ownerAccountId) === localOwnerAccountId))
    .map((agent) => {
      const displayLabel = agent.name;
      const handle = mentionHandleForLabel(displayLabel, agent.agentId);
      const owner = agent.ownerDisplayName?.trim() || agent.ownerAccountId;
      return {
        agent,
        handle,
        normalizedHandle: normalizeMentionLabel(handle),
        displayLabel,
        detailLabel: `Owner · ${owner}`,
        targetKind: 'cloud-shared-agent' as const,
        targetAgentId: agent.agentId,
        targetOwnerAccountId: agent.ownerAccountId,
      };
    });

  const used = new Set<string>();
  return candidates.map((candidate) => {
    let handle = candidate.handle;
    let normalizedHandle = candidate.normalizedHandle;
    if (used.has(normalizedHandle)) {
      handle = uniqueHandle(candidate.handle, candidate.targetOwnerAccountId.slice(0, 8));
      normalizedHandle = normalizeMentionLabel(handle);
    }
    used.add(normalizedHandle);
    return { ...candidate, handle, normalizedHandle };
  });
}

function conversationImpliesLocalViewerParticipant(conversation: MentionScopeConversation | null | undefined) {
  if (!conversation) return false;
  if (conversationHasGroupMentionScope(conversation)) return true;
  return /\b(?:direct|person|contact|relationship)\b/i.test(conversation.directness ?? '');
}

export function shouldIncludeLocalAgentMentionForConversation(
  conversation: MentionScopeConversation | null | undefined,
  localOwner: Pick<DesktopCollaborationState['hosts'][number], 'humanId' | 'ownerName'>,
) {
  if (!conversationHasParticipantMentionScope(conversation)) return true;
  if (collaborationMentionOwnerMatchesConversationHumans(localOwner, conversation)) return true;

  // Legacy collaboration direct/group threads can list only remote people in the
  // session metadata. The local viewer is still a participant of the open chat,
  // so My Kordi must remain mentionable even when self metadata is absent.
  return conversationImpliesLocalViewerParticipant(conversation);
}

function normalizedSessionId(conversation: Pick<Conversation, 'id' | 'canonicalSessionId'>) {
  return (conversation.canonicalSessionId ?? conversation.id).trim();
}

function mentionScopeMetadata(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function mentionScopeMetadataText(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function mentionScopeConversationForActiveConversation<T extends MentionScopeConversation & Pick<Conversation, 'id' | 'canonicalSessionId' | 'metadata'>>(
  activeConversation: T,
  conversations: Array<T | Conversation>,
): T | (T & MentionScopeConversation) {
  const metadata = mentionScopeMetadata(activeConversation.metadata);
  const rootSessionId = mentionScopeMetadataText(metadata, 'continuedFromSessionId');
  if (!rootSessionId) return activeConversation;

  const rootConversation = conversations.find((conversation) => normalizedSessionId(conversation) === rootSessionId || conversation.id === rootSessionId);
  if (!rootConversation) return activeConversation;

  return {
    ...activeConversation,
    participantSpaceId: rootConversation.participantSpaceId ?? activeConversation.participantSpaceId,
    canonicalParticipants: rootConversation.canonicalParticipants?.length
      ? rootConversation.canonicalParticipants
      : activeConversation.canonicalParticipants,
    participants: rootConversation.participants?.length ? rootConversation.participants : activeConversation.participants,
    directness: rootConversation.directness ?? activeConversation.directness,
  };
}

export function filterCollaborationMentionCandidatesForHost(
  candidates: CollaborationMentionCandidate[],
  host: DesktopCollaborationState['hosts'][number] | null | undefined,
) {
  if (!host) return candidates;
  const hostHumanId = normalizedOwnerKey(host.humanId);
  const hostOwnerName = normalizedOwnerKey(host.ownerName);
  const hostNodeId = normalizedOwnerKey(host.nodeId);
  const hostAgentIds = new Set((host.agents ?? []).flatMap((agent) => [agent.id, agent.nodeId]).map(normalizedOwnerKey).filter(Boolean));

  return candidates.filter((candidate) => {
    const peerHumanId = normalizedOwnerKey(candidate.peer.humanId);
    const peerOwnerName = normalizedOwnerKey(candidate.peer.ownerName);
    const peerNodeId = normalizedOwnerKey(candidate.peer.nodeId);
    const peerAgentId = normalizedOwnerKey(candidate.peer.agentId);
    if (hostHumanId && peerHumanId === hostHumanId) return false;
    if (hostOwnerName && peerOwnerName === hostOwnerName) return false;
    if (hostNodeId && peerNodeId === hostNodeId) return false;
    if (peerAgentId && hostAgentIds.has(peerAgentId)) return false;
    if (peerNodeId && hostAgentIds.has(peerNodeId)) return false;
    return true;
  });
}

function identitySuffixForCandidate(candidate: Pick<CollaborationMentionCandidate, 'peer' | 'handle'>) {
  const source = candidate.peer.humanId?.trim()
    || candidate.peer.agentId?.trim()
    || candidate.peer.nodeId?.trim()
    || candidate.handle;
  return safeMentionCharacters(source).slice(0, 8) || 'target';
}

function uniqueHandle(baseHandle: string, suffix: string) {
  const cleanSuffix = safeMentionCharacters(suffix) || 'target';
  const availableBaseLength = Math.max(1, 64 - cleanSuffix.length);
  return `${baseHandle.slice(0, availableBaseLength)}${cleanSuffix}`;
}

function candidateWithBaseMentionHandle(candidate: CollaborationMentionCandidate) {
  const handle = candidate.targetKind === 'agent'
    && candidate.peer.displayName?.trim() !== candidate.displayLabel
    ? publicScopedAgentMentionHandle(
      candidate.peer.ownerName,
      candidate.displayLabel,
    )
    : mentionHandleForLabel(candidate.displayLabel, candidate.peer.nodeId);
  return { ...candidate, handle, normalizedHandle: normalizeMentionLabel(handle) };
}

function dedupeCollaborationMentionCandidateHandles(candidates: CollaborationMentionCandidate[]) {
  const baseCandidates = candidates.map(candidateWithBaseMentionHandle);
  const handleCounts = new Map<string, number>();
  for (const candidate of baseCandidates) {
    handleCounts.set(candidate.normalizedHandle, (handleCounts.get(candidate.normalizedHandle) ?? 0) + 1);
  }

  const usedHandles = new Set<string>();
  return baseCandidates.map((candidate) => {
    let handle = candidate.handle;
    if ((handleCounts.get(candidate.normalizedHandle) ?? 0) > 1) {
      handle = uniqueHandle(candidate.handle, identitySuffixForCandidate(candidate));
    }
    let normalizedHandle = normalizeMentionLabel(handle);
    let collisionIndex = 2;
    while (usedHandles.has(normalizedHandle)) {
      handle = uniqueHandle(candidate.handle, `${identitySuffixForCandidate(candidate)}${collisionIndex}`);
      normalizedHandle = normalizeMentionLabel(handle);
      collisionIndex += 1;
    }
    usedHandles.add(normalizedHandle);
    return { ...candidate, handle, normalizedHandle };
  });
}

function peerIsApprovedCollaborationContact(peer: DesktopCollaborationState['hosts'][number]['visiblePeers'][number]) {
  const status = peer.contactRequestStatus?.trim().toLowerCase() ?? '';
  return Boolean(peer.isContact || status === 'contact' || status === 'approved');
}

function agentCanBeMentionedDirectly(peer: DesktopCollaborationState['hosts'][number]['visiblePeers'][number]) {
  if (!isCollaborationAgentRuntime(peer.runtime)) return true;
  const agentReachabilityPolicy = peer.agentReachabilityPolicy?.trim().toLowerCase() || 'contacts';
  if (agentReachabilityPolicy === 'owner') return false;
  if (agentReachabilityPolicy === 'server') return true;
  return peerIsApprovedCollaborationContact(peer) || (peer.sharedProjects?.length ?? 0) > 0;
}

function peerPersonDedupeKeys(peer: DesktopCollaborationState['hosts'][number]['visiblePeers'][number]) {
  return [peer.humanId, peer.ownerName, peer.displayName, peer.nodeId]
    .map(normalizedOwnerKey)
    .filter(Boolean);
}

function hostHasExplicitPersonPeerForAgent(
  host: DesktopCollaborationState['hosts'][number],
  agentPeer: DesktopCollaborationState['hosts'][number]['visiblePeers'][number],
) {
  const agentKeys = new Set(peerPersonDedupeKeys(agentPeer));
  if (agentKeys.size === 0) return false;
  return host.visiblePeers.some((peer) => (
    peer !== agentPeer
    && !isCollaborationAgentRuntime(peer.runtime)
    && peerPersonDedupeKeys(peer).some((key) => agentKeys.has(key))
  ));
}

export function buildCollaborationMentionCandidates(collaborationState: DesktopCollaborationState | null) {
  if (!collaborationState) return [];

  const rawCandidates: CollaborationMentionCandidate[] = [];

  for (const host of collaborationState.hosts) {
    for (const peer of host.visiblePeers) {
      const isAgent = isCollaborationAgentRuntime(peer.runtime);
      const agentIsReachable = !isAgent || agentCanBeMentionedDirectly(peer);
      const seenForPeer = new Set<string>();
      const pushLabel = (value: string | null | undefined, targetKind: CollaborationMentionCandidate['targetKind']) => {
        const rawLabel = value?.trim();
        const displayLabel = targetKind === 'agent'
          ? stripSelfPossessivePrefix(rawLabel, peer.ownerName) || rawLabel
          : rawLabel;
        if (!displayLabel) return;
        const handle = mentionHandleForLabel(displayLabel, peer.nodeId);
        const dedupeKey = `${targetKind}:${normalizeMentionLabel(handle)}:${normalizeMentionLabel(displayLabel)}`;
        if (seenForPeer.has(dedupeKey)) return;
        seenForPeer.add(dedupeKey);
        rawCandidates.push({
          host,
          peer,
          targetKind,
          displayLabel,
          handle,
          normalizedHandle: normalizeMentionLabel(handle),
        });
      };

      const hasAgentLabel = agentIsReachable && Boolean(peer.displayName?.trim());
      const hasPersonLabel = Boolean(peer.ownerName?.trim() || (!isAgent && peer.displayName?.trim()));

      if (isAgent && peer.humanId?.trim() && (agentIsReachable || peer.isDefaultAgent) && !hostHasExplicitPersonPeerForAgent(host, peer)) {
        pushLabel(peer.ownerName, 'person');
      }
      if (!isAgent || agentIsReachable) {
        pushLabel(peer.displayName, isAgent ? 'agent' : 'person');
      }
      if (!isAgent) {
        pushLabel(peer.ownerName, 'person');
      }
      if (isAgent ? agentIsReachable && !hasAgentLabel : !hasPersonLabel) {
        pushLabel(peer.nodeId, isAgent ? 'agent' : 'person');
      }
    }
  }

  return dedupeCollaborationMentionCandidateHandles(rawCandidates);
}

export function collaborationMentionCandidateOptionText(candidate: CollaborationMentionCandidate) {
  return {
    label: candidate.displayLabel,
    detail: candidate.targetKind === 'person'
      ? 'Person'
      : candidate.peer.ownerName?.trim()
        ? `Owner · ${candidate.peer.ownerName.trim()}`
        : 'Agent',
  };
}

export function scopedAgentLabel(ownerName: string | null | undefined, agentLabel: string | null | undefined, ownerIsSelf = false) {
  const label = agentLabel?.trim();
  if (!label) return null;
  const owner = ownerName?.trim();
  if (!owner) return label;
  return possessiveScopedLabel(owner, label, ownerIsSelf);
}

export function localCollaborationAgentLabels(collaborationState: DesktopCollaborationState | null) {
  const activeHost = collaborationState?.hosts.find((host) => host.id === collaborationState.activeHostId)
    ?? collaborationState?.hosts[0]
    ?? null;
  const activeAgent = activeHost?.agents.find((agent) => agent.id === activeHost.activeAgentId)
    ?? activeHost?.agents.find((agent) => agent.isActive)
    ?? activeHost?.agents.find((agent) => agent.isDefault)
    ?? activeHost?.agents[0]
    ?? null;
  const ownerName = activeHost?.ownerName?.trim();
  const agentLabel = activeAgent?.label?.trim();
  return [
    agentLabel,
    scopedAgentLabel(ownerName, 'Kordi', true),
    scopedAgentLabel(ownerName, agentLabel || 'Kordi', true),
    scopedAgentLabel(ownerName, 'Kordi'),
    scopedAgentLabel(ownerName, agentLabel || 'Kordi'),
    activeAgent?.id,
    activeAgent?.nodeId,
  ];
}

function activeCollaborationHostAndAgent(collaborationState: DesktopCollaborationState | null) {
  const activeHost = collaborationState?.hosts.find((host) => host.id === collaborationState.activeHostId)
    ?? collaborationState?.hosts[0]
    ?? null;
  const activeAgent = activeHost?.agents.find((agent) => agent.id === activeHost.activeAgentId)
    ?? activeHost?.agents.find((agent) => agent.isActive)
    ?? activeHost?.agents.find((agent) => agent.isDefault)
    ?? activeHost?.agents[0]
    ?? null;
  return { activeHost, activeAgent };
}

export function localAgentMentionLabels(state: DesktopChatState | null, collaborationState: DesktopCollaborationState | null) {
  const labels = [
    'Kordi',
    state?.localAgent?.label,
    ...localCollaborationAgentLabels(collaborationState),
    (() => {
      const parts = state?.localAgent?.workspaceRoot?.split(/[\\/]/).filter(Boolean) ?? [];
      return parts[parts.length - 1];
    })(),
  ];

  return Array.from(new Set(
    labels
      .map((label) => label?.trim())
      .filter((label): label is string => Boolean(label))
      .map((label) => mentionHandleForLabel(label, 'Kordi')),
  ));
}

export function mentionsLocalAgent(text: string, state: DesktopChatState | null, collaborationState: DesktopCollaborationState | null) {
  const afterAt = text.replace(/^\s*@/, '');
  return localAgentMentionLabels(state, collaborationState).some((label) => mentionTextStartsWithLabel(afterAt, label));
}

export function resolveMentionedLocalAgentTarget(
  text: string,
  state: DesktopChatState | null,
  collaborationState: DesktopCollaborationState | null,
) {
  if (!mentionsLocalAgent(text, state, collaborationState)) return null;
  const { activeHost, activeAgent } = activeCollaborationHostAndAgent(collaborationState);
  const ownerAccountId = activeHost?.humanId?.trim() || activeHost?.nodeId?.trim();
  if (!activeHost || !activeAgent || !ownerAccountId) return null;
  const displayLabel = state?.localAgent?.label?.trim() || activeAgent.label?.trim() || 'Kordi';
  const label = mentionHandleForLabel(displayLabel, activeAgent.id || ownerAccountId);
  const peer = {
    endpoint: activeHost.endpoint,
    nodeId: activeAgent.nodeId?.trim() || ownerAccountId,
    displayName: displayLabel,
    ownerName: activeHost.ownerName,
    runtime: activeAgent.runtime,
    humanId: ownerAccountId,
    agentId: defaultCloudAgentId(ownerAccountId),
  } as DesktopCollaborationState['hosts'][number]['visiblePeers'][number];
  return {
    host: activeHost,
    peer,
    label,
    displayLabel,
    targetKind: 'agent' as const,
    requestText: stripLeadingAddressMentions(text, [displayLabel, label, 'Kordi', 'My Kordi']).trim(),
  };
}

function publicLocalAgentMentionLabel(collaborationState: DesktopCollaborationState | null) {
  const { activeHost, activeAgent } = activeCollaborationHostAndAgent(collaborationState);
  return publicScopedAgentMentionHandle(activeHost?.ownerName, activeAgent?.label || 'Kordi');
}

export function publicLocalAgentMentionText(text: string, collaborationState: DesktopCollaborationState | null) {
  const leading = /^\s*/.exec(text)?.[0] ?? '';
  if (!text.slice(leading.length).startsWith('@')) return text;
  const afterAt = text.slice(leading.length + 1);
  const labels = localAgentMentionLabels(null, collaborationState)
    .sort((left, right) => normalizeMentionLabel(right).length - normalizeMentionLabel(left).length);
  for (const label of labels) {
    const rest = leadingAddressRest(afterAt, label);
    if (rest === null) continue;
    return `${leading}@${publicLocalAgentMentionLabel(collaborationState)}${rest ? ` ${rest}` : ''}`;
  }
  return rewriteLeadingFirstPersonAgentMention(text, activeCollaborationHostAndAgent(collaborationState).activeHost?.ownerName, 'Kordi');
}

export function leadingAddressRest(textAfterAt: string, label: string) {
  const cleanLabel = label.trim();
  if (!cleanLabel) return null;
  const candidate = textAfterAt.slice(0, cleanLabel.length);
  if (candidate.toLocaleLowerCase() !== cleanLabel.toLocaleLowerCase()) return null;
  let rest = textAfterAt.slice(cleanLabel.length);
  const next = rest[0];
  if (next && !/[\s:;,.!?—-]/.test(next)) return null;
  rest = rest.trimStart();
  if (/^[:;,.!?—-]/.test(rest)) {
    rest = rest.slice(1).trimStart();
  }
  return rest;
}

export function stripLeadingAddressMentions(text: string, labels: Array<string | null | undefined>) {
  let current = text.trimStart();
  const sortedLabels = Array.from(new Set(
    labels
      .map((label) => label?.trim())
      .filter((label): label is string => Boolean(label)),
  )).sort((left, right) => right.length - left.length);

  while (current.startsWith('@')) {
    const afterAt = current.slice(1);
    const rest = sortedLabels.map((label) => leadingAddressRest(afterAt, label)).find((value) => value !== null);
    if (rest === undefined || rest === null || rest.trim() === current.trim() || rest.trim().length === 0) break;
    current = rest.trimStart();
  }

  return current;
}

export function localHumanAddressLabels(collaborationState: DesktopCollaborationState | null) {
  const activeHost = collaborationState?.hosts.find((host) => host.id === collaborationState.activeHostId)
    ?? collaborationState?.hosts[0]
    ?? null;
  return [activeHost?.ownerName, activeHost?.displayName];
}

export function localAgentRuntimeText(text: string, state: DesktopChatState | null, collaborationState: DesktopCollaborationState | null) {
  const leading = /^\s*/.exec(text)?.[0] ?? '';
  if (!text.slice(leading.length).startsWith('@')) return text;
  const afterAt = text.slice(leading.length + 1);
  const labels = localAgentMentionLabels(state, collaborationState)
    .filter((label) => normalizeMentionLabel(label) !== normalizeMentionLabel('Kordi'))
    .sort((left, right) => normalizeMentionLabel(right).length - normalizeMentionLabel(left).length);
  for (const label of labels) {
    if (!mentionTextStartsWithLabel(afterAt, label)) continue;
    let mentionEnd = leading.length + 1 + label.length;
    if (/[:;,.!?—-]/.test(text[mentionEnd] ?? '')) {
      mentionEnd += 1;
    }
    return `${leading}@Kordi${text.slice(mentionEnd)}`;
  }
  return text;
}


export function mentionTextStartsWithLabel(text: string, label: string) {
  const normalizedText = normalizeMentionLabel(text);
  const normalizedLabel = normalizeMentionLabel(label);
  if (normalizedText === normalizedLabel) return true;
  if (!normalizedText.startsWith(normalizedLabel)) return false;
  const next = normalizedText.slice(normalizedLabel.length, normalizedLabel.length + 1);
  return !next || /[\s:;,.!?—-]/.test(next);
}

export type ResolveMentionedCollaborationTargetOptions = {
  targetKind?: CollaborationMentionCandidate['targetKind'];
  sharedCloudAgents?: SharedCloudAgentSummary[];
  localAccountId?: string | null;
};

export function resolveMentionedCollaborationTarget(
  text: string,
  collaborationState: DesktopCollaborationState | null,
  conversation?: MentionScopeConversation | null,
  options: ResolveMentionedCollaborationTargetOptions = {},
) {
  const scopedCandidates = filterCollaborationMentionCandidatesForConversation(buildCollaborationMentionCandidates(collaborationState), conversation);
  const candidates = options.targetKind
    ? scopedCandidates.filter((candidate) => candidate.targetKind === options.targetKind)
    : scopedCandidates;
  const sharedCandidates = options.targetKind && options.targetKind !== 'agent'
    ? []
    : sharedCloudAgentMentionCandidatesForConversation(options.sharedCloudAgents ?? [], conversation, options.localAccountId);
  if (candidates.length === 0 && sharedCandidates.length === 0) return null;
  const mentionMatches = Array.from(text.matchAll(/(^|\s)@/g));
  if (mentionMatches.length === 0) return null;

  for (const mention of mentionMatches) {
    const mentionStart = (mention.index ?? 0) + mention[1].length;
    const rawAfterAt = text.slice(mentionStart + 1);
    const leadingWhitespace = rawAfterAt.length - rawAfterAt.trimStart().length;
    const afterAt = rawAfterAt.trimStart();
    if (!afterAt) continue;
    if (mentionTextStartsWithLabel(afterAt, 'all')) continue;

    const sharedMatch = sharedCandidates
      .filter((candidate) => mentionTextStartsWithLabel(afterAt, candidate.handle) || mentionTextStartsWithLabel(afterAt, candidate.displayLabel))
      .sort((left, right) => right.normalizedHandle.length - left.normalizedHandle.length)[0] ?? null;
    if (sharedMatch) {
      const matchedLabel = mentionTextStartsWithLabel(afterAt, sharedMatch.handle) ? sharedMatch.handle : sharedMatch.displayLabel;
      let mentionEnd = mentionStart + 1 + leadingWhitespace + matchedLabel.length;
      if (/[:;,.!?—-]/.test(text[mentionEnd] ?? '')) {
        mentionEnd += 1;
      }
      const requestText = `${text.slice(0, mentionStart)}${text.slice(mentionEnd)}`.replace(/\s+/g, ' ').trim();
      if (!requestText) continue;
      const host = {
        id: 'cloud',
        nodeId: 'cloud',
        ownerName: sharedMatch.agent.ownerDisplayName ?? sharedMatch.targetOwnerAccountId,
        displayName: sharedMatch.agent.ownerDisplayName ?? sharedMatch.targetOwnerAccountId,
        humanId: sharedMatch.targetOwnerAccountId,
        agents: [],
        visiblePeers: [],
      } as unknown as DesktopCollaborationState['hosts'][number];
      const peer = {
        nodeId: sharedMatch.targetOwnerAccountId,
        displayName: sharedMatch.displayLabel,
        ownerName: sharedMatch.agent.ownerDisplayName ?? sharedMatch.targetOwnerAccountId,
        runtime: 'kordi-cloud-agent',
        humanId: sharedMatch.targetOwnerAccountId,
        agentId: sharedMatch.targetAgentId,
      } as DesktopCollaborationState['hosts'][number]['visiblePeers'][number];
      return {
        host,
        peer,
        label: sharedMatch.handle,
        displayLabel: sharedMatch.displayLabel,
        targetKind: 'agent' as const,
        requestText,
      };
    }

    const safeMatches = candidates
      .filter((candidate) => mentionTextStartsWithLabel(afterAt, candidate.handle))
      .sort((left, right) => right.normalizedHandle.length - left.normalizedHandle.length);

    const legacyHandleMatches = safeMatches.length > 0
      ? []
      : candidates.filter((candidate) => {
        if (candidate.targetKind !== 'agent') return false;
        const legacyLabel = candidate.peer.displayName?.trim();
        return Boolean(
          legacyLabel
          && mentionTextStartsWithLabel(
            afterAt,
            mentionHandleForLabel(legacyLabel, candidate.peer.nodeId),
          ),
        );
      });
    const legacyMatches = safeMatches.length > 0 || legacyHandleMatches.length > 0
      ? []
      : candidates.filter((candidate) => (
        mentionTextStartsWithLabel(afterAt, candidate.displayLabel)
        || Boolean(
          candidate.targetKind === 'agent'
          &&
          candidate.peer.displayName?.trim()
          && mentionTextStartsWithLabel(afterAt, candidate.peer.displayName),
        )
      ));

    const fallbackMatches = legacyHandleMatches.length > 0
      ? legacyHandleMatches
      : legacyMatches;
    const legacyNormalizedKeys = new Set(fallbackMatches.map((candidate) => `${candidate.targetKind}:${candidate.host.id}:${candidate.peer.nodeId}`));
    const match = safeMatches[0]
      ?? (legacyNormalizedKeys.size === 1 ? fallbackMatches[0] : null);
    if (!match) continue;

    const matchedLabel = safeMatches.length > 0
      ? match.handle
      : legacyHandleMatches.length > 0
        ? mentionHandleForLabel(
          match.peer.displayName || match.displayLabel,
          match.peer.nodeId,
        )
        : mentionTextStartsWithLabel(afterAt, match.displayLabel)
          ? match.displayLabel
          : match.peer.displayName || match.displayLabel;
    let mentionEnd = mentionStart + 1 + leadingWhitespace + matchedLabel.length;
    if (/[:;,.!?—-]/.test(text[mentionEnd] ?? '')) {
      mentionEnd += 1;
    }
    const requestText = `${text.slice(0, mentionStart)}${text.slice(mentionEnd)}`.replace(/\s+/g, ' ').trim();
    if (!requestText) continue;

    return {
      host: match.host,
      peer: match.peer,
      label: match.handle,
      displayLabel: match.displayLabel,
      targetKind: match.targetKind,
      requestText,
    };
  }

  return null;
}

export async function resolveMentionedCollaborationAgentTargetWithSharedCloudAgentRefresh(
  text: string,
  collaborationState: DesktopCollaborationState | null,
  conversation: MentionScopeConversation | null | undefined,
  sharedCloudAgents: SharedCloudAgentSummary[] = [],
  refreshSharedCloudAgents?: () => Promise<SharedCloudAgentSummary[]>,
) {
  let mentionableCloudAgentsForSend = sharedCloudAgents;
  const activeHost = collaborationState?.hosts.find((host) => host.id === collaborationState.activeHostId)
    ?? collaborationState?.hosts[0]
    ?? null;
  const localAccountId = activeHost?.humanId ?? activeHost?.nodeId ?? null;
  let mentionedTarget = resolveMentionedCollaborationTarget(text, collaborationState, conversation, {
    targetKind: 'agent',
    sharedCloudAgents: mentionableCloudAgentsForSend,
    localAccountId,
  });
  if (!mentionedTarget && text.includes('@') && refreshSharedCloudAgents) {
    const refreshedCloudAgents = await refreshSharedCloudAgents().catch(() => []);
    if (refreshedCloudAgents.length > 0) {
      const byId = new Map(mentionableCloudAgentsForSend.map((agent) => [agent.agentId, agent]));
      for (const agent of refreshedCloudAgents) byId.set(agent.agentId, agent);
      mentionableCloudAgentsForSend = [...byId.values()];
      mentionedTarget = resolveMentionedCollaborationTarget(text, collaborationState, conversation, {
        targetKind: 'agent',
        sharedCloudAgents: mentionableCloudAgentsForSend,
        localAccountId,
      });
    }
  }
  return mentionedTarget;
}

export function insertMentionIntoDraft(current: string, label: string) {
  const mention = `@${label}`;
  const match = /(^|\s)@([^\s@\n\r]*)$/.exec(current);
  if (match && typeof match.index === 'number') {
    return `${current.slice(0, match.index)}${match[1]}${mention} `;
  }
  if (!current.trim()) {
    return `${mention} `;
  }
  return `${mention} ${current}`;
}
