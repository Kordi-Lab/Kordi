import {
  useCallback,
  useEffect,
  type Dispatch,
  type SetStateAction,
} from 'react';

import { PROJECTS_UPDATED_EVENT } from '@/features/projects/projectSync';
import type { AttachmentItem } from '@/features/chat/composerController.types';
import type { ComposerDraftState } from '@/features/chat/composerDrafts';
import { updateScopeDraft } from '@/features/chat/composerDrafts';
import { isLocalDraftChatConversationId } from '@/features/chat/draftSessions';
import type {
  ComposerScope,
  ComposerSelectorType,
  DesktopChatState,
  NavId,
  Project,
} from '@/kordi-app/types';
import {
  createDesktopProject,
  createDesktopProjectSession,
  createDesktopProjectFromFolder,
  moveDesktopChatSessionToProject,
} from '@/lib/desktop';

type UseKordiProjectActionsArgs = {
  activeProject: Project;
  activeConversationId: string;
  setActiveConversationId: Dispatch<SetStateAction<string>>;
  isNativeShell: boolean;
  refreshCanonicalState: () => Promise<void>;
  refreshDesktopChat: (activeSessionId?: string) => Promise<void>;
  setActiveNav: Dispatch<SetStateAction<NavId>>;
  setComposerAttachments: Dispatch<SetStateAction<AttachmentItem[]>>;
  setComposerDrafts: Dispatch<SetStateAction<ComposerDraftState>>;
  setDesktopError: Dispatch<SetStateAction<string | null>>;
  setDesktopState: Dispatch<SetStateAction<DesktopChatState | null>>;
  setOpenComposerSelector: Dispatch<SetStateAction<{
    scope: ComposerScope;
    type: ComposerSelectorType;
  } | null>>;
};

export function useKordiProjectActions({
  activeProject,
  activeConversationId,
  setActiveConversationId,
  isNativeShell,
  refreshCanonicalState,
  refreshDesktopChat,
  setActiveNav,
  setComposerAttachments,
  setComposerDrafts,
  setDesktopError,
  setDesktopState,
  setOpenComposerSelector,
}: UseKordiProjectActionsArgs) {
  useEffect(() => {
    if (!isNativeShell) return;
    const refresh = () => {
      void refreshCanonicalState().then(() => refreshDesktopChat(activeConversationId))
        .catch(() => setDesktopError('Projects changed on another device. Refresh to see the latest sessions.'));
    };
    window.addEventListener(PROJECTS_UPDATED_EVENT, refresh);
    return () => window.removeEventListener(PROJECTS_UPDATED_EVENT, refresh);
  }, [isNativeShell, refreshCanonicalState, refreshDesktopChat, activeConversationId, setDesktopError]);
  const moveSessionToProject = useCallback(async (
    sessionId: string,
    requestedProjectRoot: string,
  ) => {
    if (!isNativeShell) return;

    try {
      setDesktopError(null);
      const isDraft = !sessionId || isLocalDraftChatConversationId(sessionId);
      if (isDraft && !requestedProjectRoot) return;
      const nextState = isDraft
        ? await createDesktopProjectSession(requestedProjectRoot)
        : await moveDesktopChatSessionToProject(sessionId, requestedProjectRoot);
      if (!sessionId || sessionId === activeConversationId) {
        setDesktopState(nextState);
        if (!sessionId) {
          setComposerAttachments([]);
          setOpenComposerSelector(null);
        }
        if (isDraft && sessionId) {
          setComposerDrafts((current) => {
            const draft = current.chat[sessionId];
            const next = updateScopeDraft(current, 'chat', sessionId, '');
            return draft ? updateScopeDraft(next, 'chat', nextState.activeSessionId, draft.text) : next;
          });
        }
        setActiveConversationId(nextState.activeSessionId);
      }
      try {
        await refreshCanonicalState();
        await refreshDesktopChat(!sessionId || sessionId === activeConversationId ? nextState.activeSessionId : activeConversationId);
      } catch {
        // The assignment has already committed. Retrying a successful native
        // creation would duplicate an empty session after a refresh failure.
        setDesktopError('Project updated, but the session list could not refresh. Reopen the chat to refresh it.');
      }
      setActiveNav('chats');
    } catch (error) {
      setDesktopError(
        error instanceof Error
          ? error.message
          : 'Unable to move session to project',
      );
      throw error;
    }
  }, [
    activeConversationId, isNativeShell, refreshCanonicalState, refreshDesktopChat,
    setActiveConversationId, setActiveNav, setComposerAttachments, setComposerDrafts, setDesktopError, setDesktopState, setOpenComposerSelector,
  ]);

  const createProjectFromFolder = useCallback(async (
    folderPath: string,
    name?: string,
  ) => {
    if (!isNativeShell) return;
    try {
      setDesktopError(null);
      const project = await createDesktopProjectFromFolder(folderPath, name);
      await moveSessionToProject('', project.root);
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'Unable to create project from folder';
      setDesktopError(message);
      throw new Error(message);
    }
  }, [isNativeShell, moveSessionToProject, setDesktopError]);

  const createProject = useCallback(async (
    name: string,
    parentDir?: string,
  ) => {
    if (!isNativeShell) return;
    try {
      setDesktopError(null);
      const project = await createDesktopProject(name, parentDir);
      await moveSessionToProject('', project.root);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to create project';
      setDesktopError(message);
      throw new Error(message);
    }
  }, [isNativeShell, moveSessionToProject, setDesktopError]);

  const createProjectSession = useCallback((): Promise<void> => {
    const projectRoot = activeProject.root?.trim();
    return projectRoot ? moveSessionToProject('', projectRoot) : Promise.resolve();
  }, [activeProject.root, moveSessionToProject]);

  return {
    moveSessionToProject,
    createProjectFromFolder,
    createProject,
    createProjectSession,
  };
}
