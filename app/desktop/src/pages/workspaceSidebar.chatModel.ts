import { useCallback, useMemo, useState } from 'react';

import { buildForkLineage, isGroupForkSession } from '@/features/chat/forkLineage';
import { filterParticipantSpaces } from '@/features/chat/participantSpaces';
import type { ChatChannel } from '@/kordi-app/types';
import {
  buildChatSidebarRows,
  type ChatSidebarSessionInput,
} from '@/pages/sidebar/chatSidebarRows';
import { filterGroupForkSessionsFromSpaces, groupSpacePreferenceId, participantSpaceSessionPreferenceId } from '@/pages/workspaceSidebar.chatHelpers';
import type {
  WorkspaceSidebarChats,
  WorkspaceSidebarParticipantSpace as ParticipantSpaceItem,
} from '@/pages/workspaceSidebar.types';

export type CollaborationSyncStatus = 'idle' | 'syncing' | 'unavailable';

type WorkspaceChatSidebarModelOptions = {
  isCollaborationSyncUnavailable?: boolean;
};

const EMPTY_SESSION_IDS: ReadonlySet<string> = new Set();

function orderPinnedSessions(
  spaces: ParticipantSpaceItem[],
  pinnedSessionIds: ReadonlySet<string>,
  pinnedGroupSpaceIds: ReadonlySet<string>,
) {
  return spaces.map((space) => ({
    ...space,
    sessions: [...space.sessions].sort((left, right) => (
      Number(pinnedSessionIds.has(participantSpaceSessionPreferenceId(right)))
      - Number(pinnedSessionIds.has(participantSpaceSessionPreferenceId(left)))
      || right.updatedAtMs - left.updatedAtMs
    )),
  })).sort((left, right) => {
    const leftPinned = left.kind === 'group'
      ? pinnedGroupSpaceIds.has(groupSpacePreferenceId(left.id))
      : left.sessions.some((session) => pinnedSessionIds.has(participantSpaceSessionPreferenceId(session)));
    const rightPinned = right.kind === 'group'
      ? pinnedGroupSpaceIds.has(groupSpacePreferenceId(right.id))
      : right.sessions.some((session) => pinnedSessionIds.has(participantSpaceSessionPreferenceId(session)));
    return Number(rightPinned) - Number(leftPinned);
  });
}

export function participantSpaceExpanded(
  space: Pick<ParticipantSpaceItem, 'id' | 'kind'>,
  activeSpaceId: string | null,
  selectedSpaceId: string | null,
  collapsedSpaceIds: ReadonlySet<string>,
) {
  return space.kind !== 'direct-human'
    && !collapsedSpaceIds.has(space.id)
    && (selectedSpaceId === space.id || activeSpaceId === space.id);
}

export function useWorkspaceChatSidebarModel(
  chats: WorkspaceSidebarChats,
  options: WorkspaceChatSidebarModelOptions = {},
) {
  const {
    chatConversations,
    participantSpaces,
    archivedParticipantSpaces = [],
    contactParticipantSpaces,
    agentParticipantSpaces,
    pinnedSessionIds = EMPTY_SESSION_IDS,
    mutedSessionIds = EMPTY_SESSION_IDS,
    unreadSessionIds = EMPTY_SESSION_IDS,
    pinnedGroupSpaceIds = EMPTY_SESSION_IDS,
    chatSearch,
    initialSelectedParticipantSpaceId = null,
    initialChatChannel = 'contact',
    activeConvId,
    isCollaborationSyncing,
  } = chats;
  const [selectedParticipantSpaceId, setSelectedParticipantSpaceId] = useState<
    string | null
  >(initialSelectedParticipantSpaceId);
  const [collapsedParticipantSpaceIds, setCollapsedParticipantSpaceIds] = useState<Set<string>>(
    new Set(),
  );
  const [chatChannel, setChatChannel] = useState<ChatChannel>(initialChatChannel);
  const [collapsedForkParents, setCollapsedForkParents] = useState<Set<string>>(
    new Set(),
  );
  const [showArchived, setShowArchivedState] = useState(false);
  const [activeUnreadCounts, setActiveUnreadCounts] = useState({ contact: 0, agent: 0 });
  const orderedParticipantSpaces = useMemo(
    () => orderPinnedSessions(participantSpaces, pinnedSessionIds, pinnedGroupSpaceIds),
    [participantSpaces, pinnedGroupSpaceIds, pinnedSessionIds],
  );
  const orderedContactParticipantSpaces = useMemo(
    () => orderPinnedSessions(contactParticipantSpaces, pinnedSessionIds, pinnedGroupSpaceIds),
    [contactParticipantSpaces, pinnedGroupSpaceIds, pinnedSessionIds],
  );
  const orderedAgentParticipantSpaces = useMemo(
    () => orderPinnedSessions(agentParticipantSpaces, pinnedSessionIds, pinnedGroupSpaceIds),
    [agentParticipantSpaces, pinnedGroupSpaceIds, pinnedSessionIds],
  );
  const orderedArchivedSpaces = useMemo(
    () => orderPinnedSessions(archivedParticipantSpaces, pinnedSessionIds, pinnedGroupSpaceIds),
    [archivedParticipantSpaces, pinnedGroupSpaceIds, pinnedSessionIds],
  );
  const sourceParticipantSpaces = showArchived
    ? orderedArchivedSpaces
    : orderedParticipantSpaces;
  const sourceContactParticipantSpaces = showArchived
    ? filterParticipantSpaces(orderedArchivedSpaces, chatSearch, 'contact')
    : orderedContactParticipantSpaces;
  const sourceAgentParticipantSpaces = showArchived
    ? filterParticipantSpaces(orderedArchivedSpaces, chatSearch, 'agent')
    : orderedAgentParticipantSpaces;
  const visibleParticipantSpaces = useMemo(
    () => filterGroupForkSessionsFromSpaces(sourceParticipantSpaces),
    [sourceParticipantSpaces],
  );
  const visibleContactParticipantSpaces = useMemo(
    () => filterGroupForkSessionsFromSpaces(sourceContactParticipantSpaces),
    [sourceContactParticipantSpaces],
  );
  const visibleAgentParticipantSpaces = useMemo(
    () => filterGroupForkSessionsFromSpaces(sourceAgentParticipantSpaces),
    [sourceAgentParticipantSpaces],
  );
  const activeParticipantSpaceId =
    visibleParticipantSpaces.find((space) =>
      space.sessions.some(
        (session) =>
          session.id === activeConvId || session.canonicalSessionId === activeConvId,
      ),
    )?.id ?? null;
  const selectedParticipantSpace = selectedParticipantSpaceId
    ? (visibleParticipantSpaces.find(
      (space) => space.id === selectedParticipantSpaceId,
    ) ?? null)
    : null;
  const isParticipantSpaceExpanded = useCallback(
    (space: Pick<ParticipantSpaceItem, 'id' | 'kind'>) => participantSpaceExpanded(
      space,
      activeParticipantSpaceId,
      selectedParticipantSpaceId,
      collapsedParticipantSpaceIds,
    ),
    [activeParticipantSpaceId, collapsedParticipantSpaceIds, selectedParticipantSpaceId],
  );
  const setParticipantSpaceExpanded = useCallback((spaceId: string, expanded: boolean) => {
    setCollapsedParticipantSpaceIds((current) => {
      if (expanded === !current.has(spaceId)) return current;
      const next = new Set(current);
      if (expanded) next.delete(spaceId);
      else next.add(spaceId);
      return next;
    });
    setSelectedParticipantSpaceId((current) => (
      expanded ? spaceId : current === spaceId ? null : current
    ));
  }, []);

  const allSidebarSessions = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{
      session: ParticipantSpaceItem['sessions'][number];
      space: ParticipantSpaceItem;
    }> = [];
    for (const space of [
      ...visibleAgentParticipantSpaces,
      ...visibleContactParticipantSpaces,
      ...visibleParticipantSpaces,
    ]) {
      for (const session of space.sessions) {
        if (seen.has(session.id)) continue;
        seen.add(session.id);
        out.push({ session, space });
      }
    }
    return out;
  }, [
    visibleAgentParticipantSpaces,
    visibleContactParticipantSpaces,
    visibleParticipantSpaces,
  ]);
  const globalForkLineage = useMemo(
    () => buildForkLineage(allSidebarSessions.map(({ session }) => session)),
    [allSidebarSessions],
  );
  const allSidebarSessionRowsById = useMemo(
    () => new Map(allSidebarSessions.map((row) => [row.session.id, row])),
    [allSidebarSessions],
  );
  const activeSidebarSessionId = activeConvId.trim();
  const sidebarSessionIsActive = useCallback(
    (session?: ParticipantSpaceItem['sessions'][number]) =>
      Boolean(
        session
          && activeSidebarSessionId
          && (activeSidebarSessionId === session.id
            || activeSidebarSessionId === session.canonicalSessionId),
      ),
    [activeSidebarSessionId],
  );
  const unreadBySessionIdWithForkDescendants = useMemo(() => {
    const cache = new Map<string, number>();
    const visit = (sessionId: string, seen: Set<string>): number => {
      if (cache.has(sessionId)) return cache.get(sessionId) ?? 0;
      if (seen.has(sessionId)) return 0;
      const nextSeen = new Set(seen);
      nextSeen.add(sessionId);
      const rowSession = allSidebarSessionRowsById.get(sessionId)?.session;
      const ownUnread = sidebarSessionIsActive(rowSession)
        ? 0
        : Math.max(rowSession && unreadSessionIds.has(participantSpaceSessionPreferenceId(rowSession)) ? 1 : 0, rowSession?.unread ?? 0);
      const forkUnread = (
        globalForkLineage.forksByParentSessionId.get(sessionId) ?? []
      ).reduce((sum, fork) => sum + visit(fork.id, nextSeen), 0);
      const total = ownUnread + forkUnread;
      cache.set(sessionId, total);
      return total;
    };
    for (const sessionId of allSidebarSessionRowsById.keys()) {
      visit(sessionId, new Set());
    }
    return cache;
  }, [allSidebarSessionRowsById, globalForkLineage, sidebarSessionIsActive, unreadSessionIds]);
  const unreadByParticipantSpaceIdWithForkDescendants = useMemo(() => {
    const collect = (sessionId: string, target: Set<string>, seen: Set<string>) => {
      if (seen.has(sessionId)) return;
      seen.add(sessionId);
      target.add(sessionId);
      for (const fork of globalForkLineage.forksByParentSessionId.get(sessionId) ?? []) {
        collect(fork.id, target, seen);
      }
    };
    const unreadBySpaceId = new Map<string, number>();
    for (const space of visibleParticipantSpaces) {
      const sessionIds = new Set<string>();
      for (const session of space.sessions) {
        collect(session.id, sessionIds, new Set());
      }
      const unread = [...sessionIds].reduce((sum, sessionId) => {
        const rowSession = allSidebarSessionRowsById.get(sessionId)?.session;
        return (
          sum
          + (sidebarSessionIsActive(rowSession)
            ? 0
            : Math.max(rowSession && unreadSessionIds.has(participantSpaceSessionPreferenceId(rowSession)) ? 1 : 0, rowSession?.unread ?? 0))
        );
      }, 0);
      unreadBySpaceId.set(space.id, unread);
    }
    return unreadBySpaceId;
  }, [
    allSidebarSessionRowsById,
    globalForkLineage,
    visibleParticipantSpaces,
    sidebarSessionIsActive,
    unreadSessionIds,
  ]);
  const currentContactUnread = visibleContactParticipantSpaces.reduce(
    (sum, space) =>
      sum
      + (space.sessions.every((session) => mutedSessionIds.has(participantSpaceSessionPreferenceId(session)))
        ? 0
        : Math.max(
          0,
          unreadByParticipantSpaceIdWithForkDescendants.get(space.id) ?? space.unread,
        )),
    0,
  );
  const flatAgentSessions = useMemo(
    () =>
      visibleAgentParticipantSpaces
        .flatMap((space) =>
          space.sessions.map((session) => ({ session, space })),
        )
        .sort(
          (left, right) =>
            Number(pinnedSessionIds.has(participantSpaceSessionPreferenceId(right.session)))
              - Number(pinnedSessionIds.has(participantSpaceSessionPreferenceId(left.session)))
            || right.session.updatedAtMs - left.session.updatedAtMs
            || left.session.title.localeCompare(right.session.title),
        ),
    [pinnedSessionIds, visibleAgentParticipantSpaces],
  );
  const agentForkLineage = useMemo(
    () => buildForkLineage(flatAgentSessions.map(({ session }) => session)),
    [flatAgentSessions],
  );
  const topLevelAgentSessions = useMemo(
    () =>
      flatAgentSessions.filter(({ session }) => {
        if (agentForkLineage.forkSessionIds.has(session.id)) return false;
        const parent = session.forkedFromSessionId?.trim();
        return !(parent && parent.startsWith('session:'));
      }),
    [agentForkLineage, flatAgentSessions],
  );
  const agentSessionRowsById = useMemo(
    () => new Map(flatAgentSessions.map((row) => [row.session.id, row])),
    [flatAgentSessions],
  );
  const renderableAgentSessionIds = useMemo(() => {
    const ids = new Set<string>();
    const visit = (sessionId: string) => {
      if (ids.has(sessionId)) return;
      ids.add(sessionId);
      for (const fork of agentForkLineage.forksByParentSessionId.get(sessionId) ?? []) {
        visit(fork.id);
      }
    };
    for (const { session } of topLevelAgentSessions) visit(session.id);
    return ids;
  }, [agentForkLineage, topLevelAgentSessions]);
  const currentAgentUnread = flatAgentSessions.reduce(
    (sum, { session }) =>
      renderableAgentSessionIds.has(session.id)
        ? sum + (mutedSessionIds.has(participantSpaceSessionPreferenceId(session))
          ? 0
          : Math.max(unreadSessionIds.has(participantSpaceSessionPreferenceId(session)) ? 1 : 0, session.unread))
        : sum,
    0,
  );
  const setShowArchived = useCallback((next: boolean) => {
    if (next) {
      setActiveUnreadCounts({ contact: currentContactUnread, agent: currentAgentUnread });
    }
    setShowArchivedState(next);
  }, [currentAgentUnread, currentContactUnread]);
  const contactUnread = showArchived ? activeUnreadCounts.contact : currentContactUnread;
  const agentUnread = showArchived ? activeUnreadCounts.agent : currentAgentUnread;
  const toggleForkParent = useCallback((parentSessionId: string) => {
    setCollapsedForkParents((current) => {
      const next = new Set(current);
      if (next.has(parentSessionId)) next.delete(parentSessionId);
      else next.add(parentSessionId);
      return next;
    });
  }, []);
  const isForkListExpanded = useCallback(
    (parentSessionId: string) => !collapsedForkParents.has(parentSessionId),
    [collapsedForkParents],
  );
  const activeSidebarRowSessionId = useMemo(
    () =>
      allSidebarSessions.find(
        ({ session }) =>
          activeConvId === session.id || activeConvId === session.canonicalSessionId,
      )?.session.id ?? activeConvId,
    [activeConvId, allSidebarSessions],
  );
  const sidebarSessionInputs = useMemo<ChatSidebarSessionInput[]>(
    () =>
      allSidebarSessions.map(({ session, space }) => ({
        sessionId: session.id,
        spaceId: space.id,
        parentSessionId: session.forkedFromSessionId,
      })),
    [allSidebarSessions],
  );
  const contactSpaceById = useMemo(
    () =>
      new Map(visibleContactParticipantSpaces.map((space) => [space.id, space])),
    [visibleContactParticipantSpaces],
  );
  const contactSidebarRows = useMemo(
    () =>
      buildChatSidebarRows({
        spaces: visibleContactParticipantSpaces.map((space) => {
          const expanded = isParticipantSpaceExpanded(space);
          const rootSessionIds = expanded
            ? space.sessions
              .filter((session) => {
                const parentId = session.forkedFromSessionId?.trim();
                return !parentId || !allSidebarSessionRowsById.has(parentId);
              })
              .map((session) => session.id)
            : [];
          return { spaceId: space.id, expanded, rootSessionIds };
        }),
        sessions: sidebarSessionInputs,
        collapsedForkParentIds: collapsedForkParents,
        activeSessionId: activeSidebarRowSessionId,
        includeSpaceRows: true,
      }),
    [
      activeSidebarRowSessionId,
      allSidebarSessionRowsById,
      collapsedForkParents,
      isParticipantSpaceExpanded,
      sidebarSessionInputs,
      visibleContactParticipantSpaces,
    ],
  );
  const agentSidebarRows = useMemo(
    () =>
      buildChatSidebarRows({
        spaces: [
          {
            spaceId: 'agent-sessions',
            expanded: true,
            rootSessionIds: topLevelAgentSessions.map(({ session }) => session.id),
          },
        ],
        sessions: flatAgentSessions.map(({ session, space }) => ({
          sessionId: session.id,
          spaceId: space.id,
          parentSessionId: session.forkedFromSessionId,
        })),
        collapsedForkParentIds: collapsedForkParents,
        activeSessionId: activeSidebarRowSessionId,
        includeSpaceRows: false,
      }),
    [
      activeSidebarRowSessionId,
      collapsedForkParents,
      flatAgentSessions,
      topLevelAgentSessions,
    ],
  );
  const totalUnread = chatConversations.reduce(
    (sum, conversation) =>
      isGroupForkSession(conversation) || mutedSessionIds.has(conversation.canonicalSessionId || conversation.id)
        ? sum
        : sum + Math.max(
          unreadSessionIds.has(conversation.canonicalSessionId || conversation.id) ? 1 : 0,
          conversation.unread ?? 0,
        ),
    0,
  );
  const collaborationSyncStatus: CollaborationSyncStatus =
    options.isCollaborationSyncUnavailable
      ? 'unavailable'
      : isCollaborationSyncing
        ? 'syncing'
        : 'idle';
  const collaborationSyncAriaLabel = collaborationSyncStatus === 'unavailable'
    ? 'Messages cannot sync right now'
    : collaborationSyncStatus === 'syncing'
      ? 'Messages are syncing'
      : null;
  const archivedSessionCount = filterParticipantSpaces(
    archivedParticipantSpaces,
    '',
    chatChannel,
  ).reduce((count, space) => count + space.sessions.length, 0);

  return {
    visibleParticipantSpaces,
    visibleContactParticipantSpaces,
    activeParticipantSpaceId,
    selectedParticipantSpaceId,
    isParticipantSpaceExpanded,
    setParticipantSpaceExpanded,
    selectedParticipantSpace,
    chatChannel,
    setChatChannel,
    globalForkLineage,
    allSidebarSessionRowsById,
    sidebarSessionIsActive,
    unreadBySessionIdWithForkDescendants,
    unreadByParticipantSpaceIdWithForkDescendants,
    contactUnread,
    agentUnread,
    toggleForkParent,
    isForkListExpanded,
    activeSidebarRowSessionId,
    contactSpaceById,
    contactSidebarRows,
    agentSidebarRows,
    agentSessionRowsById,
    agentForkLineage,
    totalUnread,
    collaborationSyncStatus,
    collaborationSyncAriaLabel,
    showArchived,
    setShowArchived,
    archivedSessionCount,
    pinnedSessionIds,
    mutedSessionIds,
    unreadSessionIds,
    pinnedGroupSpaceIds,
  };
}

export type WorkspaceChatSidebarModel = ReturnType<
  typeof useWorkspaceChatSidebarModel
>;
