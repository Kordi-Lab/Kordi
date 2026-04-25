import { useMemo } from 'react';

import { mapBridgeConversationToViewModel } from '@/features/bridge/transcript';
import { isBridgeAgentRuntime } from '@/features/bridge/runtime';
import { createCanonicalSessionReadModel } from '@/features/canonical/sessionReadModel';
import { LOCAL_DRAFT_CHAT_CONVERSATION_ID, isLocalDraftChatConversationId } from '@/features/chat/draftSessions';
import { contactGroups, contacts, conversations } from '@/kordi-app/data';
import type {
  Agent,
  CanonicalSessionState,
  Contact,
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

type UseWorkspaceViewModelsArgs = {
  isNativeShell: boolean;
  isDesktopChatLoading: boolean;
  desktopChatState: DesktopChatState | null;
  desktopBridgeState: DesktopBridgeState | null;
  canonicalSessionState: CanonicalSessionState | null;
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

function canExposeBridgePerson(peer: DesktopBridgePeer) {
  return Boolean(
    isBridgeAgentRuntime(peer.runtime)
      && peer.isDefaultAgent
      && peer.ownerName?.trim()
      && peer.humanId?.trim(),
  );
}

function toBridgePersonPeer(peer: DesktopBridgePeer): DesktopBridgePeer {
  return {
    ...peer,
    displayName: peer.ownerName?.trim() || peer.displayName,
    runtime: 'person',
    agentId: undefined,
    isDefaultAgent: false,
  };
}

function visibleBridgePeople(peers: DesktopBridgePeer[]) {
  const people: DesktopBridgePeer[] = [];
  const seen = new Set<string>();

  for (const peer of peers) {
    if (!isBridgeAgentRuntime(peer.runtime)) {
      if (seen.has(peer.nodeId)) continue;
      seen.add(peer.nodeId);
      people.push(peer);
      continue;
    }

    if (!canExposeBridgePerson(peer)) continue;

    const key = peer.humanId?.trim() || peer.ownerName?.trim() || peer.nodeId;
    if (seen.has(key)) continue;
    seen.add(key);
    people.push(toBridgePersonPeer(peer));
  }

  return people;
}

function normalizeBridgeProjectKey(value?: string | null) {
  return (value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function truncateInlineText(value: string, maxChars = 96) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function buildMessagePreview(message: Message) {
  const text = message.text.trim();
  if (text.length > 0) {
    return text;
  }

  const attachments = message.attachments ?? [];
  if (attachments.length === 0) {
    return '';
  }

  if (attachments.length === 1) {
    return `Attached ${attachments[0].name}`;
  }

  return `${attachments.length} attachments`;
}

function inlineRequestPreview(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > 140 ? `${normalized.slice(0, 137)}…` : normalized;
}

function buildOutreachInlineMessages(conversation: DesktopBridgeConversation): Message[] {
  const outreach = conversation.outreach;
  if (!outreach) return [];

  const isAgent = outreach.targetKind === 'bridge-agent';
  const targetName = outreach.targetDisplayName || conversation.title;
  const avatarSeed = isAgent
    ? outreach.targetAgentId || outreach.targetNodeId
    : outreach.targetHumanId || outreach.targetOwnerName || outreach.targetNodeId;
  const requestPreview = inlineRequestPreview(outreach.requestText);
  const joinText = isAgent ? `${targetName} joined through @` : `${targetName} was involved through @`;
  const messages: Message[] = [{
    role: 'system',
    text: requestPreview ? `${joinText} — “${requestPreview}”` : joinText,
    time: conversation.updatedAtLabel,
  }];

  for (const message of conversation.messages) {
    if (message.direction !== 'inbound' && message.direction !== 'inbound-response') continue;
    const isProcessingAgent = isAgent && message.deliveryState === 'processing';
    const agentTurn = isAgent
      ? {
          id: `bridge-outreach-live-turn:${conversation.id}:${message.id}`,
          sessionId: outreach.parentSessionId ?? conversation.canonicalSessionId,
          prompt: outreach.requestText,
          status: isProcessingAgent ? (message.text.trim() ? 'writing' : 'typing') : 'complete',
          message: isProcessingAgent ? (message.text.trim() ? 'Replying…' : 'Typing…') : 'Complete',
          assistantText: message.text,
          thinkingText: '',
          tools: [],
          completed: !isProcessingAgent,
          succeeded: !isProcessingAgent,
          error: null,
        }
      : undefined;
    messages.push({
      role: isAgent ? 'external-agent' : 'person',
      sender: targetName,
      senderType: isAgent ? 'agent' : 'human',
      isOwnMessage: false,
      showSenderMeta: true,
      senderAvatarSeed: avatarSeed,
      text: isAgent ? '' : message.text,
      time: message.timeLabel,
      turn: agentTurn,
    });
  }

  return messages;
}

function buildConversationPreview(messages: Message[], fallback?: string) {
  const latestMessage = [...messages]
    .reverse()
    .find((message) => message.role !== 'system' && buildMessagePreview(message).trim().length > 0);

  if (latestMessage) {
    return truncateInlineText(buildMessagePreview(latestMessage));
  }

  return truncateInlineText(fallback ?? '', 72);
}

function preferLatestMessages(mappedMessages: Message[], cachedMessages: Message[] | undefined, preserveCachedMessages: boolean) {
  if (!cachedMessages || !preserveCachedMessages) return mappedMessages;
  return cachedMessages.length > mappedMessages.length ? cachedMessages : mappedMessages;
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
  canonicalSessionState,
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

    return desktopChatState.sessions.map((session) => {
      const isActiveSession = session.id === desktopChatState.activeSession.id;
      const isVisibleSession = activeNav === 'chats' && activeConvId === session.id;
      const activeMessages = isActiveSession
        ? preferLatestMessages(
            mapDesktopMessages(desktopChatState.activeSession.id, desktopChatState.activeSession.messages),
            cachedChatSessionMessages[session.id],
            Boolean(desktopLiveTurnsBySession[session.id] && !desktopLiveTurnsBySession[session.id].completed),
          )
        : cachedChatSessionMessages[session.id] ?? [{ role: 'system' as const, text: session.draft ? 'Draft session' : 'Session ready', time: session.updatedAtLabel }];
      const unreadCount = isVisibleSession ? 0 : (localSessionUnreadCounts[session.id] ?? 0);
      const statusIndicator = buildSessionStatusIndicator({
        unreadCount,
        showBackgroundActivity: !isVisibleSession,
        liveTurn: desktopLiveTurnsBySession[session.id],
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
        participants: ['You', 'Kordi'],
        messages,
        updatedAtLabel: session.updatedAtLabel,
        statusIndicator,
        bridgeTarget: undefined,
        outreachThreads,
        _updatedAtMs: undefined as number | undefined,
      };
    });
  }, [activeConvId, activeNav, cachedChatSessionMessages, desktopChatState, desktopLiveTurnsBySession, isNativeShell, localSessionUnreadCounts, mapDesktopMessages, outreachThreadsByParentSession]);

  const bridgeChatConversations = useMemo(() => {
    if (!isNativeShell) return [];
    const hostById = new Map((desktopBridgeState?.hosts ?? []).map((host) => [host.id, host]));
    const localAgentLabel = desktopChatState?.localAgent?.label || 'My agent';
    return (desktopBridgeState?.conversations ?? [])
      .filter((conversation) => !conversation.outreach?.parentSessionId || conversation.id === activeConvId)
      .map((conversation) => (
        mapBridgeConversationToViewModel(conversation, hostById.get(conversation.hostId), localAgentLabel)
      ));
  }, [activeConvId, desktopBridgeState, desktopChatState?.localAgent?.label, isNativeShell]);

  const chatConversations = useMemo(() => {
    if (!isNativeShell) {
      return conversations;
    }
    const merged = [...bridgeChatConversations, ...localChatConversations];
    merged.sort((a, b) => (b._updatedAtMs ?? 0) - (a._updatedAtMs ?? 0));
    const sourceConversations = merged.map(({ _updatedAtMs, ...conversation }) => conversation);
    return canonicalReadModel
      ? canonicalReadModel.buildChatConversations(sourceConversations, buildConversationPreview)
      : sourceConversations;
  }, [bridgeChatConversations, canonicalReadModel, isNativeShell, localChatConversations]);

  const nativeChatPlaceholder = useMemo(
    () => ({
      id: LOCAL_DRAFT_CHAT_CONVERSATION_ID,
      canonicalSessionId: undefined,
      name: 'New session',
      type: 'owned-agent' as const,
      subtitle: isDesktopChatLoading
        ? 'Opening your local chat history…'
        : 'Blank drafts stay local until the first real send.',
      unread: 0,
      bridges: ['Local'],
      trust: 'Owned',
      directness: 'Direct chat',
      participants: ['You', 'Kordi'],
      bridgeTarget: undefined,
      messages: [{
        role: 'system' as const,
        text: isDesktopChatLoading
          ? 'Opening your local chat history…'
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
    const localAgent = desktopChatState?.localAgent;

    for (const host of desktopBridgeState?.hosts ?? []) {
      const label = bridgeLabel(host.serverUrl);
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
        detail: `Chat directly with your local Kordi agent. Bridge host: ${label}${host.nodeId ? ` • ${host.nodeId}` : ''}`,
        owner: 'You',
        bridgeHostId: host.id,
        bridgePeerNodeId: host.nodeId ?? undefined,
        bridgePeerRuntime: 'kordi-desktop',
        bridgeHumanId: host.humanId,
        bridgeAgentId: host.activeAgentId ?? undefined,
        avatarSeed: host.activeAgentId || host.nodeId || host.id,
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
        detail: `Chat directly with your local Kordi agent • ${localAgent.workspaceRoot}`,
        owner: 'You',
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
        const baseMessages =
          desktopChatState.activeSessionId === session.id
            ? preferLatestMessages(
                mapDesktopMessages(session.id, desktopChatState.activeSession.messages),
                cachedProjectSessionMessages[session.id],
                Boolean(desktopLiveTurnsBySession[session.id] && !desktopLiveTurnsBySession[session.id].completed),
              )
            : cachedProjectSessionMessages[session.id] ?? [{ role: 'system' as const, text: session.draft ? 'Draft session' : 'Session ready', time: session.updatedAtLabel }];
        const outreachMessages = (outreachThreadsByParentSession.get(session.id) ?? []).flatMap((thread) => thread.inlineMessages);
        const legacyMessages = [...baseMessages, ...outreachMessages];
        const messages = canonicalReadModel ? canonicalReadModel.preferMessages(session.id, legacyMessages) : legacyMessages;
        const participants = canonicalReadModel ? canonicalReadModel.participantNames(session.id, ['You', 'Kordi']) : ['You', 'Kordi'];

        const isVisibleSession = activeNav === 'projects' && activeProjectId === project.id && activeProjectSessionId === session.id;
        const unreadCount = isVisibleSession ? 0 : (localSessionUnreadCounts[session.id] ?? 0);

        return {
          id: session.id,
          name: canonicalReadModel?.sessionTitle(session.id, session.title) ?? session.title,
          summary: buildConversationPreview(messages, session.subtitle),
          lastActive: session.updatedAtLabel,
          status: session.draft ? 'Draft' : 'Active',
          participants,
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
  }, [activeNav, activeProjectId, activeProjectSessionId, cachedProjectSessionMessages, canonicalReadModel, desktopChatState, desktopLiveTurnsBySession, isNativeShell, localSessionUnreadCounts, mapDesktopMessages, outreachThreadsByParentSession, projectWorkspaces]);

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
