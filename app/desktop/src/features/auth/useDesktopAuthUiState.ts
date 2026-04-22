import { useCallback, useMemo, useState } from 'react';

import type { SettingsSectionId } from '@/kordi-app/data/settings';
import type { DesktopAuthProvider, DesktopAuthState, NavId } from '@/kordi-app/types';

type UseDesktopAuthUiStateArgs = {
  isNativeShell: boolean;
  activeNav: NavId;
  activeSettingsSectionId: SettingsSectionId;
  desktopAuthState: DesktopAuthState | null;
  isDesktopAuthLoading: boolean;
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

  const openLoginFlow = useCallback((
    provider: DesktopAuthProvider,
    mode: 'oauth' | 'api-key',
    options?: { authority?: string; requireAuthority?: boolean },
  ) => {
    setActiveNav('settings');
    setActiveSettingsSectionId('auth');
    setActiveLoginProviderId(provider.id);
    clearDesktopAuthError();
    setInlineAuthDialog({
      providerId: provider.id,
      mode,
      authority: options?.authority,
      requireAuthority: options?.requireAuthority,
    });
  }, [clearDesktopAuthError, setActiveLoginProviderId, setActiveNav, setActiveSettingsSectionId]);

  const handleCloseInlineAuthDialog = useCallback(() => {
    setInlineAuthDialog(null);
  }, []);

  const showAuthGate = useMemo(() => (
    isNativeShell
      && !isDesktopAuthLoading
      && desktopAuthState !== null
      && !desktopAuthState.hasAnyAuth
      && !(activeNav === 'settings' && activeSettingsSectionId === 'auth')
      && !inlineAuthDialog
  ), [activeNav, activeSettingsSectionId, desktopAuthState, inlineAuthDialog, isDesktopAuthLoading, isNativeShell]);

  return {
    inlineAuthDialog,
    openLoginFlow,
    handleCloseInlineAuthDialog,
    showAuthGate,
  };
}
