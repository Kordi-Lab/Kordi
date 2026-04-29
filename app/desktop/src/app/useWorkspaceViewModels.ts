import { useMemo, useRef } from 'react';

import { mapBridgeConversationToViewModel } from '@/features/bridge/transcript';
import { isBridgeAgentRuntime } from '@/features/bridge/runtime';
import {
  buildProjectRoutingGroups,
  canonicalProjectGroupIdFromRoot,
  isCanonicalBridgeSessionId,
  normalizeCanonicalProjectGroupId,
  projectRootFromCanonicalProjectGroupId,
  resolveProjectSelection,
} from '@/features/canonical/sessionResolver';
import { createCanonicalSessionReadModel } from '@/features/canonical/sessionReadModel';
import { LOCAL_DRAFT_CHAT_CONVERSATION_ID, isLocalDraftChatConversationId, isProjectDraftSessionId } from '@/features/chat/draftSessions';
import { getLocalAgentAvatarSeed, getLocalProfileAvatarSeed } from '@/kordi-app/components/IdentityAvatar';
import { contactGroups, contacts, conversations } from '@/kordi-app/data';
import type {
  Agent,
  CanonicalSessionState,
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
} from '@/kordi-app/types';
import { getInitials } from '@/kordi-app/utils';
import {
  buildConversationPreview,
  buildOutreachInlineMessages,
  buildSessionStatusIndicator,
  canonicalProjectDisplayName,
  canonicalProjectRoot,
  findBridgeProjectForWorkspace,
  preferLatestMessages,
  hideRawConversationIds,
  visibleBridgePeople,
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

export function bridgeChatConversationIsVisible(
  conversation: Pick<DesktopBridgeConversation, 'outreach' | 'messages' | 'peerDisplayName' | 'peerOwnerName'>,
) {
  return !conversation.outreach?.parentSessionId;
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

type UseWorkspaceViewModelsArgs = {
  isNativeShell: boolean;
  isDesktopChatLoading: boolean;
  desktopChatState: DesktopChatState | null;
  desktopBridgeState: DesktopBridgeState | null;
  canonicalSessionState: CanonicalSessionState | null;
  hiddenSessionIds: Set<string>;
  projectWorkspaces: Project[];
  projectSelectedSessionIds: Record<string, string>;
  activeNav: 'chats' | 'contacts' | 'projects' | 'agents' | 'bridge' | 'settings';
  activeConvId: string;
  activeProjectId: string;
  activeProjectSessionId: string;
  chatFilter: 'all' | 'people' | 'agents' | 'delegated';
  chatSearch: string;
  projectSearch: string;
  contactSearch: string;
  activeContactId: string;
  activeAgentId: string;
  cachedChatSessionMessages: Record<string, Message[]>;
  cachedProjectSessionMessages: Record<string, Message[]>;
  localSessionUnreadCounts: Record<string, number>;
  desktopLiveTurnsBySession: Record<string, DesktopChatTurnSnapshot>;
  mapDesktopMessages: (sessionId: string, messages: DesktopChatMessage[]) => Message[];
};

export function useWorkspaceViewModels({
  isNativeShell,
  isDesktopChatLoading,
  desktopChatState,
  desktopBridgeState,
  canonicalSessionState,
  hiddenSessionIds,
  projectWorkspaces,
  projectSelectedSessionIds,
  activeNav,
  activeConvId,
  activeProjectId,
  activeProjectSessionId,
  chatFilter,
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
}: UseWorkspaceViewModelsArgs) {
  const canonicalReadModel = useMemo(() => createCanonicalSessionReadModel(canonicalSessionState), [canonicalSessionState]);
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
      && !isLocalDraftChatConversationId(desktopChatState.activeSession.id)
      && !desktopChatState.sessions.some((session) => session.id === desktopChatState.activeSession.id)
      ? {
          id: desktopChatState.activeSession.id,
          title: desktopChatState.activeSession.title || 'New session',
          subtitle: desktopChatState.activeSession.subtitle,
          updatedAtLabel: desktopChatState.activeSession.updatedAtLabel,
          messageCount: desktopChatState.activeSession.messageCount,
          draft: desktopChatState.activeSession.draft,
        }
      : null;
    const sessionSummaries = activeSessionSummary
      ? [activeSessionSummary, ...desktopChatState.sessions]
      : desktopChatState.sessions;

    return sessionSummaries.map((session) => {
      const isActiveSession = session.id === desktopChatState.activeSession.id;
      const isVisibleSession = activeNav === 'chats' && activeConvId === session.id;
      const activeMessages = isActiveSession
        ? preferLatestMessages(
            mapDesktopMessages(desktopChatState.activeSession.id, desktopChatState.activeSession.messages),
            cachedChatSessionMessages[session.id],
            Boolean(desktopLiveTurnsForViewModel[session.id]),
          )
        : cachedChatSessionMessages[session.id] ?? [{ role: 'system' as const, text: session.draft ? 'Draft session' : 'Session ready', time: session.updatedAtLabel }];
      const unreadCount = isVisibleSession ? 0 : (localSessionUnreadCounts[session.id] ?? 0);
      const statusIndicator = buildSessionStatusIndicator({
        unreadCount,
        showBackgroundActivity: !isVisibleSession,
        liveTurn: desktopLiveTurnsForViewModel[session.id],
      });

      const outreachRecords = outreachThreadsByParentSession.get(session.id) ?? [];
      const outreachThreads = outreachRecords.map(({ updatedAtMs: _updatedAtMs, inlineMessages: _inlineMessages, ...thread }) => thread);
      const messages = [...activeMessages, ...outreachRecords.flatMap((thread) => thread.inlineMessages)];

      return {
        id: session.id,
        canonicalSessionId: session.id,
        name: session.title,
        type: 'owned-agent' as const,
        subtitle: buildConversationPreview(messages, session.subtitle),
        unread: unreadCount,
        bridges: ['Local'],
        trust: 'Owned',
        directness: session.draft ? 'Draft session' : 'Direct chat',
        participants: ['Me', 'Kordi'],
        participantAvatarSeeds: {
          Me: localHumanAvatarSeed,
          You: localHumanAvatarSeed,
          [localAgentLabel]: localAgentAvatarSeed,
          Kordi: localAgentAvatarSeed,
        },
        messages,
        updatedAtLabel: session.updatedAtLabel,
        statusIndicator,
        bridgeTarget: undefined,
        avatarSeed: localAgentAvatarSeed,
        outreachThreads,
        _updatedAtMs: undefined as number | undefined,
      };
    });
  }, [activeConvId, activeNav, cachedChatSessionMessages, canonicalSessionState, desktopBridgeState, desktopChatState, desktopLiveTurnsForViewModel, isNativeShell, localSessionUnreadCounts, mapDesktopMessages, outreachThreadsByParentSession]);

  const bridgeChatConversations = useMemo(() => {
    if (!isNativeShell) return [];
    const hostById = new Map((desktopBridgeState?.hosts ?? []).map((host) => [host.id, host]));
    const localAgentLabel = desktopChatState?.localAgent?.label || 'My agent';
    return (desktopBridgeState?.conversations ?? [])
      .filter(bridgeChatConversationIsVisible)
      .map((conversation) => (
        mapBridgeConversationToViewModel(conversation, hostById.get(conversation.hostId), localAgentLabel)
      ));
  }, [desktopBridgeState, desktopChatState?.localAgent?.label, isNativeShell]);

  const chatConversations = useMemo(() => {
    if (!isNativeShell) {
      return conversations;
    }
    const merged = [...bridgeChatConversations, ...localChatConversations];
    merged.sort((a, b) => (b._updatedAtMs ?? 0) - (a._updatedAtMs ?? 0));
    const sourceConversations = merged.map(({ _updatedAtMs, ...conversation }) => conversation);
    const hydratedConversations = canonicalReadModel
      ? canonicalReadModel.buildChatConversations(sourceConversations, buildConversationPreview)
      : sourceConversations;

    const visibleConversations = hiddenSessionIds.size === 0
      ? hydratedConversations
      : hydratedConversations.filter((conversation) => !hiddenSessionIds.has(conversation.canonicalSessionId ?? conversation.id));
    return hideRawConversationIds(visibleConversations);
  }, [bridgeChatConversations, canonicalReadModel, hiddenSessionIds, isNativeShell, localChatConversations]);

  const nativeChatPlaceholder = useMemo(
    () => ({
      id: LOCAL_DRAFT_CHAT_CONVERSATION_ID,
      canonicalSessionId: undefined,
      name: 'New session',
      type: 'owned-agent' as const,
      subtitle: isDesktopChatLoading
        ? 'Opening my local chat history…'
        : 'Blank drafts stay local until the first real send.',
      unread: 0,
      bridges: ['Local'],
      trust: 'Owned',
      directness: 'Direct chat',
      participants: ['Me', 'Kordi'],
      bridgeTarget: undefined,
      messages: [{
        role: 'system' as const,
        text: isDesktopChatLoading
          ? 'Opening my local chat history…'
          : 'Type a message to start a new chat. Blank drafts disappear until you send something.',
        time: '--:--',
      }],
    }),
    [isDesktopChatLoading],
  );

  const activeConv = useMemo(() => {
    if (isNativeShell && isLocalDraftChatConversationId(activeConvId)) {
      return nativeChatPlaceholder;
    }
    return chatConversations.find((conversation) => conversation.id === activeConvId) ?? chatConversations[0] ?? (isNativeShell ? nativeChatPlaceholder : conversations[0]);
  }, [activeConvId, chatConversations, isNativeShell, nativeChatPlaceholder]);
  const activeConversationIsBridge = isNativeShell && (
    activeConv.id.startsWith('bridge:')
    || isCanonicalBridgeSessionId(activeConv.canonicalSessionId ?? activeConv.id)
    || Boolean(activeConv.bridgeTarget)
  );
  const activeLastMessage = activeConv.messages[activeConv.messages.length - 1];
  const activeConvHasSubtitle = activeConv.subtitle.trim().length > 0;

  const filteredConversations = useMemo(() => {
    const normalizedSearch = chatSearch.trim().toLowerCase();

    return chatConversations.filter((conversation) => {
      const matchesFilter =
        chatFilter === 'all'
          ? true
          : chatFilter === 'people'
            ? conversation.type === 'person'
            : chatFilter === 'agents'
              ? conversation.type !== 'person'
              : conversation.directness !== 'Direct chat';

      const matchesSearch =
        normalizedSearch.length === 0
          ? true
          : [conversation.name, conversation.subtitle, conversation.participants.join(' '), conversation.messages[conversation.messages.length - 1]?.text]
              .filter(Boolean)
              .some((value) => value.toLowerCase().includes(normalizedSearch));

      return matchesFilter && matchesSearch;
    });
  }, [chatConversations, chatFilter, chatSearch]);

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
        const isAgent = isBridgeAgentRuntime(peer.runtime);
        const id = isAgent
          ? `bridge-peer-agent:${peer.nodeId}:${peer.agentId ?? peer.runtime}`
          : `bridge-peer-person:${peer.nodeId}:${peer.humanId ?? 'person'}`;
        const existing = byId.get(id);
        const nextBridges = Array.from(new Set([...(existing?.bridges ?? []), label])).sort();
        byId.set(id, {
          id,
          name: peer.displayName || peer.ownerName || peer.nodeId,
          initials: getInitials(peer.displayName || peer.ownerName || peer.nodeId),
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
          avatarSeed: isAgent ? (peer.agentId || peer.nodeId) : (peer.humanId || peer.ownerName || peer.nodeId),
        });

        if (isAgent && peer.ownerName) {
          const personId = `bridge-peer-person:${peer.nodeId}:${peer.humanId ?? peer.ownerName}`;
          const existingPerson = byId.get(personId);
          const personBridges = Array.from(new Set([...(existingPerson?.bridges ?? []), label])).sort();
          byId.set(personId, {
            id: personId,
            name: peer.ownerName,
            initials: getInitials(peer.ownerName),
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
            avatarSeed: peer.humanId || peer.ownerName || peer.nodeId,
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
        items.push({
          name: agent.label,
          id: agent.id,
          role: 'My agent',
          messaging: 'Direct local chat',
          status: agent.isActive ? 'Active' : agent.isDefault ? 'Default' : agent.registered ? 'Registered' : 'Local only',
          tasks: 0,
          defaultProvider: runtimeAgent?.defaultProvider ?? host.ownerName,
          defaultModel: runtimeAgent?.defaultModel ?? agent.runtime,
          bridgesConfig: hostLabel,
          contactId: `bridge-agent:${host.id}:${agent.id}`,
          systemPrompt: runtimeAgent?.systemPrompt ?? '',
          xMd: runtimeAgent?.workspaceRoot ?? [host.serverUrl, agent.nodeId || 'Pending node'].filter(Boolean).join(' • '),
          identityFiles: runtimeAgent?.identityFiles ?? [],
          loadedTools: runtimeAgent?.loadedTools ?? [],
          loadedSkills: runtimeAgent?.loadedSkills ?? [],
          loadedPlugins: runtimeAgent?.loadedPlugins ?? [],
          lastActivities: runtimeAgent
            ? runtimeAgent.lastActivities
            : [
                `Human ID: ${host.humanId}`,
                `Node ID: ${agent.nodeId || 'Pending registration'}`,
                `Discovery: ${host.discoveryMode}`,
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
        });
      }
    }

    if (items.length === 0 && localAgent) {
      items.push({
        name: localAgent.label,
        id: 'desktop:local-agent',
        role: 'Local desktop agent',
        messaging: 'Local runtime',
        status: 'Active',
        tasks: 0,
        defaultProvider: localAgent.defaultProvider,
        defaultModel: localAgent.defaultModel,
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

    return items;
  }, [desktopBridgeState?.hosts, desktopChatState?.localAgent, isNativeShell]);

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
        tasks: workspaceProject?.tasks ?? 0,
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
                  mapDesktopMessages(sessionId, desktopChatState.activeSession.messages),
                  cachedProjectSessionMessages[sessionId],
                  Boolean(desktopLiveTurnsForViewModel[sessionId]),
                )
              : cachedProjectSessionMessages[sessionId]
                ?? (desktopSession
                  ? [{ role: 'system' as const, text: desktopSession.draft ? 'Draft session' : 'Session ready', time: desktopSession.updatedAtLabel }]
                  : []);
          const outreachMessages = (outreachThreadsByParentSession.get(sessionId) ?? []).flatMap((thread) => thread.inlineMessages);
          const legacyMessages = [...baseMessages, ...outreachMessages];
          const messages = canonicalReadModel ? canonicalReadModel.preferMessages(sessionId, legacyMessages) : legacyMessages;
          const participants = canonicalReadModel ? canonicalReadModel.participantNames(sessionId, ['Me', 'Kordi']) : ['Me', 'Kordi'];

          const isVisibleSession = activeNav === 'projects' && activeProjectId === group.id && activeProjectSessionId === sessionId;
          const unreadCount = isVisibleSession ? 0 : (localSessionUnreadCounts[sessionId] ?? 0);

          return {
            id: sessionId,
            name: canonicalReadModel?.sessionTitle(sessionId, desktopSession?.title ?? canonicalSession?.title ?? 'Project session') ?? desktopSession?.title ?? canonicalSession?.title ?? 'Project session',
            summary: buildConversationPreview(messages, desktopSession?.subtitle ?? canonicalSession?.title),
            lastActive: desktopSession?.updatedAtLabel ?? messages[messages.length - 1]?.time ?? '--:--',
            status: desktopSession?.draft || canonicalSession?.status === 'draft' ? 'Draft' : 'Active',
            participants,
            artifacts: sharedSources.length,
            tasks: workspaceProject?.tasks ?? 0,
            unread: unreadCount,
            statusIndicator: buildSessionStatusIndicator({
              unreadCount,
              showBackgroundActivity: !isVisibleSession,
              liveTurn: desktopLiveTurnsForViewModel[sessionId],
            }),
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
      participants: ['Me', 'Kordi'],
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
    participants: ['Me', 'Kordi'],
    artifacts: activeProject.artifacts,
    tasks: activeProject.tasks,
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
    () => (activeBridgeHost?.visiblePeers ?? []).filter((peer) => isBridgeAgentRuntime(peer.runtime)),
    [activeBridgeHost],
  );
  const activeBridgeAwaitingReply = activeBridgeConversation?.awaitingReply ?? false;

  return {
    chatConversations,
    filteredConversations,
    activeConv,
    activeConversationIsBridge,
    activeLastMessage,
    activeConvHasSubtitle,
    displayedContacts,
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
