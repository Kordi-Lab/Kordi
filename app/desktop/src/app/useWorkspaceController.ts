import { useCallback, useEffect, useRef, useState } from 'react';

import { resolveProjectSelection, type ProjectRoutingGroup } from '@/features/canonical/sessionResolver';
import type { DetailTab, NavId, Project } from '@/kordi-app/types';

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
  const [activeNav, setActiveNav] = useState<NavId>('chats');
  const [activeConvId, setActiveConvId] = useState(isNativeShell ? '' : 'my-agent');
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
    if (!isNativeShell || !projectRoutingGroups?.length) return;

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
    if (!activeProjectId || !activeProjectSessionId) return;
    latestProjectSelectionRef.current = { projectId: activeProjectId, sessionId: activeProjectSessionId };
    setProjectSelectedSessionIds((current) => (
      current[activeProjectId] === activeProjectSessionId
        ? current
        : { ...current, [activeProjectId]: activeProjectSessionId }
    ));
  }, [activeProjectId, activeProjectSessionId]);

  useEffect(() => {
    if (activeNav === 'chats' && activeDetailTab === 'context') {
      setActiveDetailTab('info');
    }
  }, [activeDetailTab, activeNav]);

  return {
    activeNav,
    setActiveNav,
    activeConvId,
    setActiveConvId,
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
