import { useCallback, useEffect, useState } from 'react';

import type { DesktopChatProjectGroup, DesktopProjectSettings, NavId } from '@/kordi-app/types';
import { fetchDesktopProjectSettings, saveDesktopProjectSettings } from '@/lib/desktop';

type UseProjectSettingsStateArgs = {
  isNativeShell: boolean;
  activeNav: NavId;
  activeProjectId: string;
  activeProjectSessionId: string;
  activeChatSessionId?: string;
  projects?: DesktopChatProjectGroup[] | null;
  refreshDesktopChat: (activeSessionId?: string) => Promise<void>;
};

export function useProjectSettingsState({
  isNativeShell,
  activeNav,
  activeProjectId,
  activeProjectSessionId,
  activeChatSessionId,
  projects,
  refreshDesktopChat,
}: UseProjectSettingsStateArgs) {
  const [desktopProjectSettings, setDesktopProjectSettings] = useState<DesktopProjectSettings | null>(null);
  const [projectSettingsDraft, setProjectSettingsDraft] = useState<DesktopProjectSettings | null>(null);
  const [isDesktopProjectSaving, setIsDesktopProjectSaving] = useState(false);
  const [desktopProjectError, setDesktopProjectError] = useState<string | null>(null);

  const refreshDesktopProjectSettings = useCallback(async (projectRoot?: string) => {
    const nextSettings = await fetchDesktopProjectSettings(projectRoot);
    if (nextSettings) {
      setDesktopProjectSettings(nextSettings);
      setProjectSettingsDraft(nextSettings);
      setDesktopProjectError(null);
    }
  }, []);

  const updateProjectSettingsDraft = useCallback((apply: (current: DesktopProjectSettings) => DesktopProjectSettings) => {
    setProjectSettingsDraft((current) => (current ? apply(current) : current));
  }, []);

  const handleSaveProjectSettings = useCallback(async () => {
    if (!isNativeShell || !projectSettingsDraft) return;

    try {
      setIsDesktopProjectSaving(true);
      setDesktopProjectError(null);
      const saved = await saveDesktopProjectSettings(
        projectSettingsDraft.name,
        projectSettingsDraft.context,
        projectSettingsDraft.systemPrompt,
        projectSettingsDraft.sharedSources,
        projectSettingsDraft.root,
      );
      setDesktopProjectSettings(saved);
      setProjectSettingsDraft(saved);
      await refreshDesktopChat(activeNav === 'projects' ? activeProjectSessionId : activeChatSessionId);
      await refreshDesktopProjectSettings(saved.root);
    } catch (error) {
      setDesktopProjectError(error instanceof Error ? error.message : 'Unable to save project settings');
    } finally {
      setIsDesktopProjectSaving(false);
    }
  }, [activeChatSessionId, activeNav, activeProjectSessionId, isNativeShell, projectSettingsDraft, refreshDesktopChat, refreshDesktopProjectSettings]);

  useEffect(() => {
    if (!isNativeShell) return;
    const projectRoot = projects?.find((project) => project.id === activeProjectId)?.root;
    if (!projectRoot) return;
    void refreshDesktopProjectSettings(projectRoot);
  }, [activeProjectId, isNativeShell, projects, refreshDesktopProjectSettings]);

  return {
    desktopProjectSettings,
    setDesktopProjectSettings,
    projectSettingsDraft,
    setProjectSettingsDraft,
    isDesktopProjectSaving,
    desktopProjectError,
    setDesktopProjectError,
    refreshDesktopProjectSettings,
    updateProjectSettingsDraft,
    handleSaveProjectSettings,
  };
}
