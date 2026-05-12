import {
  bridgeMentionCandidateOptionText,
  buildBridgeMentionCandidates,
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

    return options;
  };

  return {
    chat: buildTargets(activeConvMentionScope),
    project: buildTargets(null),
  };
}
