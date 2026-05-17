import { useCallback, useEffect, useMemo, useState } from 'react';

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
};

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
}: UseDesktopAuthUiStateArgs) {
  const [inlineAuthDialog, setInlineAuthDialog] = useState<{
    providerId: string;
    mode: 'oauth' | 'api-key';
    authority?: string;
    requireAuthority?: boolean;
  } | null>(null);
  const [isAuthGateDismissed, setIsAuthGateDismissed] = useState(false);

  const openAuthSettings = useCallback(() => {
    setIsAuthGateDismissed(true);
    setActiveNav('settings');
    setActiveSettingsSectionId('auth');
    clearDesktopAuthError();
  }, [clearDesktopAuthError, setActiveNav, setActiveSettingsSectionId]);

  const openLoginFlow = useCallback((
    provider: DesktopAuthProvider,
    mode: 'oauth' | 'api-key',
    options?: { authority?: string; requireAuthority?: boolean },
  ) => {
    const shouldStayOnAuthGate = !startupGateSatisfied && !isAuthGateDismissed;

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
  }, [clearDesktopAuthError, isAuthGateDismissed, openAuthSettings, setActiveLoginProviderId, startupGateSatisfied]);

  const handleCloseInlineAuthDialog = useCallback(() => {
    setInlineAuthDialog(null);
  }, []);

  const dismissAuthGate = useCallback(() => {
    setIsAuthGateDismissed(true);
  }, []);

  useEffect(() => {
    if (startupGateSatisfied) {
      setIsAuthGateDismissed(false);
    }
  }, [startupGateSatisfied]);

  const showAuthGate = useMemo(() => (
    isNativeShell
      && !isDesktopAuthLoading
      && desktopAuthState !== null
      && !startupGateSatisfied
      && !(activeNav === 'settings' && activeSettingsSectionId === 'auth')
      && !isAuthGateDismissed
  ), [activeNav, activeSettingsSectionId, desktopAuthState, isAuthGateDismissed, isDesktopAuthLoading, isNativeShell, startupGateSatisfied]);

  return {
    inlineAuthDialog,
    openAuthSettings,
    openLoginFlow,
    handleCloseInlineAuthDialog,
    dismissAuthGate,
    showAuthGate,
  };
}
