import {
  collaborationMentionCandidateOptionText,
  buildCollaborationMentionCandidates,
  conversationHasGroupMentionScope,
  filterCollaborationMentionCandidatesForConversation,
  filterCollaborationMentionCandidatesForHost,
  mentionHandleForLabel,
  sharedCloudAgentMentionCandidatesForConversation,
  shouldIncludeLocalAgentMentionForConversation,
  type MentionScopeConversation,
} from '@/features/chat/messageActions/mentions';
import { cloudAgentDefinitionToSharedCloudAgentSummary, type CloudAgentDefinition, type SharedCloudAgentSummary } from '@/features/cloud/cloudAgents';
import type { ComposerMentionOption } from '@/kordi-app/components';
import type { Conversation, DesktopCollaborationState, DesktopChatState } from '@/kordi-app/types';
import { ALL_GROUP_MENTION_LABEL, groupMentionTargetIdentityId } from '@/features/chat/messageMentions';

import { normalizeMentionSearch } from '@/app/useKordiAppModelHelpers';

export type CollaborationMentionTargetsByScope = {
  chat: ComposerMentionOption[];
  project: ComposerMentionOption[];
};

export type BuildCollaborationMentionTargetsParams = {
  isNativeShell: boolean;
  desktopCollaborationState: DesktopCollaborationState | null | undefined;
  desktopChatState: DesktopChatState | null | undefined;
  activeConvMentionScope: MentionScopeConversation | null | undefined;
  conversations?: Conversation[];
  sharedCloudAgents?: SharedCloudAgentSummary[];
};

export type SharedCloudAgentOwnerScopeConversation = MentionScopeConversation & Partial<Pick<Conversation, 'collaborationTarget'>>;

function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

export function mentionableCloudAgentSummaries({
  sharedCloudAgents = [],
  ownedCloudAgentsById = {},
  ownerDisplayName = null,
}: {
  sharedCloudAgents?: SharedCloudAgentSummary[];
  ownedCloudAgentsById?: Record<string, CloudAgentDefinition>;
  ownerDisplayName?: string | null;
}): SharedCloudAgentSummary[] {
  const byId = new Map(sharedCloudAgents.map((agent) => [agent.agentId, agent]));
  for (const definition of Object.values(ownedCloudAgentsById)) {
    const summary = cloudAgentDefinitionToSharedCloudAgentSummary(definition, ownerDisplayName);
    if (summary) byId.set(summary.agentId, summary);
  }
  return [...byId.values()];
}

function participantIsLocalSelf(participant: NonNullable<Conversation['canonicalParticipants']>[number]) {
  return participant.role === 'self' || participant.source === 'local';
}

function participantNodeId(participant: NonNullable<Conversation['canonicalParticipants']>[number]) {
  const id = cleanText(participant.humanId)
    || cleanText(participant.sourceIdentityId)
    || cleanText(participant.id).replace(/^human:/, '');
  return id || null;
}

function participantProfileImageForAccount(conversation: MentionScopeConversation | null | undefined, accountId?: string | null) {
  const normalizedAccountId = cleanText(accountId).replace(/^human:/, '');
  if (!normalizedAccountId) return null;
  const participant = (conversation?.canonicalParticipants ?? []).find((candidate) => {
    if (candidate.kind !== 'human') return false;
    return [candidate.humanId, candidate.sourceIdentityId, candidate.id, candidate.id?.replace(/^human:/, '')]
      .map((value) => cleanText(value).replace(/^human:/, ''))
      .includes(normalizedAccountId);
  });
  return participant?.profileImageUrl ?? null;
}

export function sharedCloudAgentOwnerIdsForMentionScope(
  conversation: SharedCloudAgentOwnerScopeConversation | null | undefined,
  localAccountId?: string | null,
): string[] {
  const ids = new Set<string>();
  const local = cleanText(localAccountId);
  const add = (value?: string | null) => {
    const id = cleanText(value)?.replace(/^human:/, '');
    if (id && id !== local) ids.add(id);
  };
  for (const participant of conversation?.canonicalParticipants ?? []) {
    if (participant.kind !== 'human') continue;
    add(participant.humanId || participant.sourceIdentityId || participant.id);
  }
  if (conversation?.collaborationTarget?.runtime === 'person' || conversation?.collaborationTarget?.agentId === null) {
    add(conversation.collaborationTarget.humanId || conversation.collaborationTarget.nodeId);
  }
  return [...ids].sort();
}

function directAgentConversationSuppressesMentions(conversation: MentionScopeConversation | null | undefined) {
  if (!conversation || conversationHasGroupMentionScope(conversation)) return false;
  const type = cleanText((conversation as Pick<Conversation, 'type'>).type).toLowerCase();
  return type === 'owned-agent' || type === 'external-agent' || type === 'agent';
}

export function buildCollaborationMentionTargetsByScope({
  isNativeShell,
  desktopCollaborationState,
  desktopChatState,
  activeConvMentionScope,
  conversations = [],
  sharedCloudAgents = [],
}: BuildCollaborationMentionTargetsParams): CollaborationMentionTargetsByScope {
  if (!isNativeShell) return { chat: [], project: [] };

  const hosts = desktopCollaborationState?.hosts ?? [];
  const activeHost = hosts.find((host) => host.id === desktopCollaborationState?.activeHostId)
    ?? hosts[0]
    ?? null;
  const activeAgent = activeHost?.agents.find((agent) => agent.id === activeHost.activeAgentId)
    ?? activeHost?.agents.find((agent) => agent.isActive)
    ?? activeHost?.agents.find((agent) => agent.isDefault)
    ?? activeHost?.agents[0]
    ?? null;

  const unreadForTarget = (target: { hostId: string; nodeId: string; humanId?: string | null; agentId?: string | null }) => conversations.reduce((sum, conversation) => {
    const collaborationTarget = conversation.collaborationTarget;
    if (!collaborationTarget || collaborationTarget.hostId !== target.hostId) return sum;
    const matchesNode = collaborationTarget.nodeId === target.nodeId;
    const matchesHuman = Boolean(target.humanId && collaborationTarget.humanId === target.humanId);
    const matchesAgent = Boolean(target.agentId && collaborationTarget.agentId === target.agentId);
    return matchesNode || matchesHuman || matchesAgent ? sum + Math.max(0, conversation.unread ?? 0) : sum;
  }, 0);

  const buildTargets = (conversation: MentionScopeConversation | null | undefined): ComposerMentionOption[] => {
    if (directAgentConversationSuppressesMentions(conversation)) return [];

    const options: ComposerMentionOption[] = [];
    const seen = new Set<string>();
    const groupMentionIdentity = conversationHasGroupMentionScope(conversation)
      ? groupMentionTargetIdentityId(conversation?.canonicalSessionId ?? conversation?.id)
      : null;
    const pushOption = (option: ComposerMentionOption) => {
      if (
        option.targetKind !== 'all'
        && normalizeMentionSearch(option.value) === ALL_GROUP_MENTION_LABEL
      ) return;
      const key = `${option.targetKind}:${option.sourceHostId}:${option.nodeId}:${normalizeMentionSearch(option.value)}`;
      if (seen.has(key)) return;
      seen.add(key);
      options.push(option);
    };

    if (groupMentionIdentity) {
      pushOption({
        value: ALL_GROUP_MENTION_LABEL,
        label: 'All',
        detail: 'All people in this group',
        targetKind: 'all',
        sourceHostId: 'conversation',
        nodeId: groupMentionIdentity,
        runtime: 'group',
        avatarSeed: groupMentionIdentity,
        unreadCount: 0,
      });
    }

    const localAgentBaseLabel = 'Kordi';
    const ownerName = activeHost?.ownerName?.trim();
    const includeLocalAgent = shouldIncludeLocalAgentMentionForConversation(
      conversation,
      { humanId: activeHost?.humanId ?? '', ownerName: ownerName ?? '' },
    );
    if (includeLocalAgent && (desktopChatState?.localAgent || activeAgent)) {
      const runtimeAgentLabel = desktopChatState?.localAgent?.label?.trim();
      const collaborationAgentLabel = runtimeAgentLabel || activeAgent?.label?.trim() || localAgentBaseLabel;
      const hostDisplayName = activeHost?.displayName?.trim();
      const localAgentLabel = collaborationAgentLabel || hostDisplayName || localAgentBaseLabel;
      const localAgentHandle = mentionHandleForLabel(localAgentLabel, activeAgent?.id ?? activeAgent?.nodeId ?? 'Kordi');
      pushOption({
        value: localAgentHandle,
        label: localAgentLabel,
        detail: 'Owner · You',
        targetKind: 'agent',
        sourceHostId: activeHost?.id ?? 'local',
        nodeId: activeAgent?.nodeId?.trim() || activeHost?.nodeId?.trim() || `local-agent:${localAgentHandle}`,
        runtime: activeAgent?.runtime ?? 'kordi-local',
        humanId: activeHost?.humanId ?? null,
        agentId: activeAgent?.id ?? null,
        ownerName: ownerName ?? null,
        avatarImageUrl: activeAgent?.profileImageUrl ?? activeHost?.profileImageUrl ?? null,
        avatarSeed: activeAgent?.id ?? activeAgent?.nodeId ?? activeHost?.nodeId ?? localAgentHandle,
        unreadCount: 0,
      });
    }

    const collaborationCandidates = filterCollaborationMentionCandidatesForHost(buildCollaborationMentionCandidates(desktopCollaborationState ?? null), activeHost);
    for (const candidate of filterCollaborationMentionCandidatesForConversation(collaborationCandidates, conversation)) {
      const display = collaborationMentionCandidateOptionText(candidate);
      pushOption({
        value: candidate.handle,
        label: display.label,
        detail: display.detail,
        targetKind: candidate.targetKind,
        sourceHostId: candidate.host.id,
        nodeId: candidate.peer.nodeId,
        runtime: candidate.targetKind === 'person' ? 'person' : candidate.peer.runtime,
        humanId: candidate.peer.humanId ?? null,
        agentId: candidate.peer.agentId ?? null,
        ownerName: candidate.peer.ownerName ?? null,
        avatarImageUrl: candidate.peer.profileImageUrl ?? null,
        avatarSeed: candidate.peer.agentId ?? candidate.peer.humanId ?? candidate.peer.nodeId ?? candidate.handle,
        unreadCount: unreadForTarget({
          hostId: candidate.host.id,
          nodeId: candidate.peer.nodeId,
          humanId: candidate.peer.humanId ?? null,
          agentId: candidate.peer.agentId ?? null,
        }),
      });
    }

    const activeHostAccountId = activeHost?.humanId?.trim() || activeHost?.nodeId?.trim() || null;
    for (const candidate of sharedCloudAgentMentionCandidatesForConversation(sharedCloudAgents, conversation, activeHostAccountId)) {
      pushOption({
        value: candidate.handle,
        label: candidate.displayLabel,
        detail: candidate.detailLabel,
        targetKind: 'agent',
        sourceHostId: 'cloud',
        nodeId: candidate.targetOwnerAccountId,
        runtime: 'kordi-cloud-agent',
        humanId: candidate.targetOwnerAccountId,
        agentId: candidate.targetAgentId,
        ownerName: candidate.agent.ownerDisplayName ?? candidate.targetOwnerAccountId,
        avatarImageUrl: participantProfileImageForAccount(conversation, candidate.targetOwnerAccountId),
        avatarSeed: candidate.targetAgentId,
        unreadCount: 0,
      });
    }

    if (conversationHasGroupMentionScope(conversation)) {
      for (const participant of conversation?.canonicalParticipants ?? []) {
        if (participant.kind !== 'human' || participantIsLocalSelf(participant)) continue;
        const label = cleanText(participant.name);
        const nodeId = participantNodeId(participant);
        if (!label || !nodeId) continue;
        const hostId = cleanText(participant.sourceHostId) || activeHost?.id || 'conversation';
        const handle = mentionHandleForLabel(label, nodeId);
        pushOption({
          value: handle,
          label,
          detail: 'Person',
          targetKind: 'person',
          sourceHostId: hostId,
          nodeId,
          runtime: 'person',
          humanId: cleanText(participant.humanId) || nodeId,
          agentId: null,
          ownerName: label,
          avatarImageUrl: participant.profileImageUrl ?? null,
          avatarSeed: participant.avatarKey ?? nodeId,
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
