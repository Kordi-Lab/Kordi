import {
  bridgeMentionCandidateOptionText,
  buildBridgeMentionCandidates,
  conversationHasGroupMentionScope,
  filterBridgeMentionCandidatesForConversation,
  filterBridgeMentionCandidatesForHost,
  mentionHandleForLabel,
  shouldIncludeLocalAgentMentionForConversation,
  type MentionScopeConversation,
} from '@/features/chat/messageActions/mentions';
import type { ComposerMentionOption } from '@/kordi-app/components';
import type { Conversation, DesktopBridgeState, DesktopChatState } from '@/kordi-app/types';
import { possessiveScopedLabel } from '@/lib/identityLabels';

import { normalizeMentionSearch } from '@/app/useKordiAppModelHelpers';

export type BridgeMentionTargetsByScope = {
  chat: ComposerMentionOption[];
  project: ComposerMentionOption[];
};

export type BuildBridgeMentionTargetsParams = {
  isNativeShell: boolean;
  desktopBridgeState: DesktopBridgeState | null | undefined;
  desktopChatState: DesktopChatState | null | undefined;
  activeConvMentionScope: MentionScopeConversation | null | undefined;
  conversations?: Conversation[];
};

function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

function participantIsLocalSelf(participant: NonNullable<Conversation['canonicalParticipants']>[number]) {
  return participant.role === 'self' || participant.source === 'local';
}

function participantNodeId(participant: NonNullable<Conversation['canonicalParticipants']>[number]) {
  const id = cleanText(participant.humanId)
    || cleanText(participant.bridgeNodeId)
    || cleanText(participant.id).replace(/^human:/, '');
  return id || null;
}

function directAgentConversationSuppressesMentions(conversation: MentionScopeConversation | null | undefined) {
  if (!conversation || conversationHasGroupMentionScope(conversation)) return false;
  // Canonical forks of a group/contact session are minted as
  // kind='self-agent' (which surfaces as type='owned-agent') so the
  // sidebar nests them under their source rather than rendering as a
  // brand-new group. But the fork's participant list deliberately
  // carries every agent from the source for @-mention continuity —
  // suppressing the picker entirely defeats that. Detect a fork via
  // forkedFromSessionId and let the @-mention picker through.
  if (cleanText((conversation as { forkedFromSessionId?: string | null }).forkedFromSessionId)) return false;
  const type = cleanText((conversation as Pick<Conversation, 'type'>).type).toLowerCase();
  return type === 'owned-agent' || type === 'external-agent' || type === 'agent';
}

export function buildBridgeMentionTargetsByScope({
  isNativeShell,
  desktopBridgeState,
  desktopChatState,
  activeConvMentionScope,
  conversations = [],
}: BuildBridgeMentionTargetsParams): BridgeMentionTargetsByScope {
  if (!isNativeShell) return { chat: [], project: [] };

  const hosts = desktopBridgeState?.hosts ?? [];
  const activeHost = hosts.find((host) => host.id === desktopBridgeState?.activeHostId)
    ?? hosts[0]
    ?? null;
  const activeAgent = activeHost?.agents.find((agent) => agent.id === activeHost.activeAgentId)
    ?? activeHost?.agents.find((agent) => agent.isActive)
    ?? activeHost?.agents.find((agent) => agent.isDefault)
    ?? activeHost?.agents[0]
    ?? null;

  const unreadForTarget = (target: { hostId: string; nodeId: string; humanId?: string | null; agentId?: string | null }) => conversations.reduce((sum, conversation) => {
    const bridgeTarget = conversation.bridgeTarget;
    if (!bridgeTarget || bridgeTarget.hostId !== target.hostId) return sum;
    const matchesNode = bridgeTarget.nodeId === target.nodeId;
    const matchesHuman = Boolean(target.humanId && bridgeTarget.humanId === target.humanId);
    const matchesAgent = Boolean(target.agentId && bridgeTarget.agentId === target.agentId);
    return matchesNode || matchesHuman || matchesAgent ? sum + Math.max(0, conversation.unread ?? 0) : sum;
  }, 0);

  const buildTargets = (conversation: MentionScopeConversation | null | undefined): ComposerMentionOption[] => {
    if (directAgentConversationSuppressesMentions(conversation)) return [];

    const options: ComposerMentionOption[] = [];
    const seen = new Set<string>();
    const pushOption = (option: ComposerMentionOption) => {
      const key = `${option.targetKind}:${option.bridgeHostId}:${option.nodeId}:${normalizeMentionSearch(option.value)}`;
      if (seen.has(key)) return;
      seen.add(key);
      options.push(option);
    };

    const localAgentBaseLabel = 'Kordi';
    const ownerName = activeHost?.ownerName?.trim();
    const includeLocalAgent = shouldIncludeLocalAgentMentionForConversation(
      conversation,
      { humanId: activeHost?.humanId ?? '', ownerName: ownerName ?? '' },
    );
    if (includeLocalAgent && (desktopChatState?.localAgent || activeAgent)) {
      const runtimeAgentLabel = desktopChatState?.localAgent?.label?.trim();
      const bridgeAgentLabel = activeAgent?.label?.trim() || runtimeAgentLabel || localAgentBaseLabel;
      const hostDisplayName = activeHost?.displayName?.trim();
      const localAgentLabel = ownerName
        ? (possessiveScopedLabel(ownerName, bridgeAgentLabel, true) ?? bridgeAgentLabel)
        : (bridgeAgentLabel || hostDisplayName || localAgentBaseLabel);
      const localAgentHandle = mentionHandleForLabel(localAgentLabel, activeAgent?.id ?? activeAgent?.nodeId ?? 'Kordi');
      pushOption({
        value: localAgentHandle,
        label: localAgentLabel,
        detail: [
          'My agent',
          localAgentLabel !== localAgentHandle ? `@${localAgentHandle}` : null,
          activeAgent?.runtime,
        ].filter((value): value is string => Boolean(value)).join(' • '),
        targetKind: 'bridge-agent',
        bridgeHostId: activeHost?.id ?? 'local',
        nodeId: activeAgent?.nodeId?.trim() || activeHost?.nodeId?.trim() || `local-agent:${localAgentHandle}`,
        runtime: activeAgent?.runtime ?? 'kordi-local',
        humanId: activeHost?.humanId ?? null,
        agentId: activeAgent?.id ?? null,
        ownerName: ownerName ?? null,
        unreadCount: 0,
      });
    }

    const bridgeCandidates = filterBridgeMentionCandidatesForHost(buildBridgeMentionCandidates(desktopBridgeState ?? null), activeHost);
    for (const candidate of filterBridgeMentionCandidatesForConversation(bridgeCandidates, conversation)) {
      const display = bridgeMentionCandidateOptionText(candidate);
      pushOption({
        value: candidate.handle,
        label: display.label,
        detail: display.detail,
        targetKind: candidate.targetKind,
        bridgeHostId: candidate.host.id,
        nodeId: candidate.peer.nodeId,
        runtime: candidate.targetKind === 'bridge-person' ? 'person' : candidate.peer.runtime,
        humanId: candidate.peer.humanId ?? null,
        agentId: candidate.peer.agentId ?? null,
        ownerName: candidate.peer.ownerName ?? null,
        unreadCount: unreadForTarget({
          hostId: candidate.host.id,
          nodeId: candidate.peer.nodeId,
          humanId: candidate.peer.humanId ?? null,
          agentId: candidate.peer.agentId ?? null,
        }),
      });
    }

    if (conversationHasGroupMentionScope(conversation)) {
      for (const participant of conversation?.canonicalParticipants ?? []) {
        if (participant.kind !== 'human' || participantIsLocalSelf(participant)) continue;
        const label = cleanText(participant.name);
        const nodeId = participantNodeId(participant);
        if (!label || !nodeId) continue;
        const hostId = cleanText(participant.bridgeHostId) || activeHost?.id || 'conversation';
        const handle = mentionHandleForLabel(label, nodeId);
        pushOption({
          value: handle,
          label,
          detail: ['Group person', label !== handle ? `@${handle}` : null].filter((value): value is string => Boolean(value)).join(' • '),
          targetKind: 'bridge-person',
          bridgeHostId: hostId,
          nodeId,
          runtime: 'person',
          humanId: cleanText(participant.humanId) || nodeId,
          agentId: null,
          ownerName: label,
          unreadCount: 0,
        });
      }
    }

    return options;
  };

  return {
    chat: buildTargets(activeConvMentionScope),
    project: buildTargets(null),
  };
}
