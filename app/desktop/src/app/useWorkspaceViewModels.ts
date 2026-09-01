import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { mapCollaborationConversationToViewModel } from '@/features/collaboration/transcript';
import { isCollaborationAgentRuntime } from '@/features/collaboration/runtime';
import { isCloudAgentRuntimeSessionId } from '@/features/cloud/cloudAgentMessages';
import { isCloudCollaborationHostId } from '@/features/cloud/cloudCollaborationState';
import { EMPTY_CLOUD_SESSION_ACTIVITY, cloudTaskActivitiesForSession, type CloudSessionActivityStore } from '@/features/cloud/cloudSessionActivity';
import { cloudAgentDefinitionToAgent, type CloudAgentDefinition } from '@/features/cloud/cloudAgents';
import type { CloudPresenceStore } from '@/features/cloud/presence';
import {
  buildProjectRoutingGroups,
  canonicalProjectGroupIdFromRoot,
  isLegacyCanonicalCollaborationSessionId,
  isCanonicalCloudSessionId,
  normalizeCanonicalProjectGroupId,
  projectRootFromCanonicalProjectGroupId,
  resolveProjectSelection,
} from '@/features/canonical/sessionResolver';
import { createCanonicalSessionReadModel, presentLocalAgentMessages } from '@/features/canonical/sessionReadModel';
import { canonicalLocalAgentAvatarSeed } from '@/features/canonical/avatarIdentity';
import {
  isLocalDraftChatConversationId,
  isProjectDraftSessionId,
} from '@/features/chat/draftSessions';
import { buildTaskActivityDashboard } from '@/features/chat/taskActivityDashboard';
import {
  buildParticipantSpaces,
  collapseBlankConversationShells,
  ensureSelfParticipantSpace,
  filterParticipantSpaces,
} from '@/features/chat/participantSpaces';
import {
  createTranscriptReferenceStabilizer,
} from '@/features/chat/transcriptReferenceStability';
import { getLocalAgentAvatarSeed, getLocalProfileAvatarSeed } from '@/kordi-app/components/IdentityAvatar';
import { contactGroups, contacts, conversations } from '@/kordi-app/data';
import type {
  Agent,
  CanonicalSessionState,
  CanonicalSessionSummary,
  Contact,
  Conversation,
  DesktopCollaborationConversation,
  DesktopCollaborationHost,
  DesktopCollaborationState,
  DesktopChatMessage,
  DesktopChatState,
  DesktopChatTurnSnapshot,
  Message,
  NavId,
  Project,
  SessionTaskActivity,
} from '@/kordi-app/types';
import { getInitials } from '@/kordi-app/utils';
import { applyCloudPresenceToConversations } from './viewModels/cloudConversationPresence';
import {
  backgroundSessionStatusIndicator,
  canonicalAvatarSeed,
  canonicalTaskActivitiesForSession,
  companionConversationList,
} from './viewModels/backgroundSessions';
import {
  collaborationProfileImageUrl,
  sanitizeRemotePeerName,
} from './viewModels/collaborationLabels';
import {
  activeConversationForSelection,
  applyCanonicalHydrationPlaceholder,
} from './viewModels/conversationSelection';
import { materializedChatConversations, nativeChatPlaceholderForSelection } from './viewModels/nativeChatSelection';
import { liveTurnsViewModelSignature } from './viewModels/workspaceViewModelSignatures';
import {
  collaborationPeerIsApprovedContact,
  buildConversationPreview,
  buildOutreachInlineMessages,
  buildSessionStatusIndicator,
  canonicalProjectDisplayName,
  preferLatestMessages,
  hideRawConversationIds,
  visibleCollaborationPeople,
  collaborationPeerIsReachableAgent,
} from './viewModels/helpers';

const EMPTY_DESKTOP_SESSION_IDS: ReadonlySet<string> = new Set();
const EMPTY_CLOUD_LEGACY_GROUP_SESSION_TITLES: ReadonlyMap<string, string> = new Map(); const EMPTY_CLOUD_GROUP_NUMBERS: ReadonlyMap<string, number> = new Map();

export { findCollaborationProjectForWorkspace } from './viewModels/helpers';
export {
  activeConversationForSelection,
  applyCanonicalHydrationPlaceholder,
  pendingCanonicalCloudConversationForActiveId,
  pendingCloudCollaborationConversationForActiveId,
} from './viewModels/conversationSelection';

export function collaborationChatConversationRoutesToLocalAgentPage(
  conversation: Pick<DesktopCollaborationConversation, 'hostId' | 'outreach' | 'identity' | 'projectId'>,
) {
  if (isCloudCollaborationHostId(conversation.hostId)) return false;
  const outreach = conversation.outreach;
  if (outreach?.targetKind !== 'agent') return false;
  if (outreach.parentSessionId?.trim()) return false;
  if (conversation.projectId?.trim()) return false;
  const localAgentId = conversation.identity?.localAgentId?.trim();
  const targetAgentId = outreach.targetAgentId?.trim();
  return Boolean(localAgentId && targetAgentId && localAgentId === targetAgentId);
}

export function collaborationChatConversationIsVisible(
  conversation: Pick<DesktopCollaborationConversation, 'outreach'>,
) {
  return !conversation.outreach?.parentSessionId;
}

type UseWorkspaceViewModelsArgs = {
  isNativeShell: boolean;
  isDesktopChatLoading: boolean;
  desktopChatState: DesktopChatState | null; localAgentDisplayName?: string | null;
  desktopCollaborationState: DesktopCollaborationState | null;
  canonicalSessionState: CanonicalSessionState | null;
  canonicalSessionSummaries?: CanonicalSessionSummary[];
  hiddenSessionIds: Set<string>;
  projectWorkspaces: Project[];
  projectSelectedSessionIds: Record<string, string>;
  activeNav: NavId;
  activeConvId: string;
  activeProjectId: string;
  activeProjectSessionId: string;
  chatSearch: string;
  projectSearch: string;
  contactSearch: string;
  activeContactId: string;
  activeAgentId: string;
  cachedChatSessionMessages: Record<string, Message[]>;
  cachedProjectSessionMessages: Record<string, Message[]>;
  cachedDesktopSessionSourceMessages?: Record<string, DesktopChatMessage[]>;
  hydratedDesktopSessionIds?: ReadonlySet<string>;
  localSessionUnreadCounts: Record<string, number>;
  desktopLiveTurnsBySession: Record<string, DesktopChatTurnSnapshot>;
  mapDesktopMessages: (sessionId: string, messages: DesktopChatMessage[], sessionContext?: { metadata?: unknown }) => Message[];
  cloudSessionActivity?: CloudSessionActivityStore;
  cloudAgentDefinitionsById?: Record<string, CloudAgentDefinition>;
  cloudPresence?: CloudPresenceStore;
  cloudUnreadReady?: boolean; pendingGroupProjectionSessionIds?: ReadonlySet<string>;
  cloudLegacyGroupSessionTitlesById?: ReadonlyMap<string, string>; cloudReliableGroupSessionTitleIds?: ReadonlySet<string>; cloudReliableGroupSessionActivityAtMs?: ReadonlyMap<string, number>;
  transientChatConversations?: Conversation[];
};

export function useWorkspaceViewModels({
  isNativeShell,
  isDesktopChatLoading: _isDesktopChatLoading,
  desktopChatState, localAgentDisplayName = null,
  desktopCollaborationState,
  canonicalSessionState,
  canonicalSessionSummaries = [],
  hiddenSessionIds,
  projectWorkspaces,
  projectSelectedSessionIds,
  activeNav,
  activeConvId,
  activeProjectId,
  activeProjectSessionId,
  chatSearch,
  projectSearch,
  contactSearch,
  activeContactId,
  activeAgentId,
  cachedChatSessionMessages,
  cachedProjectSessionMessages,
  cachedDesktopSessionSourceMessages = {},
  hydratedDesktopSessionIds = EMPTY_DESKTOP_SESSION_IDS,
  localSessionUnreadCounts,
  desktopLiveTurnsBySession,
  mapDesktopMessages,
  cloudSessionActivity = EMPTY_CLOUD_SESSION_ACTIVITY,
  cloudAgentDefinitionsById = {},
  cloudPresence = {},
  cloudUnreadReady = true, pendingGroupProjectionSessionIds = EMPTY_DESKTOP_SESSION_IDS,
  cloudLegacyGroupSessionTitlesById = EMPTY_CLOUD_LEGACY_GROUP_SESSION_TITLES, cloudReliableGroupSessionTitleIds = EMPTY_DESKTOP_SESSION_IDS, cloudReliableGroupSessionActivityAtMs = EMPTY_CLOUD_GROUP_NUMBERS,
  transientChatConversations = [],
}: UseWorkspaceViewModelsArgs) {
  const [transcriptReferenceStabilizer] = useState(createTranscriptReferenceStabilizer);
  const canonicalReadModel = useMemo(
    () => createCanonicalSessionReadModel(canonicalSessionState, {
      summaries: canonicalSessionSummaries, localAgentDisplayName,
      cloudUnreadReady, pendingGroupProjectionSessionIds,
      legacyGroupSessionTitlesById: cloudLegacyGroupSessionTitlesById, reliableGroupSessionTitleIds: cloudReliableGroupSessionTitleIds, reliableGroupSessionActivityAtMs: cloudReliableGroupSessionActivityAtMs,
    }),
    [canonicalSessionState, canonicalSessionSummaries, cloudLegacyGroupSessionTitlesById, cloudReliableGroupSessionActivityAtMs, cloudReliableGroupSessionTitleIds, cloudUnreadReady, localAgentDisplayName, pendingGroupProjectionSessionIds],
  );
  const desktopLiveTurnViewModelKey = liveTurnsViewModelSignature(desktopLiveTurnsBySession);
  const desktopLiveTurnsForViewModelRef = useRef({
    key: desktopLiveTurnViewModelKey,
    value: desktopLiveTurnsBySession,
  });
  if (desktopLiveTurnsForViewModelRef.current.key !== desktopLiveTurnViewModelKey) {
    desktopLiveTurnsForViewModelRef.current = {
      key: desktopLiveTurnViewModelKey,
      value: desktopLiveTurnsBySession,
    };
  }
  const desktopLiveTurnsForViewModel = desktopLiveTurnsForViewModelRef.current.value;

  const outreachThreadsByParentSession = useMemo(() => {
    const grouped = new Map<string, Array<{
      id: string;
      title: string;
      subtitle: string;
      targetKind: string;
      targetDisplayName: string;
      status: string;
      updatedAtLabel?: string;
      updatedAtMs: number;
      inlineMessages: Message[];
    }>>();

    for (const conversation of desktopCollaborationState?.conversations ?? []) {
      const outreach = conversation.outreach;
      const parentSessionId = outreach?.parentSessionId;
      if (!outreach || !parentSessionId) continue;
      const thread = {
        id: conversation.id,
        title: conversation.title,
        subtitle: conversation.subtitle || outreach.requestText || 'Outreach thread',
        targetKind: outreach.targetKind,
        targetDisplayName: outreach.targetDisplayName,
        status: outreach.status,
        updatedAtLabel: conversation.updatedAtLabel,
        updatedAtMs: conversation.updatedAtMs,
        inlineMessages: buildOutreachInlineMessages(conversation),
      };
      grouped.set(parentSessionId, [...(grouped.get(parentSessionId) ?? []), thread]);
    }

    for (const threads of grouped.values()) {
      threads.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
    }
    return grouped;
  }, [desktopCollaborationState?.conversations]);

  const localChatConversations = useMemo(() => {
    if (!isNativeShell || !desktopChatState?.activeSession) {
      return [];
    }

    const localAgentLabel = desktopChatState.localAgent?.label || 'Kordi';
    const canonicalSessionMetadataById = new Map(
      (canonicalSessionState?.sessions ?? []).map((session) => [session.id, session.metadata]),
    );
    const activeHost = desktopCollaborationState?.hosts.find((host) => host.id === desktopCollaborationState.activeHostId)
      ?? desktopCollaborationState?.hosts[0]
      ?? null;
    const localAgentAvatarSeed = canonicalLocalAgentAvatarSeed(canonicalSessionState)
      || getLocalAgentAvatarSeed();
    const localHumanAvatarSeed = canonicalAvatarSeed(canonicalSessionState, canonicalSessionState?.profile.humanIdentityId)
      || activeHost?.humanId
      || canonicalSessionState?.profile.id
      || getLocalProfileAvatarSeed();

    const activeSessionSummary = !desktopChatState.activeSession.project
      && !isCloudAgentRuntimeSessionId(desktopChatState.activeSession.id)
      && !isLocalDraftChatConversationId(desktopChatState.activeSession.id)
      && !desktopChatState.sessions.some((session) => session.id === desktopChatState.activeSession.id)
      ? {
          id: desktopChatState.activeSession.id,
          title: desktopChatState.activeSession.title || 'New session',
          subtitle: desktopChatState.activeSession.subtitle,
          updatedAtLabel: desktopChatState.activeSession.updatedAtLabel,
          updatedAtMs: desktopChatState.activeSession.updatedAtMs,
          messageCount: desktopChatState.activeSession.messageCount,
          draft: desktopChatState.activeSession.draft,
          forkedFromSessionId: desktopChatState.activeSession.forkedFromSessionId ?? null,
          forkedFromMessageId: desktopChatState.activeSession.forkedFromMessageId ?? null,
        }
      : null;
    const rawSessionSummaries = activeSessionSummary
      ? [activeSessionSummary, ...desktopChatState.sessions]
      : desktopChatState.sessions;
    const sessionSummaries = rawSessionSummaries.filter((session) => !isCloudAgentRuntimeSessionId(session.id));

    return sessionSummaries.map((session) => {
      const isActiveSession = session.id === desktopChatState.activeSession.id;
      const isVisibleSession = activeNav === 'chats' && activeConvId === session.id;
      const cachedSourceMessages = cachedDesktopSessionSourceMessages[session.id];
      const cachedMessages = !isActiveSession && isVisibleSession && cachedSourceMessages
        ? mapDesktopMessages(
            session.id,
            cachedSourceMessages,
            { metadata: canonicalSessionMetadataById.get(session.id) },
          )
        : cachedChatSessionMessages[session.id];
      const activeMessages = isActiveSession
        ? preferLatestMessages(
            mapDesktopMessages(
              desktopChatState.activeSession.id,
              desktopChatState.activeSession.messages,
              { metadata: canonicalSessionMetadataById.get(desktopChatState.activeSession.id) },
            ),
            cachedChatSessionMessages[session.id],
            Boolean(desktopLiveTurnsForViewModel[session.id]),
            desktopLiveTurnsForViewModel[session.id],
          )
        : cachedMessages ?? [{ role: 'system' as const, text: session.draft ? 'Draft session' : 'Session ready', time: session.updatedAtLabel }];
      const unreadCount = isVisibleSession ? 0 : (localSessionUnreadCounts[session.id] ?? 0);
      const statusIndicator = buildSessionStatusIndicator({
        unreadCount,
        showBackgroundActivity: !isVisibleSession,
        liveTurn: desktopLiveTurnsForViewModel[session.id],
        existingIndicator: backgroundSessionStatusIndicator(
          'backgroundStatus' in session ? session.backgroundStatus : null,
        ),
      });

      const outreachRecords = outreachThreadsByParentSession.get(session.id) ?? [];
      const outreachThreads = outreachRecords.map(({ updatedAtMs: _updatedAtMs, inlineMessages: _inlineMessages, ...thread }) => thread);
      const messages = [...activeMessages, ...outreachRecords.flatMap((thread) => thread.inlineMessages)];
      const reflectionLessonArtifacts = isActiveSession ? (desktopChatState.activeSession.reflectionLessonArtifacts ?? []) : [];

      return {
        id: session.id,
        canonicalSessionId: session.id,
        localSessionCwd: isActiveSession ? desktopChatState.activeSession.cwd : null,
        desktopRuntimeBacked: true,
        desktopRuntimeTranscriptLoaded: hydratedDesktopSessionIds.has(session.id) || cachedDesktopSessionSourceMessages[session.id] !== undefined || cachedChatSessionMessages[session.id] !== undefined,
        name: session.title,
        type: 'owned-agent' as const,
        subtitle: buildConversationPreview(messages, session.subtitle),
        unread: unreadCount,
        collaborationSources: ['Local'],
        trust: 'Owned',
        directness: session.draft ? 'Draft' : 'Agent chat',
        participants: ['Me', localAgentLabel],
        participantAvatarSeeds: {
          Me: localHumanAvatarSeed,
          You: localHumanAvatarSeed,
          [localAgentLabel]: localAgentAvatarSeed,
          'My Kordi': localAgentAvatarSeed,
          Kordi: localAgentAvatarSeed,
        },
        messages,
        reflectionLessonArtifacts,
        previewLiveTurn: desktopLiveTurnsForViewModel[session.id] ?? null,
        updatedAtLabel: session.updatedAtLabel,
        statusIndicator,
        collaborationTarget: undefined,
        avatarSeed: localAgentAvatarSeed,
        outreachThreads,
        forkedFromSessionId: session.forkedFromSessionId ?? null,
        forkedFromMessageId: session.forkedFromMessageId ?? null,
        _updatedAtMs: session.updatedAtMs,
      };
    });
  }, [activeConvId, activeNav, cachedChatSessionMessages, cachedDesktopSessionSourceMessages, canonicalSessionState, desktopCollaborationState, desktopChatState, desktopLiveTurnsForViewModel, hydratedDesktopSessionIds, isNativeShell, localSessionUnreadCounts, mapDesktopMessages, outreachThreadsByParentSession]);

  const localAgentCollaborationReachoutConversations = useMemo(() => {
    if (!isNativeShell) return [];
    const hostById = new Map((desktopCollaborationState?.hosts ?? []).map((host) => [host.id, host]));
    const localAgentLabel = desktopChatState?.localAgent?.label || 'My agent';
    return (desktopCollaborationState?.conversations ?? [])
      .filter(collaborationChatConversationRoutesToLocalAgentPage)
      .map((conversation) => (
        mapCollaborationConversationToViewModel(conversation, hostById.get(conversation.hostId), localAgentLabel)
      ));
  }, [desktopCollaborationState, desktopChatState?.localAgent?.label, isNativeShell]);

  const collaborationChatConversations = useMemo(() => {
    if (!isNativeShell) return [];
    const hostById = new Map((desktopCollaborationState?.hosts ?? []).map((host) => [host.id, host]));
    const localAgentLabel = desktopChatState?.localAgent?.label || 'My agent';
    return (desktopCollaborationState?.conversations ?? [])
      .filter((conversation) => !collaborationChatConversationRoutesToLocalAgentPage(conversation))
      .map((conversation) => (
        mapCollaborationConversationToViewModel(conversation, hostById.get(conversation.hostId), localAgentLabel)
      ));
  }, [desktopCollaborationState, desktopChatState?.localAgent?.label, isNativeShell]);

  const visibleCollaborationChatConversations = useMemo(
    () => collaborationChatConversations.filter(collaborationChatConversationIsVisible),
    [collaborationChatConversations],
  );

  const localAgentCollaborationReachoutSessionIds = useMemo(() => new Set(
    localAgentCollaborationReachoutConversations.flatMap((conversation) => [conversation.id, conversation.canonicalSessionId].filter((value): value is string => Boolean(value))),
  ), [localAgentCollaborationReachoutConversations]);

  const hydratedChatConversations = useMemo(() => {
    if (!isNativeShell) {
      return conversations;
    }
    const collaborationSourceConversations = canonicalReadModel ? collaborationChatConversations : visibleCollaborationChatConversations;
    const merged = [...collaborationSourceConversations, ...localChatConversations, ...transientChatConversations];
    merged.sort((a, b) => (b._updatedAtMs ?? 0) - (a._updatedAtMs ?? 0));
    const hydrated = canonicalReadModel
      ? canonicalReadModel.buildChatConversations(merged, buildConversationPreview)
      : merged;
    const conversationsWithStableOrder = [...hydrated]
      .sort((a, b) => (b._updatedAtMs ?? 0) - (a._updatedAtMs ?? 0))
      .map(({ _updatedAtMs, ...conversation }) => ({ ...conversation, messages: presentLocalAgentMessages(conversation.messages, localAgentDisplayName) }));
    return conversationsWithStableOrder;
  }, [collaborationChatConversations, canonicalReadModel, isNativeShell, localAgentDisplayName, localChatConversations, transientChatConversations, visibleCollaborationChatConversations]);

  const decoratedChatConversations = useMemo(() => {
    const withCloudPresence = applyCloudPresenceToConversations(
      hydratedChatConversations,
      cloudPresence,
    );
    const withCloudActivity = withCloudPresence.map((conversation) => {
      const sessionId = conversation.canonicalSessionId ?? conversation.id;
      const cloudTaskActivities = cloudTaskActivitiesForSession(cloudSessionActivity, sessionId);
      if (cloudTaskActivities.length === 0) return conversation;
      const existingTaskActivities = 'taskActivities' in conversation
        ? (conversation.taskActivities as SessionTaskActivity[] | undefined) ?? []
        : [];
      const existingIds = new Set(existingTaskActivities.map((activity) => activity.id));
      return {
        ...conversation,
        taskActivities: [
          ...existingTaskActivities,
          ...cloudTaskActivities.filter((activity) => !existingIds.has(activity.id)),
        ],
      };
    });
    return hideRawConversationIds(withCloudActivity);
  }, [cloudPresence, cloudSessionActivity, hydratedChatConversations]);
  const rawBlankShellCollapsedChatConversations = useMemo(
    () => collapseBlankConversationShells(decoratedChatConversations),
    [decoratedChatConversations],
  );
  const stableChatConversations = transcriptReferenceStabilizer.prepare(
    rawBlankShellCollapsedChatConversations,
  );
  useLayoutEffect(() => {
    transcriptReferenceStabilizer.commit(stableChatConversations);
  }, [stableChatConversations, transcriptReferenceStabilizer]);
  const blankShellCollapsedChatConversations = stableChatConversations.conversations;

  const chatConversations = useMemo(() => {
    const hiddenIds = new Set([
      ...hiddenSessionIds,
      ...localAgentCollaborationReachoutSessionIds,
    ]);
    if (hiddenIds.size === 0) return blankShellCollapsedChatConversations;
    return blankShellCollapsedChatConversations.filter((conversation) => {
      const canonicalId = conversation.canonicalSessionId ?? conversation.id;
      if (activeConvId === conversation.id || activeConvId === canonicalId) return true;
      return !hiddenIds.has(canonicalId) && !hiddenIds.has(conversation.id);
    });
  }, [
    activeConvId,
    blankShellCollapsedChatConversations,
    hiddenSessionIds,
    localAgentCollaborationReachoutSessionIds,
  ]);
  const companionConversations = useMemo(
    () => companionConversationList(chatConversations, blankShellCollapsedChatConversations),
    [blankShellCollapsedChatConversations, chatConversations],
  );

  const visibleMaterializedChatConversations = useMemo(() => materializedChatConversations(chatConversations), [chatConversations]);
  const nativeChatPlaceholder = useMemo(
    () => nativeChatPlaceholderForSelection(activeConvId),
    [activeConvId],
  );

  const activeConv = useMemo(() => {
    const selected = activeConversationForSelection(activeConvId, chatConversations, {
      isNativeShell,
      nativeChatPlaceholder,
      fallbackConversation:
        visibleMaterializedChatConversations[0]
        ?? (!isNativeShell ? conversations[0] : undefined),
    });
    return applyCanonicalHydrationPlaceholder(selected);
  }, [activeConvId, chatConversations, isNativeShell, nativeChatPlaceholder, visibleMaterializedChatConversations]);
  const activeConversationUsesCollaboration = isNativeShell && (
    activeConv.id.startsWith('bridge:')
    || isLegacyCanonicalCollaborationSessionId(activeConv.canonicalSessionId ?? activeConv.id)
    || isCanonicalCloudSessionId(activeConv.canonicalSessionId ?? activeConv.id)
    || Boolean(activeConv.collaborationTarget)
  );
  const activeLastMessage = activeConv.messages[activeConv.messages.length - 1];
  const activeConvHasSubtitle = activeConv.subtitle.trim().length > 0;

  const filteredConversations = useMemo(() => {
    const normalizedSearch = chatSearch.trim().toLowerCase();
    if (normalizedSearch.length === 0) return chatConversations;
    return chatConversations.filter((conversation) => (
      [conversation.name, conversation.subtitle, conversation.participants.join(' '), conversation.messages[conversation.messages.length - 1]?.text]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(normalizedSearch))
    ));
  }, [chatConversations, chatSearch]);

  const participantSpaces = useMemo(
    () => ensureSelfParticipantSpace(buildParticipantSpaces(chatConversations), { avatarSeed: getLocalProfileAvatarSeed() }),
    [chatConversations],
  );
  const contactParticipantSpaces = useMemo(
    () => filterParticipantSpaces(participantSpaces, chatSearch, 'contact'),
    [chatSearch, participantSpaces],
  );
  const agentParticipantSpaces = useMemo(
    () => filterParticipantSpaces(participantSpaces, chatSearch, 'agent'),
    [chatSearch, participantSpaces],
  );

  const displayedContacts = useMemo<Contact[]>(() => {
    if (!isNativeShell) return contacts;
    const byId = new Map<string, Contact>();
    const collaborationLabel = (url: string) => url.replace(/^https?:\/\//, '');
    const localAgent = desktopChatState?.localAgent;

    for (const host of desktopCollaborationState?.hosts ?? []) {
      const label = collaborationLabel(host.serverUrl);
      byId.set(`collaboration-self:${host.id}`, {
        id: `collaboration-self:${host.id}`,
        name: host.displayName,
        initials: getInitials(host.displayName),
        classType: 'my-agents',
        entityType: 'My agent',
        subtitle: 'Direct local chat',
        collaborationSources: [label],
        status: host.connected ? 'Owned' : 'Offline',
        discoverableOn: [label],
        detail: `Chat directly with my local Kordi agent. Collaboration host: ${label}${host.nodeId ? ` • ${host.nodeId}` : ''}`,
        owner: 'Me',
        sourceHostId: host.id,
        sourceParticipantId: host.nodeId ?? undefined,
        sourceRuntime: 'kordi-desktop',
        sourceHumanId: host.humanId,
        sourceAgentId: host.activeAgentId ?? undefined,
        avatarSeed: getLocalAgentAvatarSeed(),
      });

      for (const peer of host.visiblePeers) {
        if (!collaborationPeerIsApprovedContact(peer)) continue;
        const isAgent = isCollaborationAgentRuntime(peer.runtime);
        const contactStatus = peer.isContact ? 'contact' : (peer.contactRequestStatus?.trim() || 'none');
        const contactRequestDirection = peer.contactRequestDirection?.trim() || null;
        if (!isAgent || collaborationPeerIsReachableAgent(peer)) {
          const id = isAgent
            ? `collaboration-peer-agent:${peer.nodeId}:${peer.agentId ?? peer.runtime}`
            : `collaboration-peer-person:${peer.nodeId}:${peer.humanId ?? 'person'}`;
          const existing = byId.get(id);
          const nextDiscoveryLabels = Array.from(new Set([...(existing?.collaborationSources ?? []), label])).sort();
          const peerName = sanitizeRemotePeerName(peer.displayName, peer.ownerName, peer.humanId, peer.nodeId);
          byId.set(id, {
            id,
            name: peerName,
            initials: getInitials(peerName),
            classType: isAgent ? 'other-users-agents' : 'other-users',
            entityType: isAgent ? 'External agent' : 'Person',
            subtitle: peer.sharedProjects.length > 0 ? `${peer.runtime} • ${peer.sharedProjects.length} shared project${peer.sharedProjects.length === 1 ? '' : 's'}` : peer.runtime,
            collaborationSources: nextDiscoveryLabels,
            status: host.connected ? 'Reachable' : 'Offline',
            discoverableOn: nextDiscoveryLabels,
            detail: [peer.nodeId, peer.endpoint, peer.sharedProjects.length > 0 ? `Shared projects: ${peer.sharedProjects.join(' • ')}` : null].filter(Boolean).join(' • '),
            owner: peer.ownerName || 'Unknown',
            sourceHostId: host.id,
            sourceParticipantId: peer.nodeId,
            sourceRuntime: peer.runtime,
            sourceHumanId: peer.humanId,
            sourceAgentId: peer.agentId,
            contactStatus,
            contactRequestDirection,
            avatarSeed: isAgent ? (peer.agentId || peer.nodeId) : (peer.avatarSeed || peer.humanId || peer.ownerName || peer.nodeId),
            profileImageUrl: collaborationProfileImageUrl(peer.profileImageUrl),
          });
        }

        if (isAgent && peer.ownerName && (collaborationPeerIsReachableAgent(peer) || peer.isDefaultAgent)) {
          const personId = `collaboration-peer-person:${peer.nodeId}:${peer.humanId ?? peer.ownerName}`;
          const existingPerson = byId.get(personId);
          const personDiscoveryLabels = Array.from(new Set([...(existingPerson?.collaborationSources ?? []), label])).sort();
          const personName = sanitizeRemotePeerName(peer.ownerName, peer.humanId, peer.nodeId);
          byId.set(personId, {
            id: personId,
            name: personName,
            initials: getInitials(personName),
            classType: 'other-users',
            entityType: 'Person',
            subtitle: `Owner of ${peer.displayName || 'external agent'}`,
            collaborationSources: personDiscoveryLabels,
            status: host.connected ? 'Reachable' : 'Offline',
            discoverableOn: personDiscoveryLabels,
            detail: [peer.humanId ? `Human ID: ${peer.humanId}` : null, peer.nodeId, peer.displayName ? `Agent: ${peer.displayName}` : null].filter(Boolean).join(' • '),
            owner: peer.ownerName,
            sourceHostId: host.id,
            sourceParticipantId: peer.nodeId,
            sourceRuntime: 'person',
            sourceHumanId: peer.humanId,
            sourceAgentId: peer.agentId,
            contactStatus,
            contactRequestDirection,
            avatarSeed: peer.avatarSeed || peer.humanId || peer.ownerName || peer.nodeId,
            profileImageUrl: collaborationProfileImageUrl(peer.profileImageUrl),
          });
        }
      }
    }

    if (localAgent && !Array.from(byId.values()).some((contact) => contact.classType === 'my-agents')) {
      byId.set('local-agent', {
        id: 'local-agent',
        name: localAgent.label,
        initials: getInitials(localAgent.label),
        classType: 'my-agents',
        entityType: 'My agent',
        subtitle: 'Direct local chat',
        collaborationSources: ['Local'],
        status: 'Owned',
        discoverableOn: ['Local'],
        detail: `Chat directly with my local Kordi agent • ${localAgent.workspaceRoot}`,
        owner: 'Me',
        avatarSeed: getLocalAgentAvatarSeed(),
      });
    }

    return Array.from(byId.values());
  }, [desktopCollaborationState?.hosts, desktopChatState?.localAgent, isNativeShell]);

  const addableContacts = useMemo<Contact[]>(() => {
    if (!isNativeShell) return [];
    const byId = new Map<string, Contact>();
    const collaborationLabel = (url: string) => url.replace(/^https?:\/\//, '');

    for (const host of desktopCollaborationState?.hosts ?? []) {
      const label = collaborationLabel(host.serverUrl);
      for (const peer of visibleCollaborationPeople(host.visiblePeers)) {
        if (collaborationPeerIsApprovedContact(peer)) continue;
        const id = `collaboration-addable-person:${host.id}:${peer.nodeId}:${peer.humanId ?? 'person'}`;
        const existing = byId.get(id);
        const nextDiscoveryLabels = Array.from(new Set([...(existing?.collaborationSources ?? []), label])).sort();
        const peerName = sanitizeRemotePeerName(peer.displayName, peer.ownerName, peer.humanId, peer.nodeId);
        const status = peer.contactRequestStatus?.trim().toLowerCase() || 'none';
        const direction = peer.contactRequestDirection?.trim().toLowerCase() || null;
        const needsApproval = peer.contactApprovalPolicy === 'approval-required';
        const subtitle = status === 'pending' && direction === 'outgoing'
          ? 'Request pending'
          : status === 'pending' && direction === 'incoming'
            ? 'Waiting for your approval'
            : needsApproval
              ? 'Needs approval'
              : 'Can add immediately';
        byId.set(id, {
          id,
          name: peerName,
          initials: getInitials(peerName),
          classType: 'other-users',
          entityType: 'Person',
          subtitle,
          collaborationSources: nextDiscoveryLabels,
          status: subtitle,
          discoverableOn: nextDiscoveryLabels,
          detail: [peer.nodeId, peer.humanId ? `Human ID: ${peer.humanId}` : null].filter(Boolean).join(' • '),
          owner: peer.ownerName || peerName,
          sourceHostId: host.id,
          sourceParticipantId: peer.nodeId,
          sourceRuntime: 'person',
          sourceHumanId: peer.humanId,
          sourceAgentId: peer.agentId,
          contactStatus: status,
          contactRequestDirection: direction,
          avatarSeed: peer.avatarSeed || peer.humanId || peer.ownerName || peer.nodeId,
          profileImageUrl: collaborationProfileImageUrl(peer.profileImageUrl),
        });
      }
    }

    return Array.from(byId.values()).sort((left, right) => left.name.localeCompare(right.name));
  }, [desktopCollaborationState?.hosts, isNativeShell]);

  const localAgentCollaborationReachoutsByAgentId = useMemo(() => {
    const byAgentId = new Map<string, Agent['collaborationReachouts']>();
    for (const conversation of localAgentCollaborationReachoutConversations) {
      const agentIds = [
        conversation.identity?.localAgentId,
        conversation.outreach?.targetAgentId,
        conversation.collaborationTarget?.agentId,
      ].map((value) => value?.trim()).filter((value): value is string => Boolean(value));
      const uniqueAgentIds = Array.from(new Set(agentIds));
      if (uniqueAgentIds.length === 0) continue;
      const reachout = {
        sessionId: conversation.id,
        title: conversation.name,
        preview: buildConversationPreview(conversation.messages, conversation.subtitle),
        updatedAtLabel: conversation.updatedAtLabel,
        unread: conversation.unread,
      };
      for (const agentId of uniqueAgentIds) {
        byAgentId.set(agentId, [...(byAgentId.get(agentId) ?? []), reachout]);
      }
    }
    for (const [agentId, reachouts] of byAgentId) {
      byAgentId.set(agentId, [...(reachouts ?? [])].sort((left, right) => (right.unread ?? 0) - (left.unread ?? 0)));
    }
    return byAgentId;
  }, [localAgentCollaborationReachoutConversations]);

  const displayedAgents = useMemo<Agent[]>(() => {
    if (!isNativeShell) return [];

    const collaborationLabel = (url: string) => url.replace(/^https?:\/\//, '');
    const localAgent = desktopChatState?.localAgent;
    const items: Agent[] = [];
    const seen = new Set<string>();

    for (const host of desktopCollaborationState?.hosts ?? []) {
      const hostLabel = collaborationLabel(host.serverUrl);
      for (const agent of host.agents) {
        const key = `owned:${host.id}:${agent.id}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const runtimeAgent = agent.isActive ? localAgent : undefined;
        const collaborationReachouts = [
          ...(localAgentCollaborationReachoutsByAgentId.get(agent.id) ?? []),
          ...(agent.nodeId ? localAgentCollaborationReachoutsByAgentId.get(agent.nodeId) ?? [] : []),
        ].filter((reachout, index, list) => list.findIndex((candidate) => candidate.sessionId === reachout.sessionId) === index);
        items.push({
          name: agent.isDefault ? localAgentDisplayName?.trim() || runtimeAgent?.label || agent.label : runtimeAgent?.label ?? agent.label,
          id: agent.id,
          role: 'My agent',
          messaging: 'Direct local chat',
          status: collaborationReachouts.length > 0 ? `${collaborationReachouts.length} direct reachout${collaborationReachouts.length === 1 ? '' : 's'}` : agent.isActive ? 'Active' : agent.isDefault ? 'Default' : agent.registered ? 'Registered' : 'Local only',
          tasks: 0,
          defaultProvider: runtimeAgent?.defaultProvider ?? host.ownerName,
          defaultModel: agent.defaultModel ?? runtimeAgent?.defaultModel ?? agent.runtime,
          defaultAuthProvider: agent.defaultAuthProvider ?? null,
          defaultAuthChoice: agent.defaultAuthChoice ?? null,
          fallbackModel: agent.fallbackModel ?? null,
          fallbackAuthProvider: agent.fallbackAuthProvider ?? null,
          fallbackAuthChoice: agent.fallbackAuthChoice ?? null,
          defaultThinking: agent.thinking ?? null,
          collaborationConfig: hostLabel,
          contactId: `collaboration-agent:${host.id}:${agent.id}`,
          systemPrompt: runtimeAgent?.systemPrompt ?? '',
          xMd: runtimeAgent?.workspaceRoot ?? [host.serverUrl, agent.nodeId || 'Pending node'].filter(Boolean).join(' • '),
          identityFiles: runtimeAgent?.identityFiles ?? [],
          loadedTools: runtimeAgent?.loadedTools ?? [],
          loadedSkills: runtimeAgent?.loadedSkills ?? [],
          loadedPlugins: runtimeAgent?.loadedPlugins ?? [],
          lastActivities: [
            ...collaborationReachouts.slice(0, 3).map((reachout) => `Direct reachout: ${reachout.title}${reachout.preview ? ` — ${reachout.preview}` : ''}`),
            ...(runtimeAgent
              ? runtimeAgent.lastActivities
              : [
                  `Human ID: ${host.humanId}`,
                  `Node ID: ${agent.nodeId || 'Pending registration'}`,
                  `Discovery: ${host.discoveryMode}`,
                ]),
          ],
          exposesIdentityFiles: Boolean(runtimeAgent),
          exposesLoadedSkills: Boolean(runtimeAgent),
          exposesLoadedTools: Boolean(runtimeAgent),
          exposesLoadedPlugins: Boolean(runtimeAgent),
          sourceHostId: host.id,
          sourceParticipantId: agent.nodeId ?? undefined,
          sourceRuntime: agent.runtime,
          sourceAgentId: agent.id,
          collaborationServerUrl: host.serverUrl,
          collaborationOwnerName: host.ownerName,
          isOwned: true,
          isCollaborationDefault: agent.isDefault,
          isCollaborationActive: agent.isActive,
          isCollaborationRegistered: agent.registered,
          avatarSeed: agent.id,
          collaborationReachouts,
        });
      }
    }

    if (items.length === 0 && localAgent) {
      const localAgentRouting = desktopCollaborationState?.localAgentRouting;
      items.push({
        name: localAgentDisplayName?.trim() || localAgent.label,
        id: 'desktop:local-agent',
        role: 'Local desktop agent',
        messaging: 'Local runtime',
        status: 'Active',
        tasks: 0,
        defaultProvider: localAgent.defaultProvider,
        defaultModel: localAgentRouting?.defaultModel ?? localAgent.defaultModel,
        defaultAuthProvider: localAgentRouting?.defaultAuthProvider ?? null,
        defaultAuthChoice: localAgentRouting?.defaultAuthChoice ?? null,
        fallbackModel: localAgentRouting?.fallbackModel ?? null,
        fallbackAuthProvider: localAgentRouting?.fallbackAuthProvider ?? null,
        fallbackAuthChoice: localAgentRouting?.fallbackAuthChoice ?? null,
        defaultThinking: localAgentRouting?.thinking ?? null,
        collaborationConfig: 'Local runtime',
        contactId: 'desktop:local-agent',
        systemPrompt: localAgent.systemPrompt,
        xMd: localAgent.workspaceRoot,
        identityFiles: localAgent.identityFiles,
        loadedTools: localAgent.loadedTools,
        loadedSkills: localAgent.loadedSkills,
        loadedPlugins: localAgent.loadedPlugins,
        lastActivities: localAgent.lastActivities,
        exposesIdentityFiles: true,
        exposesLoadedSkills: true,
        exposesLoadedTools: true,
        exposesLoadedPlugins: true,
        isOwned: true,
        isCollaborationActive: true,
        avatarSeed: getLocalAgentAvatarSeed(),
      });
    }

    const existingIds = new Set(items.map((agent) => agent.id));
    for (const cloudAgent of Object.values(cloudAgentDefinitionsById).sort((left, right) => left.name.localeCompare(right.name))) {
      const agent = cloudAgentDefinitionToAgent(cloudAgent);
      if (!existingIds.has(agent.id)) {
        items.push(agent);
        existingIds.add(agent.id);
      }
    }

    return items;
  }, [cloudAgentDefinitionsById, desktopCollaborationState?.hosts, desktopCollaborationState?.localAgentRouting, desktopChatState?.localAgent, isNativeShell, localAgentCollaborationReachoutsByAgentId, localAgentDisplayName]);

  const groupedContacts = useMemo(
    () =>
      contactGroups.map((group) => ({
        ...group,
        items: displayedContacts.filter((contact) => contact.classType === group.id).sort((a, b) => a.name.localeCompare(b.name)),
      })),
    [displayedContacts],
  );

  const filteredGroupedContacts = useMemo(() => {
    const normalizedSearch = contactSearch.trim().toLowerCase();

    return groupedContacts.map((group) => ({
      ...group,
      items:
        normalizedSearch.length === 0
          ? group.items
          : group.items.filter((contact) =>
              [contact.name, contact.entityType, contact.subtitle, contact.detail]
                .filter(Boolean)
                .some((value) => value.toLowerCase().includes(normalizedSearch)),
            ),
    }));
  }, [contactSearch, groupedContacts]);

  const activeContact = displayedContacts.find((contact) => contact.id === activeContactId) ?? displayedContacts[0] ?? contacts[0];
  const activeAgent = displayedAgents.find((agent) => agent.id === activeAgentId) ?? displayedAgents[0];

  const runtimeProjects = useMemo(() => {
    if (!isNativeShell) {
      return projectWorkspaces;
    }

    const routingGroups = buildProjectRoutingGroups(desktopChatState?.projects, canonicalSessionState);
    if (routingGroups.length === 0) {
      return [];
    }

    const desktopProjects = desktopChatState?.projects ?? [];
    const desktopProjectById = new Map(
      desktopProjects.map((project) => [normalizeCanonicalProjectGroupId(project.id, project.root) ?? project.id, project]),
    );
    const workspaceProjectById = new Map(
      projectWorkspaces.map((project) => [canonicalProjectGroupIdFromRoot(project.root) ?? project.id, project]),
    );
    const canonicalProjectSessionById = new Map(
      (canonicalSessionState?.sessions ?? [])
        .filter((session) => session.kind === 'project')
        .map((session) => [session.id, session]),
    );

    return routingGroups.map((group) => {
      const desktopProject = desktopProjectById.get(group.id);
      const workspaceProject = workspaceProjectById.get(group.id);
      const projectScope = desktopProject?.root
        ?? workspaceProject?.root
        ?? projectRootFromCanonicalProjectGroupId(group.id)
        ?? group.id;
      const sharedSources = desktopProject?.sharedSources ?? workspaceProject?.sharedSources ?? [];
      const canonicalLeadSession = group.sessions
        .map((session) => canonicalProjectSessionById.get(session.id))
        .find((session) => Boolean(session));
      const projectName = desktopProject?.name
        ?? workspaceProject?.name
        ?? (canonicalLeadSession ? canonicalProjectDisplayName(canonicalLeadSession) : 'Project');
      const projectSummary = desktopProject?.summary
        ?? workspaceProject?.summary
        ?? (canonicalLeadSession ? canonicalProjectDisplayName(canonicalLeadSession) : projectScope);
      const sessionTaskActivitiesById = new Map(
        group.sessions.map(({ id: sessionId }) => [
          sessionId,
          canonicalTaskActivitiesForSession(canonicalReadModel, sessionId),
        ]),
      );
      const canonicalProjectTaskCount = group.sessions.reduce((total, { id: sessionId }) => {
        const messages = canonicalReadModel?.messages(sessionId) ?? [];
        return total + buildTaskActivityDashboard({ messages }).tasks.length;
      }, 0);

      return {
        id: group.id,
        name: projectName,
        summary: projectSummary,
        collaboration: 'Local',
        scope: projectScope,
        status: desktopProject?.backgroundSystem ? 'Configured' : 'Local',
        people: workspaceProject?.people ?? [],
        agents: workspaceProject?.agents ?? [],
        pendingInvites: workspaceProject?.pendingInvites ?? [],
        artifacts: sharedSources.length,
        tasks: canonicalProjectTaskCount > 0 ? canonicalProjectTaskCount : (workspaceProject?.tasks ?? 0),
        root: projectScope,
        sharedContext: desktopProject?.summary ?? workspaceProject?.sharedContext,
        backgroundSystem: desktopProject?.backgroundSystem ?? workspaceProject?.backgroundSystem,
        sharedSources,
        sessions: group.sessions.map(({ id: sessionId }) => {
          const desktopSession = desktopProject?.sessions.find((session) => session.id === sessionId);
          const canonicalSession = canonicalProjectSessionById.get(sessionId);
          const isVisibleSession = activeNav === 'projects' && activeProjectId === group.id && activeProjectSessionId === sessionId;
          const cachedSourceMessages = cachedDesktopSessionSourceMessages[sessionId];
          const baseMessages =
            desktopSession && desktopChatState?.activeSessionId === sessionId
              ? preferLatestMessages(
                  mapDesktopMessages(
                    sessionId,
                    desktopChatState.activeSession.messages,
                    { metadata: canonicalSession?.metadata },
                  ),
                  cachedProjectSessionMessages[sessionId],
                  Boolean(desktopLiveTurnsForViewModel[sessionId]),
                  desktopLiveTurnsForViewModel[sessionId],
                )
              : desktopSession && isVisibleSession && cachedSourceMessages
                ? mapDesktopMessages(
                    sessionId,
                    cachedSourceMessages,
                    { metadata: canonicalSession?.metadata },
                  )
              : cachedProjectSessionMessages[sessionId]
                ?? (desktopSession
                  ? [{ role: 'system' as const, text: desktopSession.draft ? 'Draft session' : 'Session ready', time: desktopSession.updatedAtLabel }]
                  : []);
          const outreachMessages = (outreachThreadsByParentSession.get(sessionId) ?? []).flatMap((thread) => thread.inlineMessages);
          const legacyMessages = [...baseMessages, ...outreachMessages];
          const messages = canonicalReadModel ? canonicalReadModel.preferMessages(sessionId, legacyMessages) : legacyMessages;
          const reflectionLessonArtifacts = desktopChatState?.activeSessionId === sessionId
            ? (desktopChatState.activeSession.reflectionLessonArtifacts ?? [])
            : [];
          const canonicalParticipants = canonicalReadModel?.participantDetails(sessionId) ?? [];
          const participants = canonicalParticipants.length > 0
            ? canonicalParticipants.map((participant) => participant.name)
            : ['Me', desktopChatState?.localAgent.label?.trim() || 'Kordi'];

          const unreadCount = isVisibleSession ? 0 : (localSessionUnreadCounts[sessionId] ?? 0);
          const taskActivities = sessionTaskActivitiesById.get(sessionId) ?? [];
          const taskCount = buildTaskActivityDashboard({ messages }).tasks.length || (workspaceProject?.tasks ?? 0);

          return {
            id: sessionId,
            name: canonicalReadModel?.sessionTitle(sessionId, desktopSession?.title ?? canonicalSession?.title ?? 'Project session') ?? desktopSession?.title ?? canonicalSession?.title ?? 'Project session',
            summary: buildConversationPreview(messages, desktopSession?.subtitle ?? canonicalSession?.title),
            lastActive: desktopSession?.updatedAtLabel ?? messages[messages.length - 1]?.time ?? '--:--',
            status: desktopSession?.draft || canonicalSession?.status === 'draft' ? 'Draft' : 'Active',
            participants,
            artifacts: sharedSources.length,
            tasks: taskCount,
            taskActivities,
            canonicalParticipants: canonicalParticipants.length > 0 ? canonicalParticipants : undefined,
            unread: unreadCount,
            statusIndicator: buildSessionStatusIndicator({
              unreadCount,
              showBackgroundActivity: !isVisibleSession,
              liveTurn: desktopLiveTurnsForViewModel[sessionId],
            }),
            reflectionLessonArtifacts,
            messages,
          };
        }),
      };
    });
  }, [activeNav, activeProjectId, activeProjectSessionId, cachedDesktopSessionSourceMessages, cachedProjectSessionMessages, canonicalReadModel, canonicalSessionState, desktopChatState, desktopLiveTurnsForViewModel, isNativeShell, localSessionUnreadCounts, mapDesktopMessages, outreachThreadsByParentSession, projectWorkspaces]);

  const filteredProjects = useMemo(() => {
    const normalizedSearch = projectSearch.trim().toLowerCase();

    return runtimeProjects.filter((project) => {
      if (normalizedSearch.length === 0) return true;

      return [project.name, project.summary, project.scope, ...project.sessions.map((session) => session.name)]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(normalizedSearch));
    });
  }, [projectSearch, runtimeProjects]);

  const resolvedProjectSelection = resolveProjectSelection(
    runtimeProjects.map((project) => ({
      id: project.id,
      sessions: project.sessions.map((session) => ({ id: session.id })),
    })),
    activeProjectId,
    activeProjectSessionId,
    projectSelectedSessionIds,
  );
  const emptyNativeProject: Project = {
    id: '',
    name: 'No project yet',
    summary: 'Projects only appear after you explicitly start one from the + menu.',
    collaboration: 'Local',
    scope: '',
    status: 'Empty',
    people: [],
    agents: [],
    pendingInvites: [],
    artifacts: 0,
    tasks: 0,
    root: '',
    sharedContext: undefined,
    backgroundSystem: undefined,
    sharedSources: [],
    sessions: [{
      id: '',
      name: 'Start a project session',
      summary: 'Write below or create a session to persist work under this project.',
      lastActive: '--:--',
      status: 'Draft',
      participants: ['Me', desktopChatState?.localAgent.label?.trim() || 'Kordi'],
      artifacts: 0,
      tasks: 0,
      unread: 0,
      statusIndicator: undefined,
      messages: [{
        role: 'system' as const,
        text: 'Use the + menu to start a project. Normal chats should stay in Chats by default.',
        time: '--:--',
      }],
    }],
  };
  const fallbackProject = isNativeShell
    ? (runtimeProjects[0] ?? emptyNativeProject)
    : (runtimeProjects[0] ?? projectWorkspaces[0]);
  const activeProject = runtimeProjects.find((project) => project.id === resolvedProjectSelection?.projectId)
    ?? runtimeProjects.find((project) => project.id === activeProjectId)
    ?? fallbackProject;
  const nativeProjectDraftSession = {
    id: activeProjectSessionId,
    name: 'New session',
    summary: 'Blank project drafts stay local until the first real send.',
    lastActive: 'Draft',
    status: 'Draft',
    participants: ['Me', desktopChatState?.localAgent.label?.trim() || 'Kordi'],
    artifacts: activeProject.artifacts,
    tasks: activeProject.tasks,
    taskActivities: [],
    unread: 0,
    statusIndicator: undefined,
    messages: [] as Message[],
  };
  const activeProjectSession = isNativeShell && isProjectDraftSessionId(activeProjectSessionId)
    ? nativeProjectDraftSession
    : activeProject.sessions.find((session) => session.id === resolvedProjectSelection?.sessionId)
      ?? activeProject.sessions[0]
      ?? emptyNativeProject.sessions[0];
  const activeProjectLastMessage = activeProjectSession.messages[activeProjectSession.messages.length - 1];

  const activeCollaborationHost = useMemo<DesktopCollaborationHost | null>(() => {
    if (!desktopCollaborationState?.hosts?.length) return null;
    return desktopCollaborationState.hosts.find((host) => host.id === desktopCollaborationState.activeHostId) ?? desktopCollaborationState.hosts[0] ?? null;
  }, [desktopCollaborationState]);

  const activeCollaborationConversation = useMemo(
    () => (desktopCollaborationState?.conversations ?? []).find((conversation) => conversation.id === activeConvId) ?? null,
    [activeConvId, desktopCollaborationState?.conversations],
  );

  const activeCollaborationConversationHost = useMemo(
    () => (activeCollaborationConversation ? (desktopCollaborationState?.hosts ?? []).find((host) => host.id === activeCollaborationConversation.hostId) ?? null : null),
    [activeCollaborationConversation, desktopCollaborationState?.hosts],
  );

  const activeCollaborationAwaitingReply = activeCollaborationConversation?.awaitingReply ?? false;

  return {
    chatConversations,
    companionConversations,
    filteredConversations,
    participantSpaces,
    contactParticipantSpaces,
    agentParticipantSpaces,
    activeConv,
    activeConversationUsesCollaboration,
    activeLastMessage,
    activeConvHasSubtitle,
    displayedContacts,
    addableContacts,
    displayedAgents,
    groupedContacts,
    filteredGroupedContacts,
    activeContact,
    activeAgent,
    runtimeProjects,
    filteredProjects,
    activeProject,
    activeProjectSession,
    activeProjectLastMessage,
    activeCollaborationHost,
    activeCollaborationConversation,
    activeCollaborationConversationHost,
    activeCollaborationAwaitingReply,
  };
}
