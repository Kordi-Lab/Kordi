import { isChatNavigation } from '@/features/chat/chatNavigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { resolveProjectSelection, type ProjectRoutingGroup } from '@/features/canonical/sessionResolver';
import { isProjectDraftSessionId } from '@/features/chat/draftSessions';
import type { DetailTab, NavId, Project } from '@/kordi-app/types';
import type { Dispatch, SetStateAction } from 'react';
import { reconcileChatNavigation, selectChatConversation, selectChatNavigation, type ChatNavigationState, type ChatNavId } from '@/features/chat/chatNavigation';

type UseWorkspaceControllerArgs = {
  initialProjects: Project[];
  projectRoutingGroups?: ProjectRoutingGroup[];
  isNativeShell: boolean;
};

export function useWorkspaceController({
  initialProjects,
  projectRoutingGroups,
  isNativeShell,
}: UseWorkspaceControllerArgs) {
  const [chatNavigation, setChatNavigation] = useState<ChatNavigationState>(() => ({
    activeNav: 'agent-chats', activeConvId: isNativeShell ? '' : 'my-agent',
    selections: { chats: '', 'agent-chats': isNativeShell ? '' : 'my-agent' },
  }));
  const { activeNav, activeConvId } = chatNavigation;
  const chatIndexRef = useRef<ReadonlyMap<string, ChatNavId>>(new Map());
  const setActiveNav: Dispatch<SetStateAction<NavId>> = useCallback(value => {
    setChatNavigation(current => selectChatNavigation(current, typeof value === 'function' ? value(current.activeNav) : value, chatIndexRef.current));
  }, []);
  const setActiveConvId: Dispatch<SetStateAction<string>> = useCallback(value => {
    setChatNavigation(current => selectChatConversation(current, typeof value === 'function' ? value(current.activeConvId) : value, chatIndexRef.current));
  }, []);
  const updateChatNavigationIndex = useCallback((index: ReadonlyMap<string, ChatNavId>) => {
    const previousIndex = chatIndexRef.current;
    chatIndexRef.current = index;
    setChatNavigation(current => reconcileChatNavigation(current, index, previousIndex));
  }, []);
  const [activeProjectId, setActiveProjectId] = useState(initialProjects[0]?.id ?? '');
  const [activeProjectSessionId, setActiveProjectSessionId] = useState(initialProjects[0]?.sessions[0]?.id ?? '');
  const [projectSelectedSessionIds, setProjectSelectedSessionIds] = useState<Record<string, string>>(() =>
    Object.fromEntries(initialProjects.map((project) => [project.id, project.sessions[0]?.id ?? ''])),
  );
  const [activeDetailTab, setActiveDetailTab] = useState<DetailTab>('info');
  const latestProjectSelectionRef = useRef<{ projectId: string; sessionId: string } | null>(null);

  const selectProject = useCallback((projectId: string, sessionId?: string) => {
    const nextSessionId = sessionId ?? '';
    latestProjectSelectionRef.current = {
      projectId,
      sessionId: nextSessionId,
    };
    setActiveProjectId(projectId);
    setActiveProjectSessionId(nextSessionId);
  }, []);

  const selectProjectSession = useCallback((projectId: string, sessionId: string) => {
    latestProjectSelectionRef.current = { projectId, sessionId };
    setActiveProjectId(projectId);
    setActiveProjectSessionId(sessionId);
    setProjectSelectedSessionIds((current) => ({ ...current, [projectId]: sessionId }));
  }, []);

  useEffect(() => {
    if (!isNativeShell || !projectRoutingGroups?.length || isProjectDraftSessionId(activeProjectSessionId)) return;

    const latestSelection = latestProjectSelectionRef.current;
    const resolvedSelection = resolveProjectSelection(
      projectRoutingGroups,
      latestSelection?.projectId ?? activeProjectId,
      latestSelection?.sessionId ?? activeProjectSessionId,
      projectSelectedSessionIds,
    );
    if (!resolvedSelection) return;

    if (resolvedSelection.projectId !== activeProjectId) {
      setActiveProjectId(resolvedSelection.projectId);
    }
    if (resolvedSelection.sessionId !== activeProjectSessionId) {
      setActiveProjectSessionId(resolvedSelection.sessionId);
    }
  }, [activeProjectId, activeProjectSessionId, isNativeShell, projectRoutingGroups, projectSelectedSessionIds]);

  useEffect(() => {
    if (!activeProjectId || !activeProjectSessionId || isProjectDraftSessionId(activeProjectSessionId)) return;
    latestProjectSelectionRef.current = { projectId: activeProjectId, sessionId: activeProjectSessionId };
    setProjectSelectedSessionIds((current) => (
      current[activeProjectId] === activeProjectSessionId
        ? current
        : { ...current, [activeProjectId]: activeProjectSessionId }
    ));
  }, [activeProjectId, activeProjectSessionId]);

  useEffect(() => {
    if (isChatNavigation(activeNav) && activeDetailTab === 'context') {
      setActiveDetailTab('info');
    }
  }, [activeDetailTab, activeNav]);

  return {
    activeNav,
    setActiveNav,
    activeConvId,
    setActiveConvId,
    updateChatNavigationIndex,
    activeProjectId,
    setActiveProjectId,
    activeProjectSessionId,
    setActiveProjectSessionId,
    projectSelectedSessionIds,
    setProjectSelectedSessionIds,
    activeDetailTab,
    setActiveDetailTab,
    selectProject,
    selectProjectSession,
  };
}
