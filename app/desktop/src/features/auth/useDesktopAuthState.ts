import { useCallback, useEffect, useRef, useState } from 'react';

import type { DesktopAuthState } from '@/kordi-app/types';
import {
  fetchDesktopAuthState,
  logoutDesktopProvider,
  removeDesktopAuthProfile,
  setDesktopActiveAuthChoice,
} from '@/lib/desktop';
import {
  DESKTOP_AUTH_CHANNEL_NAME,
  DESKTOP_AUTH_REFRESH_EVENT,
  broadcastDesktopAuthUpdated,
  createDesktopAuthSyncGuard,
  isDesktopAuthUpdateFromAnotherSource,
  type DesktopAuthUpdateReason,
} from './desktopAuthSync';

type UseDesktopAuthStateArgs = {
  isNativeShell: boolean;
};

export function useDesktopAuthState({ isNativeShell }: UseDesktopAuthStateArgs) {
  const [desktopAuthState, setDesktopAuthState] = useState<DesktopAuthState | null>(null);
  const [isDesktopAuthLoading, setIsDesktopAuthLoading] = useState(isNativeShell);
  const [desktopAuthError, setDesktopAuthError] = useState<string | null>(null);
  const [activeLoginProviderId, setActiveLoginProviderId] = useState<string | null>(null);
  const authSyncGuardRef = useRef<ReturnType<typeof createDesktopAuthSyncGuard> | null>(null);
  if (!authSyncGuardRef.current) {
    authSyncGuardRef.current = createDesktopAuthSyncGuard();
  }
  const authSyncGuard = authSyncGuardRef.current;

  const clearDesktopAuthError = useCallback(() => {
    setDesktopAuthError(null);
  }, []);

  const selectAuthProvider = useCallback((providerId: string) => {
    setActiveLoginProviderId(providerId);
    setDesktopAuthError(null);
  }, []);

  const loadDesktopAuthState = useCallback(async (isCancelled: () => boolean = () => false) => {
    const refreshToken = authSyncGuard.beginRefresh();

    try {
      const nextState = await fetchDesktopAuthState();
      if (isCancelled() || !authSyncGuard.canApplyRefresh(refreshToken)) return;
      setDesktopAuthState(nextState);
      setDesktopAuthError(null);
    } catch (error) {
      if (isCancelled() || !authSyncGuard.canApplyRefresh(refreshToken)) return;
      setDesktopAuthError(error instanceof Error ? error.message : 'Unable to load desktop auth');
    }
  }, [authSyncGuard]);

  const refreshDesktopAuth = useCallback(async () => {
    await loadDesktopAuthState();
  }, [loadDesktopAuthState]);

  const runDesktopAuthMutation = useCallback(async (
    operation: () => Promise<DesktopAuthState>,
    fallbackError: string,
    reason: DesktopAuthUpdateReason,
  ) => {
    authSyncGuard.beginMutation();
    try {
      setDesktopAuthError(null);
      const nextState = await operation();
      setDesktopAuthState(nextState);
      setDesktopAuthError(null);
      broadcastDesktopAuthUpdated(reason);
    } catch (error) {
      setDesktopAuthError(error instanceof Error ? error.message : fallbackError);
    } finally {
      authSyncGuard.finishMutation();
    }
  }, [authSyncGuard]);

  const handleLogoutProvider = useCallback(async (providerId: string) => {
    await runDesktopAuthMutation(
      () => logoutDesktopProvider(providerId),
      'Unable to log out provider',
      'provider-logout',
    );
  }, [runDesktopAuthMutation]);

  const handleSelectAuthChoice = useCallback(async (providerId: string, choice: string) => {
    await runDesktopAuthMutation(
      () => setDesktopActiveAuthChoice(providerId, choice),
      'Unable to select auth option',
      'active-choice-changed',
    );
  }, [runDesktopAuthMutation]);

  const handleRemoveAuthProfile = useCallback(async (providerId: string, profileId: string) => {
    await runDesktopAuthMutation(
      () => removeDesktopAuthProfile(providerId, profileId),
      'Unable to remove saved auth',
      'profile-removed',
    );
  }, [runDesktopAuthMutation]);

  useEffect(() => {
    if (!isNativeShell) return;

    let cancelled = false;
    setIsDesktopAuthLoading(true);
    void loadDesktopAuthState(() => cancelled)
      .finally(() => {
        if (!cancelled) {
          setIsDesktopAuthLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isNativeShell, loadDesktopAuthState]);

  useEffect(() => {
    if (!isNativeShell) return;

    const refresh = () => {
      void refreshDesktopAuth();
    };
    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        channel = new BroadcastChannel(DESKTOP_AUTH_CHANNEL_NAME);
      } catch {
        // Focus-driven refresh remains available in restricted webviews.
      }
    }

    if (channel) {
      channel.onmessage = (event) => {
        if (!isDesktopAuthUpdateFromAnotherSource(event.data)) return;
        refresh();
      };
    }

    window.addEventListener('focus', refresh);
    window.addEventListener(DESKTOP_AUTH_REFRESH_EVENT, refresh);

    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener(DESKTOP_AUTH_REFRESH_EVENT, refresh);
      channel?.close();
    };
  }, [isNativeShell, refreshDesktopAuth]);

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
