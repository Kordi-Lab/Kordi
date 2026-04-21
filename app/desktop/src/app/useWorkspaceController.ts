import { useCallback, useEffect, useRef, useState } from 'react';

import type { DetailTab, DesktopChatProjectGroup, NavId, Project } from '@/kordi-app/types';

type UseWorkspaceControllerArgs = {
  initialProjects: Project[];
  desktopProjects?: DesktopChatProjectGroup[];
  isNativeShell: boolean;
};

export function useWorkspaceController({
  initialProjects,
  desktopProjects,
  isNativeShell,
}: UseWorkspaceControllerArgs) {
  const [activeNav, setActiveNav] = useState<NavId>('chats');
  const [activeConvId, setActiveConvId] = useState('my-agent');
  const [activeProjectId, setActiveProjectId] = useState(initialProjects[0]?.id ?? '');
  const [activeProjectSessionId, setActiveProjectSessionId] = useState(initialProjects[0]?.sessions[0]?.id ?? '');
  const [projectSelectedSessionIds, setProjectSelectedSessionIds] = useState<Record<string, string>>(() =>
    Object.fromEntries(initialProjects.map((project) => [project.id, project.sessions[0]?.id ?? ''])),
  );
  const [activeDetailTab, setActiveDetailTab] = useState<DetailTab>('info');
  const latestProjectSelectionRef = useRef<{ projectId: string; sessionId: string } | null>(null);

  const selectProject = useCallback((projectId: string, sessionId?: string) => {
    latestProjectSelectionRef.current = {
      projectId,
      sessionId: sessionId ?? '',
    };
    setActiveProjectId(projectId);
    if (sessionId) {
      setActiveProjectSessionId(sessionId);
    }
  }, []);

  const selectProjectSession = useCallback((projectId: string, sessionId: string) => {
    latestProjectSelectionRef.current = { projectId, sessionId };
    setActiveProjectId(projectId);
    setActiveProjectSessionId(sessionId);
    setProjectSelectedSessionIds((current) => ({ ...current, [projectId]: sessionId }));
  }, []);

  useEffect(() => {
    if (!isNativeShell || !desktopProjects?.length) return;

    const firstProject = desktopProjects[0];
    if (!firstProject) return;

    const latestSelection = latestProjectSelectionRef.current;
    const preferredProjectId = latestSelection?.projectId ?? activeProjectId;
    const resolvedProject = desktopProjects.find((project) => project.id === preferredProjectId)
      ?? desktopProjects.find((project) => project.id === activeProjectId)
      ?? firstProject;

    const rememberedSessionId = projectSelectedSessionIds[resolvedProject.id];
    const preferredSessionId =
      (latestSelection && latestSelection.projectId === resolvedProject.id && resolvedProject.sessions.some((session) => session.id === latestSelection.sessionId)
        ? latestSelection.sessionId
        : undefined)
      ?? (resolvedProject.id === activeProjectId && resolvedProject.sessions.some((session) => session.id === activeProjectSessionId)
        ? activeProjectSessionId
        : undefined)
      ?? (rememberedSessionId && resolvedProject.sessions.some((session) => session.id === rememberedSessionId)
        ? rememberedSessionId
        : undefined)
      ?? resolvedProject.sessions[0]?.id;

    if (resolvedProject.id !== activeProjectId) {
      setActiveProjectId(resolvedProject.id);
    }
    if (preferredSessionId && preferredSessionId !== activeProjectSessionId) {
      setActiveProjectSessionId(preferredSessionId);
    }
  }, [activeProjectId, activeProjectSessionId, desktopProjects, isNativeShell, projectSelectedSessionIds]);

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
