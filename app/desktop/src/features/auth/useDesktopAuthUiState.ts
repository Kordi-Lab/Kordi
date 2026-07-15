import { useCallback, useEffect, useState } from 'react';

import type { SettingsSectionId } from '@/kordi-app/data/settings';
import type { DesktopAuthProvider, DesktopAuthState, NavId } from '@/kordi-app/types';

type UseDesktopAuthUiStateArgs = {
  isNativeShell: boolean;
  activeNav: NavId;
  activeSettingsSectionId: SettingsSectionId;
  desktopAuthState: DesktopAuthState | null;
  isDesktopAuthLoading: boolean;
  startupGateSatisfied: boolean;
  setActiveNav: (nav: NavId) => void;
  setActiveSettingsSectionId: (sectionId: SettingsSectionId) => void;
  setActiveLoginProviderId: (providerId: string) => void;
  clearDesktopAuthError: () => void;
  openAuthSurface?: () => void;
};

type DesktopAuthGateVisibilityArgs = Pick<UseDesktopAuthUiStateArgs,
  | 'activeNav'
  | 'activeSettingsSectionId'
  | 'desktopAuthState'
  | 'isDesktopAuthLoading'
  | 'isNativeShell'
  | 'startupGateSatisfied'
> & {
  isAuthGateResolvedForSession: boolean;
};

export function resolveAuthGateForSession(
  isResolvedForSession: boolean,
  startupGateSatisfied: boolean,
) {
  return isResolvedForSession || startupGateSatisfied;
}

export function shouldShowDesktopAuthGate({
  activeNav,
  activeSettingsSectionId,
  desktopAuthState,
  isAuthGateResolvedForSession,
  isDesktopAuthLoading,
  isNativeShell,
  startupGateSatisfied,
}: DesktopAuthGateVisibilityArgs) {
  return isNativeShell
    && !isDesktopAuthLoading
    && desktopAuthState !== null
    && !startupGateSatisfied
    && !(activeNav === 'settings' && activeSettingsSectionId === 'auth')
    && !isAuthGateResolvedForSession;
}

export function useDesktopAuthUiState({
  isNativeShell,
  activeNav,
  activeSettingsSectionId,
  desktopAuthState,
  isDesktopAuthLoading,
  startupGateSatisfied,
  setActiveNav,
  setActiveSettingsSectionId,
  setActiveLoginProviderId,
  clearDesktopAuthError,
  openAuthSurface,
}: UseDesktopAuthUiStateArgs) {
  const [inlineAuthDialog, setInlineAuthDialog] = useState<{
    providerId: string;
    mode: 'oauth' | 'api-key';
    authority?: string;
    requireAuthority?: boolean;
  } | null>(null);
  const [isAuthGateResolvedForSession, setIsAuthGateResolvedForSession] = useState(false);

  const openAuthSettings = useCallback(() => {
    setIsAuthGateResolvedForSession(true);
    if (openAuthSurface) {
      openAuthSurface();
    } else {
      setActiveNav('settings');
      setActiveSettingsSectionId('auth');
    }
    clearDesktopAuthError();
  }, [clearDesktopAuthError, openAuthSurface, setActiveNav, setActiveSettingsSectionId]);

  const openLoginFlow = useCallback((
    provider: DesktopAuthProvider,
    mode: 'oauth' | 'api-key',
    options?: { authority?: string; requireAuthority?: boolean },
  ) => {
    const shouldStayOnAuthGate = !startupGateSatisfied && !isAuthGateResolvedForSession;

    if (!shouldStayOnAuthGate) {
      openAuthSettings();
    } else {
      clearDesktopAuthError();
    }

    setActiveLoginProviderId(provider.id);
    setInlineAuthDialog({
      providerId: provider.id,
      mode,
      authority: options?.authority,
      requireAuthority: options?.requireAuthority,
    });
  }, [clearDesktopAuthError, isAuthGateResolvedForSession, openAuthSettings, setActiveLoginProviderId, startupGateSatisfied]);

  const handleCloseInlineAuthDialog = useCallback(() => {
    setInlineAuthDialog(null);
  }, []);

  const dismissAuthGate = useCallback(() => {
    setIsAuthGateResolvedForSession(true);
  }, []);

  useEffect(() => {
    if (!startupGateSatisfied) return;
    setIsAuthGateResolvedForSession((current) => resolveAuthGateForSession(current, true));
  }, [startupGateSatisfied]);

  const showAuthGate = shouldShowDesktopAuthGate({
    activeNav,
    activeSettingsSectionId,
    desktopAuthState,
    isAuthGateResolvedForSession,
    isDesktopAuthLoading,
    isNativeShell,
    startupGateSatisfied,
  });

  return {
    inlineAuthDialog,
    openAuthSettings,
    openLoginFlow,
    handleCloseInlineAuthDialog,
    dismissAuthGate,
    showAuthGate,
  };
}
