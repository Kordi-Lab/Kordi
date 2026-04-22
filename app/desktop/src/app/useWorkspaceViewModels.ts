import { useMemo } from 'react';

import { agents, contactGroups, contacts, conversations } from '@/kordi-app/data';
import type {
  Agent,
  Contact,
  DesktopBridgeHost,
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

type UseWorkspaceViewModelsArgs = {
  isNativeShell: boolean;
  isDesktopChatLoading: boolean;
  desktopChatState: DesktopChatState | null;
  desktopBridgeState: DesktopBridgeState | null;
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

export function isBridgeAgentRuntime(runtime: string) {
  const value = runtime.trim().toLowerCase();
  return value.includes('agent')
    || value.includes('claude')
    || value.includes('codex')
    || value.includes('openclaw')
    || value.includes('pi')
    || value.includes('bb')
    || value.includes('generic')
    || value.includes('bot');
}

function normalizeBridgeProjectKey(value?: string | null) {
  return (value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function truncateInlineText(value: string, maxChars = 96) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function buildConversationPreview(messages: Message[], fallback?: string) {
  const latestMessage = [...messages]
    .reverse()
    .find((message) => message.role !== 'system' && message.text.trim().length > 0);

  if (latestMessage) {
    return truncateInlineText(latestMessage.text);
  }

  return truncateInlineText(fallback ?? '', 72);
}

function buildSessionStatusIndicator({
  unreadCount,
  showBackgroundActivity,
  liveTurn,
}: {
  unreadCount: number;
  showBackgroundActivity: boolean;
  liveTurn?: DesktopChatTurnSnapshot;
}): SessionStatusIndicator | undefined {
  if (showBackgroundActivity && liveTurn && !liveTurn.completed) {
    if (liveTurn.status === 'cancelling') {
      return { label: 'Stopping', tone: 'stopped', live: true };
    }

    return { label: 'Running', tone: 'running', live: true };
  }

  if (unreadCount > 0) {
    return { label: 'Unread', tone: 'ready' };
  }

  return undefined;
}

export function findBridgeProjectForWorkspace(host: DesktopBridgeHost | null | undefined, projectName?: string | null, projectRoot?: string | null) {
  if (!host) return null;
  const rootLeaf = (projectRoot ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
  const candidates = new Set([
    normalizeBridgeProjectKey(projectName),
    normalizeBridgeProjectKey(rootLeaf),
  ].filter(Boolean));
  return host.projects.find((project) => candidates.has(normalizeBridgeProjectKey(project.name))) ?? null;
}

export function useWorkspaceViewModels({
  isNativeShell,
  isDesktopChatLoading,
  desktopChatState,
  desktopBridgeState,
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
  const localChatConversations = useMemo(() => {
    if (!isNativeShell || !desktopChatState?.activeSession) {
      return [];
    }

    return desktopChatState.sessions.map((session) => {
      const isActiveSession = session.id === desktopChatState.activeSession.id;
      const isVisibleSession = activeNav === 'chats' && activeConvId === session.id;
      const activeMessages = isActiveSession
        ? mapDesktopMessages(desktopChatState.activeSession.id, desktopChatState.activeSession.messages)
        : cachedChatSessionMessages[session.id] ?? [{ role: 'system' as const, text: session.draft ? 'Draft session' : 'Session ready', time: session.updatedAtLabel }];
      const unreadCount = isVisibleSession ? 0 : (localSessionUnreadCounts[session.id] ?? 0);
      const statusIndicator = buildSessionStatusIndicator({
        unreadCount,
        showBackgroundActivity: !isVisibleSession,
        liveTurn: desktopLiveTurnsBySession[session.id],
      });

      return {
        id: session.id,
        name: session.title,
        type: 'owned-agent' as const,
        subtitle: buildConversationPreview(activeMessages),
        unread: unreadCount,
        bridges: ['Local'],
        trust: 'Owned',
        directness: session.draft ? 'Draft session' : 'Direct chat',
        participants: ['You', 'Kordi'],
        messages: activeMessages,
        updatedAtLabel: session.updatedAtLabel,
        statusIndicator,
        _updatedAtMs: undefined as number | undefined,
      };
    });
  }, [activeConvId, activeNav, cachedChatSessionMessages, desktopChatState, desktopLiveTurnsBySession, isNativeShell, localSessionUnreadCounts, mapDesktopMessages]);

  const bridgeChatConversations = useMemo(() => {
    if (!isNativeShell) return [];
    const hostById = new Map((desktopBridgeState?.hosts ?? []).map((host) => [host.id, host]));
    return (desktopBridgeState?.conversations ?? []).map((conversation) => {
      const host = hostById.get(conversation.hostId);
      const hostLabel = host?.serverUrl?.replace(/^https?:\/\//, '') || 'Bridge';
      const isAgent = isBridgeAgentRuntime(conversation.peerRuntime);
      const mappedMessages = conversation.messages.map((message) => ({
        role: (message.direction === 'outbound'
          ? 'user'
          : isAgent
            ? 'external-agent'
            : 'person') as Message['role'],
        sender: message.sender ?? (message.direction === 'outbound' ? 'You' : conversation.title),
        text: message.text,
        time: message.timeLabel,
        statusChips: message.direction === 'outbound'
          ? [message.deliveryState || (conversation.awaitingReply ? 'awaiting reply' : 'sent')].filter(Boolean)
          : conversation.peerTyping && message === conversation.messages[conversation.messages.length - 1]
            ? ['typing']
            : [],
        detail: message.direction === 'outbound' && message.deliveryState === 'responded' ? 'Peer replied' : undefined,
      }));

      return {
        id: conversation.id,
        name: conversation.title,
        type: (isAgent ? 'external-agent' : 'person') as const,
        subtitle: buildConversationPreview(mappedMessages, conversation.subtitle),
        unread: conversation.unreadCount,
        bridges: conversation.projectName ? [hostLabel, conversation.projectName] : [hostLabel],
        trust: 'Bridge',
        directness: 'Bridge chat',
        participants: ['You', conversation.title],
        updatedAtLabel: conversation.updatedAtLabel,
        messages: mappedMessages,
        _updatedAtMs: conversation.updatedAtMs,
      };
    });
  }, [desktopBridgeState, isNativeShell]);

  const chatConversations = useMemo(() => {
    if (!isNativeShell) {
      return conversations;
    }
    const merged = [...bridgeChatConversations, ...localChatConversations];
    merged.sort((a, b) => (b._updatedAtMs ?? 0) - (a._updatedAtMs ?? 0));
    return merged.map(({ _updatedAtMs, ...conversation }) => conversation);
  }, [bridgeChatConversations, isNativeShell, localChatConversations]);

  const nativeChatPlaceholder = useMemo(
    () => ({
      id: 'loading-chat-session',
      name: isDesktopChatLoading ? 'Loading chat session' : 'Chat session',
      type: 'owned-agent' as const,
      subtitle: isDesktopChatLoading ? 'Loading your real local session history…' : 'Real chat session state is unavailable.',
      unread: 0,
      bridges: ['Local'],
      trust: 'Owned',
      directness: 'Direct chat',
      participants: ['You', 'Kordi'],
      messages: [{ role: 'system' as const, text: isDesktopChatLoading ? 'Loading real chat session…' : 'No real chat session is loaded.', time: '--:--' }],
    }),
    [isDesktopChatLoading],
  );

  const activeConv = useMemo(
    () => chatConversations.find((conversation) => conversation.id === activeConvId) ?? chatConversations[0] ?? (isNativeShell ? nativeChatPlaceholder : conversations[0]),
    [activeConvId, chatConversations, isNativeShell, nativeChatPlaceholder],
  );
  const activeConversationIsBridge = isNativeShell && activeConv.id.startsWith('bridge:');
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

    for (const host of desktopBridgeState?.hosts ?? []) {
      const label = bridgeLabel(host.serverUrl);
      byId.set(`bridge-self:${host.id}`, {
        id: `bridge-self:${host.id}`,
        name: host.displayName,
        initials: getInitials(host.displayName),
        classType: 'my-agents',
        entityType: 'Owned bridge node',
        subtitle: label,
        bridges: [label],
        status: host.connected ? 'Owned' : 'Offline',
        discoverableOn: [label],
        detail: `${host.nodeId ?? 'Pending node'} • ${host.connected ? 'connected' : 'offline'} • ${host.visiblePeerCount} visible peer${host.visiblePeerCount === 1 ? '' : 's'}`,
        owner: 'You',
        bridgeHostId: host.id,
        bridgePeerNodeId: host.nodeId ?? undefined,
        bridgePeerRuntime: 'kordi-desktop',
      });

      for (const peer of host.visiblePeers) {
        const id = `bridge-peer:${peer.nodeId}`;
        const isAgent = isBridgeAgentRuntime(peer.runtime);
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
        });
      }
    }

    return Array.from(byId.values());
  }, [desktopBridgeState?.hosts, isNativeShell]);

  const displayedAgents = useMemo<Agent[]>(() => {
    if (!isNativeShell) return agents;
    return displayedContacts
      .filter((contact) => contact.classType === 'my-agents' || contact.classType === 'other-users-agents')
      .map((contact) => ({
        name: contact.name,
        id: contact.bridgePeerNodeId || contact.id,
        role: contact.classType === 'my-agents' ? 'Owned bridge identity' : 'External bridge agent',
        messaging: 'Bridge mailbox relay',
        status: contact.status,
        tasks: 0,
        defaultProvider: 'Bridge',
        defaultModel: contact.bridgePeerRuntime || 'bridge-node',
        bridgesConfig: contact.bridges.join(' • '),
        contactId: contact.id,
        systemPrompt: 'Bridge-discovered agent or owned bridge node identity.',
        xMd: contact.detail,
        lastActivities: [
          `Discoverable on ${contact.discoverableOn.join(' • ') || 'this bridge'}`,
          `Owner: ${contact.owner}`,
          `Runtime: ${contact.bridgePeerRuntime || 'bridge-node'}`,
        ],
        bridgeHostId: contact.bridgeHostId,
        bridgePeerNodeId: contact.bridgePeerNodeId,
        bridgePeerRuntime: contact.bridgePeerRuntime,
      }));
  }, [displayedContacts, isNativeShell]);

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
  const activeAgent = displayedAgents.find((agent) => agent.id === activeAgentId) ?? displayedAgents[0] ?? agents[0];

  const runtimeProjects = useMemo(() => {
    if (!isNativeShell || !desktopChatState?.projects?.length) {
      return projectWorkspaces;
    }

    return desktopChatState.projects.map((project) => ({
      id: project.id,
      name: project.name,
      summary: project.summary,
      bridge: 'Local',
      scope: project.root,
      status: project.backgroundSystem ? 'Configured' : 'Local',
      people: [],
      agents: [],
      pendingInvites: [],
      artifacts: project.sharedSources.length,
      tasks: 0,
      root: project.root,
      sharedContext: project.summary,
      backgroundSystem: project.backgroundSystem ?? undefined,
      sharedSources: project.sharedSources,
      sessions: project.sessions.map((session) => {
        const messages =
          desktopChatState.activeSessionId === session.id
            ? mapDesktopMessages(session.id, desktopChatState.activeSession.messages)
            : cachedProjectSessionMessages[session.id] ?? [{ role: 'system' as const, text: session.draft ? 'Draft session' : 'Session ready', time: session.updatedAtLabel }];

        const isVisibleSession = activeNav === 'projects' && activeProjectId === project.id && activeProjectSessionId === session.id;
        const unreadCount = isVisibleSession ? 0 : (localSessionUnreadCounts[session.id] ?? 0);

        return {
          id: session.id,
          name: session.title,
          summary: buildConversationPreview(messages),
          lastActive: session.updatedAtLabel,
          status: session.draft ? 'Draft' : 'Active',
          participants: ['You', 'Kordi'],
          artifacts: project.sharedSources.length,
          tasks: 0,
          unread: unreadCount,
          statusIndicator: buildSessionStatusIndicator({
            unreadCount,
            showBackgroundActivity: !isVisibleSession,
            liveTurn: desktopLiveTurnsBySession[session.id],
          }),
          messages,
        };
      }),
    }));
  }, [activeNav, activeProjectId, activeProjectSessionId, cachedProjectSessionMessages, desktopChatState, desktopLiveTurnsBySession, isNativeShell, localSessionUnreadCounts, mapDesktopMessages, projectWorkspaces]);

  const filteredProjects = useMemo(() => {
    const normalizedSearch = projectSearch.trim().toLowerCase();

    return runtimeProjects.filter((project) => {
      if (normalizedSearch.length === 0) return true;

      return [project.name, project.summary, project.scope, ...project.sessions.map((session) => session.name)]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(normalizedSearch));
    });
  }, [projectSearch, runtimeProjects]);

  const fallbackProject = runtimeProjects[0] ?? projectWorkspaces[0];
  const activeProject = runtimeProjects.find((project) => project.id === activeProjectId) ?? fallbackProject;
  const rememberedActiveProjectSessionId = projectSelectedSessionIds[activeProject?.id ?? ''];
  const activeProjectSession = activeProject.sessions.find((session) => session.id === activeProjectSessionId)
    ?? activeProject.sessions.find((session) => session.id === rememberedActiveProjectSessionId)
    ?? activeProject.sessions[0];
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
    () => (activeBridgeHost?.visiblePeers ?? []).filter((peer) => !isBridgeAgentRuntime(peer.runtime)),
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
