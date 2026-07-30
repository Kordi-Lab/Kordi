import { useCallback, useEffect, useMemo } from 'react';

import { useDesktopAuthUiState } from '@/features/auth/useDesktopAuthUiState';
import { authStateSatisfiesStartupGate } from '@/kordi-app/auth/model';
import {
  normalizeNavIdForCloud,
  normalizeSettingsSectionIdForCloud,
  settingsSections,
} from '@/kordi-app/data';
import type { SettingsSectionId } from '@/kordi-app/data/settings';
import type { CloudAccountSettingsTabId } from '@/pages/CloudAccountSettingsDialog';
import type { DesktopAuthState, NavId } from '@/kordi-app/types';

type KordiAuthNavigationStateArgs = {
  activeNav: NavId;
  activeSettingsSectionId: SettingsSectionId;
  clearDesktopAuthError: () => void;
  desktopAuthState: DesktopAuthState | null;
  isDesktopAuthLoading: boolean;
  isNativeShell: boolean;
  setActiveNav: (nav: NavId) => void;
  setActiveLoginProviderId: (providerId: string) => void;
  setActiveSettingsSectionId: (sectionId: SettingsSectionId) => void;
  setCloudAccountDialogTab: (tab: CloudAccountSettingsTabId | null) => void;
};

export function useKordiAuthNavigationState({
  activeNav,
  activeSettingsSectionId,
  clearDesktopAuthError,
  desktopAuthState,
  isDesktopAuthLoading,
  isNativeShell,
  setActiveNav,
  setActiveLoginProviderId,
  setActiveSettingsSectionId,
  setCloudAccountDialogTab,
}: KordiAuthNavigationStateArgs) {
  const visibleActiveSettingsSectionId =
    normalizeSettingsSectionIdForCloud(activeSettingsSectionId);

  useEffect(() => {
    const nextActiveNav = normalizeNavIdForCloud(activeNav);
    if (nextActiveNav !== activeNav) setActiveNav(nextActiveNav);
  }, [activeNav, setActiveNav]);

  useEffect(() => {
    if (visibleActiveSettingsSectionId !== activeSettingsSectionId) {
      setActiveSettingsSectionId(visibleActiveSettingsSectionId);
    }
  }, [
    activeSettingsSectionId,
    setActiveSettingsSectionId,
    visibleActiveSettingsSectionId,
  ]);

  const startupGateSatisfied = useMemo(
    () => authStateSatisfiesStartupGate(desktopAuthState),
    [desktopAuthState],
  );
  const openCloudAccountAuthentication = useCallback(() => {
    setCloudAccountDialogTab('auth');
    clearDesktopAuthError();
  }, [clearDesktopAuthError, setCloudAccountDialogTab]);
  const authUi = useDesktopAuthUiState({
    isNativeShell,
    activeNav,
    activeSettingsSectionId: visibleActiveSettingsSectionId,
    desktopAuthState,
    isDesktopAuthLoading,
    startupGateSatisfied,
    setActiveNav,
    setActiveSettingsSectionId,
    setActiveLoginProviderId,
    clearDesktopAuthError,
    openAuthSurface: openCloudAccountAuthentication,
  });

  return {
    ...authUi,
    openCloudAccountAuthentication,
    visibleActiveSettingsSectionId,
    visibleSettingsSections: settingsSections,
  };
}
