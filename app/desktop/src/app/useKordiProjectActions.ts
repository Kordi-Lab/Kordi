import {
  useCallback,
  type Dispatch,
  type SetStateAction,
} from 'react';

import type { AttachmentItem } from '@/features/chat/composerController.types';
import type { ComposerDraftState } from '@/features/chat/composerDrafts';
import { updateScopeDraft } from '@/features/chat/composerDrafts';
import { projectDraftSessionId } from '@/features/chat/draftSessions';
import { canonicalProjectGroupIdFromRoot } from '@/features/canonical/sessionResolver';
import type {
  ComposerScope,
  ComposerSelectorType,
  DesktopChatState,
  NavId,
  Project,
} from '@/kordi-app/types';
import {
  createDesktopProject,
  createDesktopProjectFromFolder,
  moveDesktopChatSessionToProject,
} from '@/lib/desktop';

type UseKordiProjectActionsArgs = {
  activeProject: Project;
  desktopState: DesktopChatState | null;
  isNativeShell: boolean;
  refreshCanonicalState: () => Promise<void>;
  refreshDesktopChat: (activeSessionId?: string) => Promise<void>;
  selectProject: (projectId: string, sessionId?: string) => void;
  selectProjectSession: (projectId: string, sessionId: string) => void;
  setActiveNav: Dispatch<SetStateAction<NavId>>;
  setComposerAttachments: Dispatch<SetStateAction<AttachmentItem[]>>;
  setComposerDrafts: Dispatch<SetStateAction<ComposerDraftState>>;
  setDesktopError: Dispatch<SetStateAction<string | null>>;
  setDesktopState: Dispatch<SetStateAction<DesktopChatState | null>>;
  setExpandedProjectIds: Dispatch<
    SetStateAction<Record<string, boolean>>
  >;
  setOpenComposerSelector: Dispatch<SetStateAction<{
    scope: ComposerScope;
    type: ComposerSelectorType;
  } | null>>;
};

export function useKordiProjectActions({
  activeProject,
  desktopState,
  isNativeShell,
  refreshCanonicalState,
  refreshDesktopChat,
  selectProject,
  selectProjectSession,
  setActiveNav,
  setComposerAttachments,
  setComposerDrafts,
  setDesktopError,
  setDesktopState,
  setExpandedProjectIds,
  setOpenComposerSelector,
}: UseKordiProjectActionsArgs) {
  const moveSessionToProject = useCallback(async (
    sessionId: string,
    requestedProjectRoot: string,
  ) => {
    if (!isNativeShell || !sessionId.trim()) return;

    try {
      setDesktopError(null);
      const nextState = await moveDesktopChatSessionToProject(
        sessionId,
        requestedProjectRoot,
      );
      setDesktopState(nextState);

      const resolvedProjectRoot =
        nextState.activeSession.project?.root ?? requestedProjectRoot;
      const resolvedProjectId =
        canonicalProjectGroupIdFromRoot(resolvedProjectRoot)
        ?? resolvedProjectRoot;
      if (resolvedProjectId) {
        selectProjectSession(
          resolvedProjectId,
          nextState.activeSessionId,
        );
        setExpandedProjectIds((current) => ({
          ...current,
          [resolvedProjectId]: true,
        }));
      }
      setActiveNav('projects');
    } catch (error) {
      setDesktopError(
        error instanceof Error
          ? error.message
          : 'Unable to move session to project',
      );
    }
  }, [
    isNativeShell,
    selectProjectSession,
    setActiveNav,
    setDesktopError,
    setDesktopState,
    setExpandedProjectIds,
  ]);

  const selectCreatedProject = useCallback(async (projectRoot: string) => {
    const projectId =
      canonicalProjectGroupIdFromRoot(projectRoot) ?? projectRoot;
    setActiveNav('projects');
    selectProject(projectId);
    setExpandedProjectIds((current) => ({
      ...current,
      [projectId]: true,
    }));
    await refreshDesktopChat(desktopState?.activeSessionId);
    await refreshCanonicalState();
  }, [
    desktopState?.activeSessionId,
    refreshCanonicalState,
    refreshDesktopChat,
    selectProject,
    setActiveNav,
    setExpandedProjectIds,
  ]);

  const createProjectFromFolder = useCallback(async (
    folderPath: string,
    name?: string,
  ) => {
    if (!isNativeShell) return;
    try {
      setDesktopError(null);
      const project = await createDesktopProjectFromFolder(folderPath, name);
      await selectCreatedProject(project.root);
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'Unable to create project from folder';
      setDesktopError(message);
      throw new Error(message);
    }
  }, [isNativeShell, selectCreatedProject, setDesktopError]);

  const createProject = useCallback(async (
    name: string,
    parentDir?: string,
  ) => {
    if (!isNativeShell) return;
    try {
      setDesktopError(null);
      const project = await createDesktopProject(name, parentDir);
      await selectCreatedProject(project.root);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to create project';
      setDesktopError(message);
      throw new Error(message);
    }
  }, [isNativeShell, selectCreatedProject, setDesktopError]);

  const createProjectSession = useCallback((): Promise<void> => {
    if (!isNativeShell) return Promise.resolve();
    const projectRoot = activeProject.root?.trim();
    if (!projectRoot) return Promise.resolve();

    setDesktopError(null);
    const projectId =
      canonicalProjectGroupIdFromRoot(projectRoot) ?? activeProject.id;
    const draftSessionId = projectDraftSessionId(projectId);
    selectProjectSession(projectId, draftSessionId);
    setExpandedProjectIds((current) => ({
      ...current,
      [projectId]: true,
    }));
    setComposerDrafts((current) => updateScopeDraft(
      current,
      'project',
      draftSessionId,
      '',
    ));
    setComposerAttachments([]);
    setOpenComposerSelector(null);
    setActiveNav('projects');
    return Promise.resolve();
  }, [
    activeProject.id,
    activeProject.root,
    isNativeShell,
    selectProjectSession,
    setActiveNav,
    setComposerAttachments,
    setComposerDrafts,
    setDesktopError,
    setExpandedProjectIds,
    setOpenComposerSelector,
  ]);

  return {
    moveSessionToProject,
    createProjectFromFolder,
    createProject,
    createProjectSession,
  };
}
