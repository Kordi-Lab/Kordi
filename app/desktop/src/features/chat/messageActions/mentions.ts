import { isBridgeAgentRuntime } from '@/features/bridge/runtime';
import { possessiveScopedLabel, publicScopedAgentMentionHandle, rewriteLeadingFirstPersonAgentMention } from '@/lib/identityLabels';
import type {
  Conversation,
  ConversationBridgeTarget,
  DesktopBridgeState,
  DesktopChatState,
  MessageMention,
} from '@/kordi-app/types';

import type { ResolvedMentionedBridgeTarget } from './types';

export function mentionForBridgeTarget(target: ResolvedMentionedBridgeTarget | null): MessageMention[] {
  if (!target) return [];
  return [{
    label: target.label,
    targetKind: target.targetKind,
    bridgeHostId: target.host.id,
    nodeId: target.peer.nodeId,
    humanId: target.peer.humanId ?? null,
    agentId: target.peer.agentId ?? null,
  }];
}

export function outreachIdentityForBridgeTarget(target: ResolvedMentionedBridgeTarget) {
  return {
    targetDisplayName: target.displayLabel,
    targetOwnerName: target.peer.ownerName ?? null,
    targetRuntime: target.peer.runtime,
    targetHumanId: target.peer.humanId ?? null,
    targetAgentId: target.peer.agentId ?? null,
  };
}

export function mentionedPersonIsActiveBridgeTarget(
  target: ResolvedMentionedBridgeTarget,
  activeTarget?: ConversationBridgeTarget | null,
) {
  if (target.targetKind !== 'bridge-person' || !activeTarget) return false;
  if (target.peer.humanId && activeTarget.humanId && target.peer.humanId === activeTarget.humanId) return true;
  return target.peer.nodeId === activeTarget.nodeId;
}


export type BridgeMentionCandidate = {
  host: DesktopBridgeState['hosts'][number];
  peer: DesktopBridgeState['hosts'][number]['visiblePeers'][number];
  handle: string;
  normalizedHandle: string;
  displayLabel: string;
  targetKind: 'bridge-person' | 'bridge-agent';
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
    participant.bridgeNodeId,
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

export type MentionScopeConversation = object & Partial<Pick<Conversation, 'participantSpaceId' | 'canonicalParticipants' | 'participants' | 'directness'>>;

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
  if (humanKeys.size === 0) return false;
  const nonSelfHumanCount = (conversation.canonicalParticipants ?? []).filter((participant) => (
    participant.kind === 'human' && !isSelfConversationParticipant(participant)
  )).length;
  return nonSelfHumanCount > 0 || /\b(?:direct|person|contact)\b/i.test(conversation.directness ?? '');
}

export function bridgeMentionOwnerMatchesConversationHumans(
  owner: Pick<DesktopBridgeState['hosts'][number]['visiblePeers'][number], 'humanId' | 'ownerName'> & { nodeId?: string | null },
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
    // stale Bridge registration; do not let the display-name fallback target it.
    if (!ownerHumanKey || identityKeys.length === 0) return true;
  }

  if (sawCanonicalNameMatch) return false;
  return Boolean(ownerNameKey && conversationParticipantNameKeys(conversation?.participants).includes(ownerNameKey));
}

export function filterBridgeMentionCandidatesForConversation(
  candidates: BridgeMentionCandidate[],
  conversation: MentionScopeConversation | null | undefined,
) {
  if (!conversationHasParticipantMentionScope(conversation)) return candidates;
  return dedupeBridgeMentionCandidateHandles(
    candidates.filter((candidate) => bridgeMentionOwnerMatchesConversationHumans(candidate.peer, conversation)),
  );
}

function conversationImpliesLocalViewerParticipant(conversation: MentionScopeConversation | null | undefined) {
  if (!conversation) return false;
  if (conversationHasGroupMentionScope(conversation)) return true;
  return /\b(?:direct|person|contact|relationship)\b/i.test(conversation.directness ?? '');
}

export function shouldIncludeLocalAgentMentionForConversation(
  conversation: MentionScopeConversation | null | undefined,
  localOwner: Pick<DesktopBridgeState['hosts'][number], 'humanId' | 'ownerName'>,
) {
  if (!conversationHasParticipantMentionScope(conversation)) return true;
  if (bridgeMentionOwnerMatchesConversationHumans(localOwner, conversation)) return true;

  // Bridge-sourced direct/group threads can list only remote people in the
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

export function filterBridgeMentionCandidatesForHost(
  candidates: BridgeMentionCandidate[],
  host: DesktopBridgeState['hosts'][number] | null | undefined,
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

function identitySuffixForCandidate(candidate: Pick<BridgeMentionCandidate, 'peer' | 'handle'>) {
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

function candidateWithBaseMentionHandle(candidate: BridgeMentionCandidate) {
  const handle = mentionHandleForLabel(candidate.displayLabel, candidate.peer.nodeId);
  return { ...candidate, handle, normalizedHandle: normalizeMentionLabel(handle) };
}

function dedupeBridgeMentionCandidateHandles(candidates: BridgeMentionCandidate[]) {
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

export function buildBridgeMentionCandidates(bridgeState: DesktopBridgeState | null) {
  if (!bridgeState) return [];

  const rawCandidates: BridgeMentionCandidate[] = [];

  for (const host of bridgeState.hosts) {
    for (const peer of host.visiblePeers) {
      const isAgent = isBridgeAgentRuntime(peer.runtime);
      const agentIsReachable = !isAgent || (peer.agentReachabilityPolicy?.trim().toLowerCase() || 'contacts') !== 'owner';
      const seenForPeer = new Set<string>();
      const pushLabel = (value: string | null | undefined, targetKind: BridgeMentionCandidate['targetKind']) => {
        const displayLabel = value?.trim();
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

      if (isAgent && peer.humanId?.trim() && (agentIsReachable || peer.isDefaultAgent)) {
        pushLabel(peer.ownerName, 'bridge-person');
      }
      if (!isAgent || agentIsReachable) {
        pushLabel(peer.displayName, isAgent ? 'bridge-agent' : 'bridge-person');
      }
      if (!isAgent) {
        pushLabel(peer.ownerName, 'bridge-person');
      }
      if (isAgent ? agentIsReachable && !hasAgentLabel : !hasPersonLabel) {
        pushLabel(peer.nodeId, isAgent ? 'bridge-agent' : 'bridge-person');
      }
    }
  }

  return dedupeBridgeMentionCandidateHandles(rawCandidates);
}

export function bridgeMentionCandidateOptionText(candidate: BridgeMentionCandidate) {
  const runtime = candidate.peer.runtime?.trim();
  if (candidate.targetKind === 'bridge-person') {
    const pairedAgentLabel = candidate.peer.displayName?.trim();
    return {
      label: candidate.displayLabel,
      detail: [
        'Bridge person',
        `@${candidate.handle}`,
        pairedAgentLabel && pairedAgentLabel !== candidate.displayLabel ? `Kordi: ${pairedAgentLabel}` : null,
        runtime,
      ].filter((value): value is string => Boolean(value)).join(' • '),
    };
  }

  const ownerName = candidate.peer.ownerName?.trim();
  return {
    label: candidate.displayLabel,
    detail: [
      'Bridge agent',
      `@${candidate.handle}`,
      ownerName && ownerName !== candidate.displayLabel ? `Owner: ${ownerName}` : null,
      runtime,
    ].filter((value): value is string => Boolean(value)).join(' • '),
  };
}

export function scopedAgentLabel(ownerName: string | null | undefined, agentLabel: string | null | undefined, ownerIsSelf = false) {
  const label = agentLabel?.trim();
  if (!label) return null;
  const owner = ownerName?.trim();
  if (!owner) return label;
  return possessiveScopedLabel(owner, label, ownerIsSelf);
}

export function localBridgeAgentLabels(bridgeState: DesktopBridgeState | null) {
  const activeHost = bridgeState?.hosts.find((host) => host.id === bridgeState.activeHostId)
    ?? bridgeState?.hosts[0]
    ?? null;
  const activeAgent = activeHost?.agents.find((agent) => agent.id === activeHost.activeAgentId)
    ?? activeHost?.agents.find((agent) => agent.isActive)
    ?? activeHost?.agents.find((agent) => agent.isDefault)
    ?? activeHost?.agents[0]
    ?? null;
  const ownerName = activeHost?.ownerName?.trim();
  const hostDisplayName = activeHost?.displayName?.trim();
  const agentLabel = activeAgent?.label?.trim();
  return [
    hostDisplayName,
    agentLabel,
    scopedAgentLabel(ownerName, 'Kordi', true),
    scopedAgentLabel(ownerName, agentLabel || 'Kordi', true),
    scopedAgentLabel(ownerName, 'Kordi'),
    scopedAgentLabel(ownerName, agentLabel || 'Kordi'),
    activeAgent?.id,
    activeAgent?.nodeId,
  ];
}

function activeBridgeHostAndAgent(bridgeState: DesktopBridgeState | null) {
  const activeHost = bridgeState?.hosts.find((host) => host.id === bridgeState.activeHostId)
    ?? bridgeState?.hosts[0]
    ?? null;
  const activeAgent = activeHost?.agents.find((agent) => agent.id === activeHost.activeAgentId)
    ?? activeHost?.agents.find((agent) => agent.isActive)
    ?? activeHost?.agents.find((agent) => agent.isDefault)
    ?? activeHost?.agents[0]
    ?? null;
  return { activeHost, activeAgent };
}

export function localAgentMentionLabels(state: DesktopChatState | null, bridgeState: DesktopBridgeState | null) {
  const labels = [
    'Kordi',
    state?.localAgent?.label,
    ...localBridgeAgentLabels(bridgeState),
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

export function mentionsLocalAgent(text: string, state: DesktopChatState | null, bridgeState: DesktopBridgeState | null) {
  const afterAt = text.replace(/^\s*@/, '');
  return localAgentMentionLabels(state, bridgeState).some((label) => mentionTextStartsWithLabel(afterAt, label));
}

function publicLocalAgentMentionLabel(bridgeState: DesktopBridgeState | null) {
  const { activeHost, activeAgent } = activeBridgeHostAndAgent(bridgeState);
  return publicScopedAgentMentionHandle(activeHost?.ownerName, activeAgent?.label || 'Kordi');
}

export function publicLocalAgentMentionText(text: string, bridgeState: DesktopBridgeState | null) {
  const leading = /^\s*/.exec(text)?.[0] ?? '';
  if (!text.slice(leading.length).startsWith('@')) return text;
  const afterAt = text.slice(leading.length + 1);
  const labels = localAgentMentionLabels(null, bridgeState)
    .sort((left, right) => normalizeMentionLabel(right).length - normalizeMentionLabel(left).length);
  for (const label of labels) {
    const rest = leadingAddressRest(afterAt, label);
    if (rest === null) continue;
    return `${leading}@${publicLocalAgentMentionLabel(bridgeState)}${rest ? ` ${rest}` : ''}`;
  }
  return rewriteLeadingFirstPersonAgentMention(text, activeBridgeHostAndAgent(bridgeState).activeHost?.ownerName, 'Kordi');
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

export function localHumanAddressLabels(bridgeState: DesktopBridgeState | null) {
  const activeHost = bridgeState?.hosts.find((host) => host.id === bridgeState.activeHostId)
    ?? bridgeState?.hosts[0]
    ?? null;
  return [activeHost?.ownerName, activeHost?.displayName];
}

export function localAgentRuntimeText(text: string, state: DesktopChatState | null, bridgeState: DesktopBridgeState | null) {
  const leading = /^\s*/.exec(text)?.[0] ?? '';
  if (!text.slice(leading.length).startsWith('@')) return text;
  const afterAt = text.slice(leading.length + 1);
  const labels = localAgentMentionLabels(state, bridgeState)
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

export type ResolveMentionedBridgeTargetOptions = {
  targetKind?: BridgeMentionCandidate['targetKind'];
};

export function resolveMentionedBridgeTarget(
  text: string,
  bridgeState: DesktopBridgeState | null,
  conversation?: MentionScopeConversation | null,
  options: ResolveMentionedBridgeTargetOptions = {},
) {
  const scopedCandidates = filterBridgeMentionCandidatesForConversation(buildBridgeMentionCandidates(bridgeState), conversation);
  const candidates = options.targetKind
    ? scopedCandidates.filter((candidate) => candidate.targetKind === options.targetKind)
    : scopedCandidates;
  if (candidates.length === 0) return null;
  const mentionMatches = Array.from(text.matchAll(/(^|\s)@/g));
  if (mentionMatches.length === 0) return null;

  for (const mention of mentionMatches) {
    const mentionStart = (mention.index ?? 0) + mention[1].length;
    const rawAfterAt = text.slice(mentionStart + 1);
    const leadingWhitespace = rawAfterAt.length - rawAfterAt.trimStart().length;
    const afterAt = rawAfterAt.trimStart();
    if (!afterAt) continue;

    const safeMatches = candidates
      .filter((candidate) => mentionTextStartsWithLabel(afterAt, candidate.handle))
      .sort((left, right) => right.normalizedHandle.length - left.normalizedHandle.length);

    const legacyMatches = safeMatches.length > 0
      ? []
      : candidates.filter((candidate) => mentionTextStartsWithLabel(afterAt, candidate.displayLabel));

    const legacyNormalizedKeys = new Set(legacyMatches.map((candidate) => `${candidate.targetKind}:${candidate.host.id}:${candidate.peer.nodeId}`));
    const match = safeMatches[0] ?? (legacyNormalizedKeys.size === 1 ? legacyMatches[0] : null);
    if (!match) continue;

    const matchedLabel = safeMatches.length > 0 ? match.handle : match.displayLabel;
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
