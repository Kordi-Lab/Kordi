import { useMemo, useRef } from 'react';

import { mapBridgeConversationToViewModel } from '@/features/bridge/transcript';
import { isBridgeAgentRuntime } from '@/features/bridge/runtime';
import { isCloudAgentRuntimeSessionId } from '@/features/cloud/cloudAgentMessages';
import { cloudPeerAccountIdFromConversationId, cloudSessionIdFromConversationId, isCloudBridgeConversationId, isCloudBridgeHostId } from '@/features/cloud/cloudBridgeState';
import { CLOUD_PIXEL_AVATAR_URL_PREFIX, cloudAvatarImageUrl } from '@/features/cloud/avatar';
import { EMPTY_CLOUD_SESSION_ACTIVITY, cloudTaskActivitiesForSession, type CloudSessionActivityStore } from '@/features/cloud/cloudSessionActivity';
import { cloudAgentDefinitionToAgent, type CloudAgentDefinition } from '@/features/cloud/cloudAgents';
import { presenceStatusForAccount, type CloudPresenceStore } from '@/features/cloud/presence';
import {
  buildProjectRoutingGroups,
  canonicalProjectGroupIdFromRoot,
  isCanonicalBridgeSessionId,
  isCanonicalCloudSessionId,
  normalizeCanonicalProjectGroupId,
  projectRootFromCanonicalProjectGroupId,
  resolveProjectSelection,
} from '@/features/canonical/sessionResolver';
import { createCanonicalSessionReadModel } from '@/features/canonical/sessionReadModel';
import type { SessionHydrationState } from '@/features/canonical/canonicalStore';
import { LOCAL_DRAFT_CHAT_CONVERSATION_ID, isLocalDraftChatConversationId, isProjectDraftSessionId } from '@/features/chat/draftSessions';
import { buildTaskActivityDashboard } from '@/features/chat/taskActivityDashboard';
import { buildParticipantSpaces, ensureSelfParticipantSpace, filterParticipantSpaces } from '@/features/chat/participantSpaces';
import { getLocalAgentAvatarSeed, getLocalProfileAvatarSeed } from '@/kordi-app/components/IdentityAvatar';
import { contactGroups, contacts, conversations } from '@/kordi-app/data';
import type {
  Agent,
  CanonicalSessionState,
  CanonicalSessionSummary,
  Contact,
  Conversation,
  DesktopBridgeConversation,
  DesktopBridgeHost,
  DesktopBridgePeer,
  DesktopBridgeProject,
  DesktopBridgeState,
  DesktopChatMessage,
  DesktopChatState,
  DesktopChatTurnSnapshot,
  Message,
  Project,
  SessionStatusIndicator,
  SessionTaskActivity,
} from '@/kordi-app/types';
import { isSelfReferenceName } from '@/lib/identityLabels';
import { getInitials } from '@/kordi-app/utils';

function sanitizeRemotePeerName(
  ...candidates: Array<string | null | undefined>
): string {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed && !isSelfReferenceName(trimmed)) return trimmed;
  }
  // All candidates were self-references or empty; return the first non-empty raw value as a
  // last resort so the contact still renders something stable.
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return 'Bridge user';
}

function bridgeProfileImageUrl(value: string | null | undefined): string | null {
  const normalized = cloudAvatarImageUrl(value);
  if (normalized) return normalized;
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith(CLOUD_PIXEL_AVATAR_URL_PREFIX)) return null;
  return trimmed;
}
import {
  bridgePeerIsApprovedContact,
  buildConversationPreview,
  buildOutreachInlineMessages,
  buildSessionStatusIndicator,
  canonicalProjectDisplayName,
  canonicalProjectRoot,
  findBridgeProjectForWorkspace,
  preferLatestMessages,
  hideRawConversationIds,
  visibleBridgePeople,
  bridgePeerIsReachableAgent,
} from './viewModels/helpers';

function canonicalAvatarSeed(state: CanonicalSessionState | null | undefined, identityId?: string | null) {
  const id = identityId?.trim();
  if (!state || !id) return null;
  return state.identities.find((identity) => identity.id === id)?.avatarKey?.trim() || null;
}

function canonicalLocalAgentAvatarSeed(state: CanonicalSessionState | null | undefined) {
  if (!state) return null;
  const activeAgentSeed = canonicalAvatarSeed(state, state.profile.activeAgentIdentityId);
  if (activeAgentSeed) return activeAgentSeed;
  const profileHumanIdentityId = state.profile.humanIdentityId?.trim();
  if (!profileHumanIdentityId) return null;
  return state.identities.find((identity) => (
    identity.kind === 'agent'
    && identity.source === 'local'
    && identity.ownerIdentityId === profileHumanIdentityId
  ))?.avatarKey?.trim() || null;
}

export { findBridgeProjectForWorkspace } from './viewModels/helpers';

export function bridgeChatConversationRoutesToLocalAgentPage(
  conversation: Pick<DesktopBridgeConversation, 'hostId' | 'outreach' | 'identity' | 'projectId'>,
) {
  if (isCloudBridgeHostId(conversation.hostId)) return false;
  const outreach = conversation.outreach;
  if (outreach?.targetKind !== 'bridge-agent') return false;
  if (outreach.parentSessionId?.trim()) return false;
  if (conversation.projectId?.trim()) return false;
  const localAgentId = conversation.identity?.localAgentId?.trim();
  const targetAgentId = outreach.targetAgentId?.trim();
  return Boolean(localAgentId && targetAgentId && localAgentId === targetAgentId);
}

export function bridgeChatConversationIsVisible(
  conversation: Pick<DesktopBridgeConversation, 'outreach'>,
) {
  return !conversation.outreach?.parentSessionId;
}

export function activeConversationForSelection(
  activeConvId: string,
  chatConversations: Conversation[],
  options: {
    isNativeShell: boolean;
    nativeChatPlaceholder: Conversation;
    fallbackConversation?: Conversation;
  },
): Conversation {
  if (options.isNativeShell && isLocalDraftChatConversationId(activeConvId)) {
    return options.nativeChatPlaceholder;
  }
  const activeCloudSessionId = isCloudBridgeConversationId(activeConvId)
    ? cloudSessionIdFromConversationId(activeConvId)
    : null;
  const selectedConversation = chatConversations.find((conversation) => conversation.id === activeConvId)
    ?? chatConversations.find((conversation) => conversation.canonicalSessionId === activeConvId)
    ?? (activeCloudSessionId
      ? chatConversations.find((conversation) => conversation.id === activeCloudSessionId || conversation.canonicalSessionId === activeCloudSessionId)
      : undefined);
  if (selectedConversation) {
    const selectedCanonicalId = selectedConversation.canonicalSessionId ?? selectedConversation.id;
    if (isCanonicalCloudSessionId(selectedCanonicalId) && selectedConversation.messages.length === 0) {
      const pending = pendingCanonicalCloudConversationForActiveId(selectedCanonicalId);
      return pending ? {
        ...selectedConversation,
        subtitle: selectedConversation.subtitle || pending.subtitle,
        messages: pending.messages,
      } : selectedConversation;
    }
    return selectedConversation;
  }
  const pendingCloudConversation = pendingCloudBridgeConversationForActiveId(activeConvId);
  if (pendingCloudConversation) return pendingCloudConversation;
  const pendingCanonicalCloudConversation = pendingCanonicalCloudConversationForActiveId(activeConvId);
  if (pendingCanonicalCloudConversation) return pendingCanonicalCloudConversation;
  return chatConversations[0] ?? (options.isNativeShell ? options.nativeChatPlaceholder : options.fallbackConversation ?? options.nativeChatPlaceholder);
}

export function pendingCanonicalCloudConversationForActiveId(activeConvId: string): Conversation | null {
  const sessionId = activeConvId.trim();
  if (!isCanonicalCloudSessionId(sessionId)) return null;
  const isGroup = sessionId.startsWith('session:group:');
  return {
    id: sessionId,
    canonicalSessionId: sessionId,
    name: isGroup ? 'Opening group chat…' : 'Opening Cloud chat…',
    type: isGroup ? 'owned-agent' : 'person',
    subtitle: 'Loading chat history…',
    unread: 0,
    bridges: ['Cloud'],
    trust: 'Bridge',
    directness: isGroup ? 'Group chat' : 'Person chat',
    participants: ['Me'],
    messages: [{ role: 'system', text: 'Loading chat history…', time: '--:--' }],
  };
}

export function pendingCloudBridgeConversationForActiveId(activeConvId: string): Conversation | null {
  if (!isCloudBridgeConversationId(activeConvId)) return null;
  const peerId = cloudPeerAccountIdFromConversationId(activeConvId);
  if (!peerId) return null;
  return {
    id: activeConvId,
    canonicalSessionId: undefined,
    name: peerId,
    type: 'person',
    subtitle: 'Opening chat with this person…',
    unread: 0,
    bridges: ['Cloud'],
    trust: 'Bridge',
    directness: 'Person chat',
    participants: ['Me', peerId],
    messages: [{ role: 'system', text: 'Opening chat with this person…', time: '--:--' }],
    bridgeTarget: {
      hostId: 'cloud',
      nodeId: peerId,
      displayName: peerId,
      ownerName: peerId,
      runtime: 'person',
      humanId: peerId,
      agentId: null,
    },
    avatarSeed: peerId,
  };
}

function cloudAccountIdFromParticipant(participant: { id?: string | null; humanId?: string | null; bridgeNodeId?: string | null }) {
  const candidates = [participant.humanId, participant.bridgeNodeId, participant.id]
    .map((value) => value?.trim() ?? '')
    .filter(Boolean)
    .flatMap((value) => [value, value.replace(/^human:/, '')]);
  return candidates.find((value) => value.startsWith('acct_')) ?? null;
}

export function applyCloudPresenceToConversations(conversations: Conversation[], cloudPresence: CloudPresenceStore): Conversation[] {
  if (Object.keys(cloudPresence).length === 0) return conversations;
  return conversations.map((conversation) => {
    const participants = conversation.canonicalParticipants;
    if (!participants?.length) {
      const accountId = cloudAccountIdFromParticipant({
        humanId: conversation.bridgeTarget?.humanId,
        bridgeNodeId: conversation.bridgeTarget?.nodeId,
      });
      if (!accountId || !cloudPresence[accountId]) return conversation;
      const presenceStatus = presenceStatusForAccount(cloudPresence, accountId);
      if (conversation.participantPresenceStatuses?.[accountId] === presenceStatus) return conversation;
      return {
        ...conversation,
        participantPresenceStatuses: {
          ...(conversation.participantPresenceStatuses ?? {}),
          [accountId]: presenceStatus,
        },
      };
    }
    let changed = false;
    const canonicalParticipants = participants.map((participant) => {
      if (participant.kind !== 'human') return participant;
      const accountId = cloudAccountIdFromParticipant(participant);
      if (!accountId) return participant;
      const presenceStatus = presenceStatusForAccount(cloudPresence, accountId);
      if (participant.presenceStatus === presenceStatus) return participant;
      changed = true;
      return { ...participant, presenceStatus };
    });
    return changed ? { ...conversation, canonicalParticipants } : conversation;
  });
}

function liveTurnsViewModelSignature(liveTurns: Record<string, DesktopChatTurnSnapshot>) {
  return Object.entries(liveTurns)
    .map(([sessionId, turn]) => [
      sessionId,
      turn.id,
      turn.status,
      turn.completed ? 'completed' : 'running',
      turn.succeeded ? 'succeeded' : 'pending',
      turn.error ? 'error' : 'ok',
      turn.tools.map((tool) => `${tool.id}:${tool.status}:${tool.isError ? 'error' : 'ok'}`).join(','),
    ].join('\u0000'))
    .sort()
    .join('\u0001');
}

function canonicalTaskActivitiesForSession(
  readModel: ReturnType<typeof createCanonicalSessionReadModel>,
  sessionId: string,
) {
  return readModel?.taskActivities(sessionId) ?? [];
}

type UseWorkspaceViewModelsArgs = {
  isNativeShell: boolean;
  isDesktopChatLoading: boolean;
  desktopChatState: DesktopChatState | null;
  desktopBridgeState: DesktopBridgeState | null;
  canonicalSessionState: CanonicalSessionState | null;
  canonicalSessionSummaries?: CanonicalSessionSummary[];
  canonicalHydrationBySessionId?: Record<string, SessionHydrationState>;
  hiddenSessionIds: Set<string>;
  projectWorkspaces: Project[];
  projectSelectedSessionIds: Record<string, string>;
  activeNav: 'chats' | 'contacts' | 'projects' | 'agents' | 'bridge' | 'settings';
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
  localSessionUnreadCounts: Record<string, number>;
  desktopLiveTurnsBySession: Record<string, DesktopChatTurnSnapshot>;
  mapDesktopMessages: (sessionId: string, messages: DesktopChatMessage[], sessionContext?: { metadata?: unknown }) => Message[];
  cloudSessionActivity?: CloudSessionActivityStore;
  cloudAgentDefinitionsById?: Record<string, CloudAgentDefinition>;
  cloudPresence?: CloudPresenceStore;
  cloudUnreadReady?: boolean;
};

export function useWorkspaceViewModels({
  isNativeShell,
  isDesktopChatLoading,
  desktopChatState,
  desktopBridgeState,
  canonicalSessionState,
  canonicalSessionSummaries = [],
  canonicalHydrationBySessionId = {},
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
  localSessionUnreadCounts,
  desktopLiveTurnsBySession,
  mapDesktopMessages,
  cloudSessionActivity = EMPTY_CLOUD_SESSION_ACTIVITY,
  cloudAgentDefinitionsById = {},
  cloudPresence = {},
  cloudUnreadReady = true,
}: UseWorkspaceViewModelsArgs) {
  const canonicalReadModel = useMemo(
    () => createCanonicalSessionReadModel(canonicalSessionState, {
      summaries: canonicalSessionSummaries,
      cloudUnreadReady,
    }),
    [canonicalSessionState, canonicalSessionSummaries, cloudUnreadReady],
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

    for (const conversation of desktopBridgeState?.conversations ?? []) {
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
  }, [desktopBridgeState?.conversations]);

  const localChatConversations = useMemo(() => {
    if (!isNativeShell || !desktopChatState?.activeSession) {
      return [];
    }

    const localAgentLabel = desktopChatState.localAgent?.label || 'Kordi';
    const canonicalSessionMetadataById = new Map(
      (canonicalSessionState?.sessions ?? []).map((session) => [session.id, session.metadata]),
    );
    const activeHost = desktopBridgeState?.hosts.find((host) => host.id === desktopBridgeState.activeHostId)
      ?? desktopBridgeState?.hosts[0]
      ?? null;
    const activeHostAgentId = activeHost?.activeAgentId ?? null;
    const activeHostAgent = activeHost?.agents.find((agent) => agent.id === activeHostAgentId)
      ?? activeHost?.agents.find((agent) => agent.isActive)
      ?? activeHost?.agents.find((agent) => agent.isDefault)
      ?? activeHost?.agents[0]
      ?? null;
    const localAgentAvatarSeed = canonicalLocalAgentAvatarSeed(canonicalSessionState)
      || activeHostAgent?.id
      || activeHost?.activeAgentId
      || activeHostAgent?.nodeId
      || activeHost?.nodeId
      || getLocalAgentAvatarSeed(localAgentLabel);
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
      const cachedMessages = cachedChatSessionMessages[session.id];
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
        desktopRuntimeTranscriptLoaded: isActiveSession || Boolean(cachedMessages),
        name: session.title,
        type: 'owned-agent' as const,
        subtitle: buildConversationPreview(messages, session.subtitle),
        unread: unreadCount,
        bridges: ['Local'],
        trust: 'Owned',
        directness: session.draft ? 'Draft' : 'Agent chat',
        participants: ['Me', 'My Kordi'],
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
        bridgeTarget: undefined,
        avatarSeed: localAgentAvatarSeed,
        outreachThreads,
        forkedFromSessionId: session.forkedFromSessionId ?? null,
        forkedFromMessageId: session.forkedFromMessageId ?? null,
        _updatedAtMs: undefined as number | undefined,
      };
    });
  }, [activeConvId, activeNav, cachedChatSessionMessages, canonicalSessionState, desktopBridgeState, desktopChatState, desktopLiveTurnsForViewModel, isNativeShell, localSessionUnreadCounts, mapDesktopMessages, outreachThreadsByParentSession]);

  const localAgentBridgeReachoutConversations = useMemo(() => {
    if (!isNativeShell) return [];
    const hostById = new Map((desktopBridgeState?.hosts ?? []).map((host) => [host.id, host]));
    const localAgentLabel = desktopChatState?.localAgent?.label || 'My agent';
    return (desktopBridgeState?.conversations ?? [])
      .filter(bridgeChatConversationRoutesToLocalAgentPage)
      .map((conversation) => (
        mapBridgeConversationToViewModel(conversation, hostById.get(conversation.hostId), localAgentLabel)
      ));
  }, [desktopBridgeState, desktopChatState?.localAgent?.label, isNativeShell]);

  const bridgeChatConversations = useMemo(() => {
    if (!isNativeShell) return [];
    const hostById = new Map((desktopBridgeState?.hosts ?? []).map((host) => [host.id, host]));
    const localAgentLabel = desktopChatState?.localAgent?.label || 'My agent';
    return (desktopBridgeState?.conversations ?? [])
      .filter((conversation) => !bridgeChatConversationRoutesToLocalAgentPage(conversation))
      .map((conversation) => (
        mapBridgeConversationToViewModel(conversation, hostById.get(conversation.hostId), localAgentLabel)
      ));
  }, [desktopBridgeState, desktopChatState?.localAgent?.label, isNativeShell]);

  const visibleBridgeChatConversations = useMemo(
    () => bridgeChatConversations.filter(bridgeChatConversationIsVisible),
    [bridgeChatConversations],
  );

  const localAgentBridgeReachoutSessionIds = useMemo(() => new Set(
    localAgentBridgeReachoutConversations.flatMap((conversation) => [conversation.id, conversation.canonicalSessionId].filter((value): value is string => Boolean(value))),
  ), [localAgentBridgeReachoutConversations]);

  const hydratedChatConversations = useMemo(() => {
    if (!isNativeShell) {
      return conversations;
    }
    const bridgeSourceConversations = canonicalReadModel ? bridgeChatConversations : visibleBridgeChatConversations;
    const merged = [...bridgeSourceConversations, ...localChatConversations];
    merged.sort((a, b) => (b._updatedAtMs ?? 0) - (a._updatedAtMs ?? 0));
    const sourceConversations = merged.map(({ _updatedAtMs, ...conversation }) => conversation);
    return canonicalReadModel
      ? canonicalReadModel.buildChatConversations(sourceConversations, buildConversationPreview)
      : sourceConversations;
  }, [bridgeChatConversations, canonicalReadModel, conversations, isNativeShell, localChatConversations, visibleBridgeChatConversations]);

  const chatConversations = useMemo(() => {
    const hiddenIds = new Set([...hiddenSessionIds, ...localAgentBridgeReachoutSessionIds]);
    const visibleConversations = hiddenIds.size === 0
      ? hydratedChatConversations
      : hydratedChatConversations.filter((conversation) => {
          const canonicalId = conversation.canonicalSessionId ?? conversation.id;
          if (activeConvId === conversation.id || activeConvId === canonicalId) return true;
          return !hiddenIds.has(canonicalId) && !hiddenIds.has(conversation.id);
        });
    const withCloudPresence = applyCloudPresenceToConversations(visibleConversations, cloudPresence);
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
  }, [activeConvId, cloudPresence, cloudSessionActivity, hiddenSessionIds, hydratedChatConversations, localAgentBridgeReachoutSessionIds]);

  const nativeChatPlaceholder = useMemo(
    () => {
      const placeholderText = 'Blank drafts stay local until the first real send.';
      return {
      id: LOCAL_DRAFT_CHAT_CONVERSATION_ID,
      canonicalSessionId: undefined,
      name: 'New session',
      type: 'owned-agent' as const,
      subtitle: placeholderText,
      unread: 0,
      bridges: ['Local'],
      trust: 'Owned',
      directness: 'Draft',
      participants: ['Me', 'My Kordi'],
      bridgeTarget: undefined,
      messages: [],
    };
    },
    [],
  );

  const activeConv = useMemo(() => {
    const selected = activeConversationForSelection(activeConvId, chatConversations, {
      isNativeShell,
      nativeChatPlaceholder,
      fallbackConversation: conversations[0],
    });
    const canonicalSessionId = selected.canonicalSessionId ?? selected.id;
    const hydration = canonicalHydrationBySessionId[canonicalSessionId];
    if (selected.desktopRuntimeBacked || (hydration !== 'cold' && hydration !== 'loading')) return selected;
    return {
      ...selected,
      subtitle: 'Loading chat history…',
      messages: [{ role: 'system' as const, text: 'Loading chat history…', time: '--:--' }],
    };
  }, [activeConvId, canonicalHydrationBySessionId, chatConversations, isNativeShell, nativeChatPlaceholder]);
  const activeConversationIsBridge = isNativeShell && (
    activeConv.id.startsWith('bridge:')
    || isCanonicalBridgeSessionId(activeConv.canonicalSessionId ?? activeConv.id)
    || isCanonicalCloudSessionId(activeConv.canonicalSessionId ?? activeConv.id)
    || Boolean(activeConv.bridgeTarget)
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
    const bridgeLabel = (url: string) => url.replace(/^https?:\/\//, '');
    const localAgent = desktopChatState?.localAgent;

    for (const host of desktopBridgeState?.hosts ?? []) {
      const label = bridgeLabel(host.serverUrl);
      const activeHostAgent = host.agents.find((agent) => agent.id === host.activeAgentId)
        ?? host.agents.find((agent) => agent.isActive)
        ?? host.agents.find((agent) => agent.isDefault)
        ?? host.agents[0]
        ?? null;
      const localAgentAvatarSeed = activeHostAgent?.id || host.activeAgentId || activeHostAgent?.nodeId || host.nodeId || host.id;
      byId.set(`bridge-self:${host.id}`, {
        id: `bridge-self:${host.id}`,
        name: host.displayName,
        initials: getInitials(host.displayName),
        classType: 'my-agents',
        entityType: 'My agent',
        subtitle: 'Direct local chat',
        bridges: [label],
        status: host.connected ? 'Owned' : 'Offline',
        discoverableOn: [label],
        detail: `Chat directly with my local Kordi agent. Bridge host: ${label}${host.nodeId ? ` • ${host.nodeId}` : ''}`,
        owner: 'Me',
        bridgeHostId: host.id,
        bridgePeerNodeId: host.nodeId ?? undefined,
        bridgePeerRuntime: 'kordi-desktop',
        bridgeHumanId: host.humanId,
        bridgeAgentId: host.activeAgentId ?? undefined,
        avatarSeed: localAgentAvatarSeed,
      });

      for (const peer of host.visiblePeers) {
        if (!bridgePeerIsApprovedContact(peer)) continue;
        const isAgent = isBridgeAgentRuntime(peer.runtime);
        const bridgeContactStatus = peer.isContact ? 'contact' : (peer.contactRequestStatus?.trim() || 'none');
        const bridgeContactRequestDirection = peer.contactRequestDirection?.trim() || null;
        if (!isAgent || bridgePeerIsReachableAgent(peer)) {
          const id = isAgent
            ? `bridge-peer-agent:${peer.nodeId}:${peer.agentId ?? peer.runtime}`
            : `bridge-peer-person:${peer.nodeId}:${peer.humanId ?? 'person'}`;
          const existing = byId.get(id);
          const nextBridges = Array.from(new Set([...(existing?.bridges ?? []), label])).sort();
          const peerName = sanitizeRemotePeerName(peer.displayName, peer.ownerName, peer.humanId, peer.nodeId);
          byId.set(id, {
            id,
            name: peerName,
            initials: getInitials(peerName),
            classType: isAgent ? 'other-users-agents' : 'other-users',
            entityType: isAgent ? 'External agent' : 'Person',
            subtitle: peer.sharedProjects.length > 0 ? `${peer.runtime} • ${peer.sharedProjects.length} shared project${peer.sharedProjects.length === 1 ? '' : 's'}` : peer.runtime,
            bridges: nextBridges,
            status: host.connected ? 'Reachable' : 'Offline',
            discoverableOn: nextBridges,
            detail: [peer.nodeId, peer.endpoint, peer.sharedProjects.length > 0 ? `Shared projects: ${peer.sharedProjects.join(' • ')}` : null].filter(Boolean).join(' • '),
            owner: peer.ownerName || 'Unknown',
            bridgeHostId: host.id,
            bridgePeerNodeId: peer.nodeId,
            bridgePeerRuntime: peer.runtime,
            bridgeHumanId: peer.humanId,
            bridgeAgentId: peer.agentId,
            bridgeContactStatus,
            bridgeContactRequestDirection,
            avatarSeed: isAgent ? (peer.agentId || peer.nodeId) : (peer.avatarSeed || peer.humanId || peer.ownerName || peer.nodeId),
            profileImageUrl: bridgeProfileImageUrl(peer.profileImageUrl),
          });
        }

        if (isAgent && peer.ownerName && (bridgePeerIsReachableAgent(peer) || peer.isDefaultAgent)) {
          const personId = `bridge-peer-person:${peer.nodeId}:${peer.humanId ?? peer.ownerName}`;
          const existingPerson = byId.get(personId);
          const personBridges = Array.from(new Set([...(existingPerson?.bridges ?? []), label])).sort();
          const personName = sanitizeRemotePeerName(peer.ownerName, peer.humanId, peer.nodeId);
          byId.set(personId, {
            id: personId,
            name: personName,
            initials: getInitials(personName),
            classType: 'other-users',
            entityType: 'Person',
            subtitle: `Owner of ${peer.displayName || 'external agent'}`,
            bridges: personBridges,
            status: host.connected ? 'Reachable' : 'Offline',
            discoverableOn: personBridges,
            detail: [peer.humanId ? `Human ID: ${peer.humanId}` : null, peer.nodeId, peer.displayName ? `Agent: ${peer.displayName}` : null].filter(Boolean).join(' • '),
            owner: peer.ownerName,
            bridgeHostId: host.id,
            bridgePeerNodeId: peer.nodeId,
            bridgePeerRuntime: 'person',
            bridgeHumanId: peer.humanId,
            bridgeAgentId: peer.agentId,
            bridgeContactStatus,
            bridgeContactRequestDirection,
            avatarSeed: peer.avatarSeed || peer.humanId || peer.ownerName || peer.nodeId,
            profileImageUrl: bridgeProfileImageUrl(peer.profileImageUrl),
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
        bridges: ['Local'],
        status: 'Owned',
        discoverableOn: ['Local'],
        detail: `Chat directly with my local Kordi agent • ${localAgent.workspaceRoot}`,
        owner: 'Me',
        avatarSeed: getLocalAgentAvatarSeed(localAgent.label),
      });
    }

    return Array.from(byId.values());
  }, [desktopBridgeState?.hosts, desktopChatState?.localAgent, isNativeShell]);

  const addableContacts = useMemo<Contact[]>(() => {
    if (!isNativeShell) return [];
    const byId = new Map<string, Contact>();
    const bridgeLabel = (url: string) => url.replace(/^https?:\/\//, '');

    for (const host of desktopBridgeState?.hosts ?? []) {
      const label = bridgeLabel(host.serverUrl);
      for (const peer of visibleBridgePeople(host.visiblePeers)) {
        if (bridgePeerIsApprovedContact(peer)) continue;
        const id = `bridge-addable-person:${host.id}:${peer.nodeId}:${peer.humanId ?? 'person'}`;
        const existing = byId.get(id);
        const nextBridges = Array.from(new Set([...(existing?.bridges ?? []), label])).sort();
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
          bridges: nextBridges,
          status: subtitle,
          discoverableOn: nextBridges,
          detail: [peer.nodeId, peer.humanId ? `Human ID: ${peer.humanId}` : null].filter(Boolean).join(' • '),
          owner: peer.ownerName || peerName,
          bridgeHostId: host.id,
          bridgePeerNodeId: peer.nodeId,
          bridgePeerRuntime: 'person',
          bridgeHumanId: peer.humanId,
          bridgeAgentId: peer.agentId,
          bridgeContactStatus: status,
          bridgeContactRequestDirection: direction,
          avatarSeed: peer.avatarSeed || peer.humanId || peer.ownerName || peer.nodeId,
          profileImageUrl: bridgeProfileImageUrl(peer.profileImageUrl),
        });
      }
    }

    return Array.from(byId.values()).sort((left, right) => left.name.localeCompare(right.name));
  }, [desktopBridgeState?.hosts, isNativeShell]);

  const localAgentBridgeReachoutsByAgentId = useMemo(() => {
    const byAgentId = new Map<string, Agent['bridgeReachouts']>();
    for (const conversation of localAgentBridgeReachoutConversations) {
      const agentIds = [
        conversation.identity?.localAgentId,
        conversation.outreach?.targetAgentId,
        conversation.bridgeTarget?.agentId,
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
  }, [localAgentBridgeReachoutConversations]);

  const displayedAgents = useMemo<Agent[]>(() => {
    if (!isNativeShell) return [];

    const bridgeLabel = (url: string) => url.replace(/^https?:\/\//, '');
    const localAgent = desktopChatState?.localAgent;
    const items: Agent[] = [];
    const seen = new Set<string>();

    for (const host of desktopBridgeState?.hosts ?? []) {
      const hostLabel = bridgeLabel(host.serverUrl);
      for (const agent of host.agents) {
        const key = `owned:${host.id}:${agent.id}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const runtimeAgent = agent.isActive ? localAgent : undefined;
        const bridgeReachouts = [
          ...(localAgentBridgeReachoutsByAgentId.get(agent.id) ?? []),
          ...(agent.nodeId ? localAgentBridgeReachoutsByAgentId.get(agent.nodeId) ?? [] : []),
        ].filter((reachout, index, list) => list.findIndex((candidate) => candidate.sessionId === reachout.sessionId) === index);
        items.push({
          name: agent.label,
          id: agent.id,
          role: 'My agent',
          messaging: 'Direct local chat',
          status: bridgeReachouts.length > 0 ? `${bridgeReachouts.length} direct reachout${bridgeReachouts.length === 1 ? '' : 's'}` : agent.isActive ? 'Active' : agent.isDefault ? 'Default' : agent.registered ? 'Registered' : 'Local only',
          tasks: 0,
          defaultProvider: runtimeAgent?.defaultProvider ?? host.ownerName,
          defaultModel: agent.defaultModel ?? runtimeAgent?.defaultModel ?? agent.runtime,
          defaultAuthProvider: agent.defaultAuthProvider ?? null,
          defaultAuthChoice: agent.defaultAuthChoice ?? null,
          fallbackModel: agent.fallbackModel ?? null,
          fallbackAuthProvider: agent.fallbackAuthProvider ?? null,
          fallbackAuthChoice: agent.fallbackAuthChoice ?? null,
          defaultThinking: agent.thinking ?? null,
          bridgesConfig: hostLabel,
          contactId: `bridge-agent:${host.id}:${agent.id}`,
          systemPrompt: runtimeAgent?.systemPrompt ?? '',
          xMd: runtimeAgent?.workspaceRoot ?? [host.serverUrl, agent.nodeId || 'Pending node'].filter(Boolean).join(' • '),
          identityFiles: runtimeAgent?.identityFiles ?? [],
          loadedTools: runtimeAgent?.loadedTools ?? [],
          loadedSkills: runtimeAgent?.loadedSkills ?? [],
          loadedPlugins: runtimeAgent?.loadedPlugins ?? [],
          lastActivities: [
            ...bridgeReachouts.slice(0, 3).map((reachout) => `Direct reachout: ${reachout.title}${reachout.preview ? ` — ${reachout.preview}` : ''}`),
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
          bridgeHostId: host.id,
          bridgePeerNodeId: agent.nodeId ?? undefined,
          bridgePeerRuntime: agent.runtime,
          bridgeAgentId: agent.id,
          bridgeServerUrl: host.serverUrl,
          bridgeOwnerName: host.ownerName,
          isOwned: true,
          isBridgeDefault: agent.isDefault,
          isBridgeActive: agent.isActive,
          isBridgeRegistered: agent.registered,
          avatarSeed: agent.id,
          bridgeReachouts,
        });
      }
    }

    if (items.length === 0 && localAgent) {
      const localAgentRouting = desktopBridgeState?.localAgentRouting;
      items.push({
        name: localAgent.label,
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
        bridgesConfig: 'Local runtime',
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
        isBridgeActive: true,
        avatarSeed: getLocalAgentAvatarSeed(localAgent.label),
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
  }, [cloudAgentDefinitionsById, desktopBridgeState?.hosts, desktopBridgeState?.localAgentRouting, desktopChatState?.localAgent, isNativeShell, localAgentBridgeReachoutsByAgentId]);

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
        bridge: 'Local',
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
            : ['Me', 'My Kordi'];

          const isVisibleSession = activeNav === 'projects' && activeProjectId === group.id && activeProjectSessionId === sessionId;
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
  }, [activeNav, activeProjectId, activeProjectSessionId, cachedProjectSessionMessages, canonicalReadModel, canonicalSessionState, desktopChatState, desktopLiveTurnsForViewModel, isNativeShell, localSessionUnreadCounts, mapDesktopMessages, outreachThreadsByParentSession, projectWorkspaces]);

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
    bridge: 'Local',
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
      participants: ['Me', 'My Kordi'],
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
    participants: ['Me', 'My Kordi'],
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

  const activeBridgeHost = useMemo<DesktopBridgeHost | null>(() => {
    if (!desktopBridgeState?.hosts?.length) return null;
    return desktopBridgeState.hosts.find((host) => host.id === desktopBridgeState.activeHostId) ?? desktopBridgeState.hosts[0] ?? null;
  }, [desktopBridgeState]);

  const activeProjectBridgeProject = useMemo<DesktopBridgeProject | null>(
    () => findBridgeProjectForWorkspace(activeBridgeHost, activeProject.name, activeProject.root),
    [activeBridgeHost, activeProject.name, activeProject.root],
  );

  const activeBridgeConversation = useMemo(
    () => (desktopBridgeState?.conversations ?? []).find((conversation) => conversation.id === activeConvId) ?? null,
    [activeConvId, desktopBridgeState?.conversations],
  );

  const activeBridgeConversationHost = useMemo(
    () => (activeBridgeConversation ? (desktopBridgeState?.hosts ?? []).find((host) => host.id === activeBridgeConversation.hostId) ?? null : null),
    [activeBridgeConversation, desktopBridgeState?.hosts],
  );

  const activeBridgePeople = useMemo(
    () => visibleBridgePeople(activeBridgeHost?.visiblePeers ?? []),
    [activeBridgeHost],
  );
  const activeBridgeAgents = useMemo(
    () => (activeBridgeHost?.visiblePeers ?? []).filter(bridgePeerIsReachableAgent),
    [activeBridgeHost],
  );
  const activeBridgeAwaitingReply = activeBridgeConversation?.awaitingReply ?? false;

  return {
    chatConversations,
    filteredConversations,
    participantSpaces,
    contactParticipantSpaces,
    agentParticipantSpaces,
    activeConv,
    activeConversationIsBridge,
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
    activeBridgeHost,
    activeProjectBridgeProject,
    activeBridgeConversation,
    activeBridgeConversationHost,
    activeBridgePeople,
    activeBridgeAgents,
    activeBridgeAwaitingReply,
  };
}
