import { useCallback, useEffect, useState } from 'react';

import type { DesktopAuthState } from '@/kordi-app/types';
import {
  fetchDesktopAuthState,
  logoutDesktopProvider,
  removeDesktopAuthProfile,
  setDesktopActiveAuthChoice,
} from '@/lib/desktop';

type UseDesktopAuthStateArgs = {
  isNativeShell: boolean;
};

export function useDesktopAuthState({ isNativeShell }: UseDesktopAuthStateArgs) {
  const [desktopAuthState, setDesktopAuthState] = useState<DesktopAuthState | null>(null);
  const [isDesktopAuthLoading, setIsDesktopAuthLoading] = useState(isNativeShell);
  const [desktopAuthError, setDesktopAuthError] = useState<string | null>(null);
  const [activeLoginProviderId, setActiveLoginProviderId] = useState<string | null>(null);

  const clearDesktopAuthError = useCallback(() => {
    setDesktopAuthError(null);
  }, []);

  const selectAuthProvider = useCallback((providerId: string) => {
    setActiveLoginProviderId(providerId);
    setDesktopAuthError(null);
  }, []);

  const refreshDesktopAuth = useCallback(async () => {
    const nextState = await fetchDesktopAuthState();
    setDesktopAuthState(nextState);
    setDesktopAuthError(null);
  }, []);

  const handleLogoutProvider = useCallback(async (providerId: string) => {
    try {
      setDesktopAuthError(null);
      const nextState = await logoutDesktopProvider(providerId);
      setDesktopAuthState(nextState);
    } catch (error) {
      setDesktopAuthError(error instanceof Error ? error.message : 'Unable to log out provider');
    }
  }, []);

  const handleSelectAuthChoice = useCallback(async (providerId: string, choice: string) => {
    try {
      setDesktopAuthError(null);
      const nextState = await setDesktopActiveAuthChoice(providerId, choice);
      setDesktopAuthState(nextState);
    } catch (error) {
      setDesktopAuthError(error instanceof Error ? error.message : 'Unable to select auth option');
    }
  }, []);

  const handleRemoveAuthProfile = useCallback(async (providerId: string, profileId: string) => {
    try {
      setDesktopAuthError(null);
      const nextState = await removeDesktopAuthProfile(providerId, profileId);
      setDesktopAuthState(nextState);
    } catch (error) {
      setDesktopAuthError(error instanceof Error ? error.message : 'Unable to remove saved auth');
    }
  }, []);

  useEffect(() => {
    if (!isNativeShell) return;

    let cancelled = false;
    setIsDesktopAuthLoading(true);
    fetchDesktopAuthState()
      .then((state) => {
        if (cancelled) return;
        setDesktopAuthState(state);
        setDesktopAuthError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setDesktopAuthError(error instanceof Error ? error.message : 'Unable to load desktop auth');
      })
      .finally(() => {
        if (!cancelled) {
          setIsDesktopAuthLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isNativeShell]);

  useEffect(() => {
    if (!desktopAuthState?.providers.length) return;
    if (activeLoginProviderId) return;
    setActiveLoginProviderId(desktopAuthState.providers[0].id);
  }, [desktopAuthState?.providers, activeLoginProviderId]);

  useEffect(() => {
    const channel = new BroadcastChannel('kordi-auth');
    const refresh = () => {
      void refreshDesktopAuth();
    };

    channel.onmessage = (event) => {
      if (event.data?.type === 'auth-updated') {
        refresh();
      }
    };

    window.addEventListener('focus', refresh);

    return () => {
      window.removeEventListener('focus', refresh);
      channel.close();
    };
  }, [refreshDesktopAuth]);

  return {
    desktopAuthState,
    setDesktopAuthState,
    isDesktopAuthLoading,
    desktopAuthError,
    setDesktopAuthError,
    clearDesktopAuthError,
    activeLoginProviderId,
    setActiveLoginProviderId,
    selectAuthProvider,
    refreshDesktopAuth,
    handleLogoutProvider,
    handleSelectAuthChoice,
    handleRemoveAuthProfile,
  };
}
