import { useCallback, useEffect, useRef, useState } from 'react';
import { CLOUD_SESSION_CHANGED_EVENT, loadSession } from '@/features/cloud/session';

import type { DesktopAuthState } from '@/kordi-app/types';
import {
  fetchDesktopAuthState,
  logoutDesktopProvider,
  removeDesktopAuthProfile,
  setDesktopActiveAuthChoice,
} from '@/lib/desktop';
import {
  DESKTOP_AUTH_CHANNEL_NAME,
  broadcastDesktopAuthUpdated,
  createDesktopAuthSyncGuard,
  desktopAuthSyncIntentFromAnotherSource,
  isDesktopAuthUpdateFromAnotherSource,
  type DesktopAuthSyncIntent,
  type DesktopAuthUpdateReason,
} from './desktopAuthSync';

type UseDesktopAuthStateArgs = {
  isNativeShell: boolean;
  accountId?: string | null;
};

export function useDesktopAuthState({ isNativeShell, accountId }: UseDesktopAuthStateArgs) {
  const [desktopAuthState, setDesktopAuthState] = useState<DesktopAuthState | null>(null);
  const [isDesktopAuthLoading, setIsDesktopAuthLoading] = useState(isNativeShell);
  const [desktopAuthError, setDesktopAuthError] = useState<string | null>(null);
  const [activeLoginProviderId, setActiveLoginProviderId] = useState<string | null>(null);
  const [providerAuthSyncIntent, setProviderAuthSyncIntent] =
    useState<DesktopAuthSyncIntent | null>(null);
  const providerAuthSyncRevisionRef = useRef(0);
  const accountGenerationRef = useRef(0);
  const [authSyncGuard] = useState(createDesktopAuthSyncGuard);

  const recordProviderAuthSyncIntent = useCallback(async (
    reason: DesktopAuthUpdateReason,
    providerId: string,
    generation: number,
  ) => {
    const session = await loadSession().catch(() => null);
    if (!session || generation !== accountGenerationRef.current) return;
    providerAuthSyncRevisionRef.current += 1;
    setProviderAuthSyncIntent({
      accountId: session.accountId,
      deviceId: session.deviceId,
      providerId,
      reason,
      revision: providerAuthSyncRevisionRef.current,
    });
  }, []);

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
      if (isCancelled() || !authSyncGuard.canApplyRefresh(refreshToken)) return false;
      setDesktopAuthState(nextState);
      setDesktopAuthError(null);
      return true;
    } catch (error) {
      if (isCancelled() || !authSyncGuard.canApplyRefresh(refreshToken)) return false;
      setDesktopAuthError(error instanceof Error ? error.message : 'Unable to load desktop auth');
      return false;
    }
  }, [authSyncGuard]);

  const refreshDesktopAuth = useCallback(async (
    reason?: DesktopAuthUpdateReason,
    providerId?: string,
  ) => {
    const generation = accountGenerationRef.current;
    const applied = await loadDesktopAuthState();
    if (applied && reason && providerId) {
      await recordProviderAuthSyncIntent(reason, providerId, generation);
    }
  }, [loadDesktopAuthState, recordProviderAuthSyncIntent]);

  const runDesktopAuthMutation = useCallback(async (
    operation: () => Promise<DesktopAuthState>,
    fallbackError: string,
    reason: DesktopAuthUpdateReason,
    providerId: string,
  ) => {
    const generation = accountGenerationRef.current;
    authSyncGuard.beginMutation();
    try {
      setDesktopAuthError(null);
      const nextState = await operation();
      if (generation !== accountGenerationRef.current) return;
      setDesktopAuthState(nextState);
      setDesktopAuthError(null);
      await recordProviderAuthSyncIntent(reason, providerId, generation);
      if (generation !== accountGenerationRef.current) return;
      await broadcastDesktopAuthUpdated(reason, providerId);
    } catch (error) {
      setDesktopAuthError(error instanceof Error ? error.message : fallbackError);
    } finally {
      authSyncGuard.finishMutation();
    }
  }, [authSyncGuard, recordProviderAuthSyncIntent]);

  const handleLogoutProvider = useCallback(async (providerId: string) => {
    await runDesktopAuthMutation(
      () => logoutDesktopProvider(providerId),
      'Unable to log out provider',
      'provider-logout',
      providerId,
    );
  }, [runDesktopAuthMutation]);

  const handleSelectAuthChoice = useCallback(async (providerId: string, choice: string) => {
    await runDesktopAuthMutation(
      () => setDesktopActiveAuthChoice(providerId, choice),
      'Unable to select auth option',
      'active-choice-changed',
      providerId,
    );
  }, [runDesktopAuthMutation]);

  const handleRemoveAuthProfile = useCallback(async (providerId: string, profileId: string) => {
    await runDesktopAuthMutation(
      () => removeDesktopAuthProfile(providerId, profileId),
      'Unable to remove saved auth',
      'profile-removed',
      providerId,
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
  }, [accountId, isNativeShell, loadDesktopAuthState]);

  useEffect(() => {
    if (!isNativeShell) return;

    const refresh = () => {
      void refreshDesktopAuth();
    };
    const resetAccount = () => {
      accountGenerationRef.current += 1;
      authSyncGuard.beginMutation();
      setDesktopAuthState(null);
      setProviderAuthSyncIntent(null);
      setActiveLoginProviderId(null);
      authSyncGuard.finishMutation();
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
        const intent = desktopAuthSyncIntentFromAnotherSource(event.data);
        const generation = accountGenerationRef.current;
        void loadDesktopAuthState().then(async (applied) => {
          const session = await loadSession().catch(() => null);
          if (applied && intent?.accountId === session?.accountId && intent?.deviceId === session?.deviceId && intent) {
            await recordProviderAuthSyncIntent(intent.reason, intent.providerId, generation);
          }
        });
      };
    }

    window.addEventListener('focus', refresh);
    window.addEventListener(CLOUD_SESSION_CHANGED_EVENT, resetAccount);

    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener(CLOUD_SESSION_CHANGED_EVENT, resetAccount);
      channel?.close();
    };
  }, [
    authSyncGuard,
    isNativeShell,
    loadDesktopAuthState,
    recordProviderAuthSyncIntent,
    refreshDesktopAuth,
  ]);

  return {
    desktopAuthState,
    setDesktopAuthState,
    isDesktopAuthLoading,
    desktopAuthError,
    setDesktopAuthError,
    clearDesktopAuthError,
    activeLoginProviderId,
    providerAuthSyncIntent,
    setActiveLoginProviderId,
    selectAuthProvider,
    refreshDesktopAuth,
    handleLogoutProvider,
    handleSelectAuthChoice,
    handleRemoveAuthProfile,
  };
}
