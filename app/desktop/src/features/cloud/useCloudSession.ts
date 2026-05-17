import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  activateDesktopCloudAccountStorage,
  openDesktopExternalUrl,
  prepareDesktopCloudOAuthLoopback,
  waitForDesktopCloudOAuthLoopback,
  type DesktopCloudAccountStorageActivation,
} from '@/lib/desktop';

import {
  CloudAuthClient,
  CloudAuthError,
  defaultCloudAuthClient,
  parseCloudOAuthHashResult,
  type CloudAccount,
  type CloudAuthResult,
  type CloudOAuthProvider,
  type CloudProfileUpdateInput,
} from './authClient';
import { ensureCloudDeviceRegistered } from './deviceRegistration';
import {
  CLOUD_SESSION_SIGNED_OUT_EVENT,
  clearSession,
  clearSessionAndNotifySignedOut,
  loadSession,
  saveSession,
  type StoredSession,
} from './session';

export type CloudSessionStatus = 'loading' | 'signed-out' | 'authenticated';

export type UseCloudSessionResult = {
  status: CloudSessionStatus;
  account: CloudAccount | null;
  error: CloudAuthError | null;
  signIn(email: string, password: string): Promise<void>;
  signUp(input: {
    email: string;
    password: string;
    displayName?: string;
    avatarUrl?: string;
  }): Promise<void>;
  signInWithProvider(provider: CloudOAuthProvider): Promise<void>;
  updateProfile(input: CloudProfileUpdateInput): Promise<CloudAccount>;
  signOut(): Promise<void>;
  clearError(): void;
};

export type UseCloudSessionOptions = {
  client?: CloudAuthClient;
  /** When false, skip bootstrap (network + keychain) — useful when caller is
   * supplying a stubbed session value externally. */
  enabled?: boolean;
};

type CompleteCloudAuthResultOptions = {
  result: CloudAuthResult;
  currentAccountId: string | null;
  saveSession?: (session: StoredSession) => Promise<void>;
  activateAccountStorage?: (accountId: string) => Promise<DesktopCloudAccountStorageActivation>;
  setAuthenticated: (account: CloudAccount) => void;
  registerDevice: (input: {
    accountId: string;
    sessionToken: string;
    account: CloudAccount;
  }) => Promise<void>;
  reloadWindow?: () => void;
};

export async function completeCloudAuthResult({
  result,
  saveSession: persistSession,
  activateAccountStorage = activateDesktopCloudAccountStorage,
  setAuthenticated: publishAuthenticated,
  registerDevice,
  reloadWindow,
}: CompleteCloudAuthResultOptions): Promise<boolean> {
  const session: StoredSession = {
    token: result.session.token,
    accountId: result.account.accountId,
    expiresAt: result.session.expiresAt,
  };
  if (persistSession) {
    await persistSession(session);
  }
  const activation = await activateAccountStorage(result.account.accountId);
  if (activation.requiresReload) {
    reloadWindow?.();
    return false;
  }
  publishAuthenticated(result.account);
  void registerDevice({
    accountId: result.account.accountId,
    sessionToken: result.session.token,
    account: result.account,
  }).catch(() => {});
  return true;
}

export function useCloudSession({
  client,
  enabled = true,
}: UseCloudSessionOptions = {}): UseCloudSessionResult {
  const authClient = useMemo(() => client ?? defaultCloudAuthClient(), [client]);
  const [status, setStatus] = useState<CloudSessionStatus>(enabled ? 'loading' : 'signed-out');
  const [account, setAccount] = useState<CloudAccount | null>(null);
  const [error, setError] = useState<CloudAuthError | null>(null);
  const mountedRef = useRef(true);
  const accountIdRef = useRef<string | null>(null);

  const setAuthenticated = useCallback((next: CloudAccount) => {
    accountIdRef.current = next.accountId;
    if (!mountedRef.current) return;
    setAccount(next);
    setStatus('authenticated');
    setError(null);
  }, []);

  const setSignedOut = useCallback(() => {
    accountIdRef.current = null;
    if (!mountedRef.current) return;
    setAccount(null);
    setStatus('signed-out');
  }, []);

  const reloadForAccountStorageSwitch = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  }, []);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const handleProfileUpdated = (event: Event) => {
      const next = (event as CustomEvent<CloudAccount>).detail;
      if (next?.accountId) setAuthenticated(next);
    };
    const handleSignedOut = () => setSignedOut();
    window.addEventListener('kordi-cloud-profile-updated', handleProfileUpdated);
    window.addEventListener(CLOUD_SESSION_SIGNED_OUT_EVENT, handleSignedOut);
    return () => {
      window.removeEventListener('kordi-cloud-profile-updated', handleProfileUpdated);
      window.removeEventListener(CLOUD_SESSION_SIGNED_OUT_EVENT, handleSignedOut);
    };
  }, [enabled, setAuthenticated, setSignedOut]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) {
      return () => {
        mountedRef.current = false;
      };
    }
    let cancelled = false;

    async function bootstrap() {
      try {
        const oauthResult = typeof window !== 'undefined' ? parseCloudOAuthHashResult(window.location.hash) : null;
        if (oauthResult) {
          const completed = await completeCloudAuthResult({
            result: oauthResult,
            currentAccountId: accountIdRef.current,
            saveSession,
            setAuthenticated: (next) => {
              if (!cancelled && mountedRef.current) setAuthenticated(next);
            },
            registerDevice: (input) => ensureCloudDeviceRegistered({ ...input, client: authClient }),
            reloadWindow: reloadForAccountStorageSwitch,
          });
          if (typeof window !== 'undefined') {
            const cleanUrl = `${window.location.pathname}${window.location.search}`;
            window.history.replaceState(null, document.title, cleanUrl || '/');
          }
          if (!completed) return;
          return;
        }

        const stored = await loadSession();
        if (!stored) {
          if (!cancelled && mountedRef.current) setStatus('signed-out');
          return;
        }
        try {
          const me = await authClient.me(stored.token);
          // Best-effort device registration on bootstrap. We don't await its
          // failure path — if the bridges register call fails, the user is
          // still authenticated; we'll retry next sign-in or app launch.
          await completeCloudAuthResult({
            result: {
              account: me,
              session: {
                token: stored.token,
                expiresAt: stored.expiresAt,
              },
            },
            currentAccountId: accountIdRef.current,
            setAuthenticated: (next) => {
              if (!cancelled && mountedRef.current) setAuthenticated(next);
            },
            registerDevice: (input) => ensureCloudDeviceRegistered({ ...input, client: authClient }),
            reloadWindow: reloadForAccountStorageSwitch,
          });
        } catch (caught) {
          if (caught instanceof CloudAuthError && caught.status === 401) {
            await clearSession();
          }
          if (!cancelled && mountedRef.current) setSignedOut();
        }
      } catch {
        if (!cancelled && mountedRef.current) setSignedOut();
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
  }, [authClient, enabled, reloadForAccountStorageSwitch, setAuthenticated, setSignedOut]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      try {
        const result = await authClient.login({ email, password });
        await completeCloudAuthResult({
          result,
          currentAccountId: accountIdRef.current,
          saveSession,
          setAuthenticated,
          registerDevice: (input) => ensureCloudDeviceRegistered({ ...input, client: authClient }),
          reloadWindow: reloadForAccountStorageSwitch,
        });
      } catch (caught) {
        if (caught instanceof CloudAuthError) {
          setError(caught);
          throw caught;
        }
        const wrapped = new CloudAuthError(
          'unknown',
          caught instanceof Error ? caught.message : 'Sign-in failed.',
          0,
        );
        setError(wrapped);
        throw wrapped;
      }
    },
    [authClient, reloadForAccountStorageSwitch, setAuthenticated],
  );

  const signUp = useCallback<UseCloudSessionResult['signUp']>(
    async ({ email, password, displayName, avatarUrl }) => {
      try {
        const result = await authClient.signup({ email, password, displayName, avatarUrl });
        await completeCloudAuthResult({
          result,
          currentAccountId: accountIdRef.current,
          saveSession,
          setAuthenticated,
          registerDevice: (input) => ensureCloudDeviceRegistered({ ...input, client: authClient }),
          reloadWindow: reloadForAccountStorageSwitch,
        });
      } catch (caught) {
        if (caught instanceof CloudAuthError) {
          setError(caught);
          throw caught;
        }
        const wrapped = new CloudAuthError(
          'unknown',
          caught instanceof Error ? caught.message : 'Signup failed.',
          0,
        );
        setError(wrapped);
        throw wrapped;
      }
    },
    [authClient, reloadForAccountStorageSwitch, setAuthenticated],
  );

  const signInWithProvider = useCallback(
    async (provider: CloudOAuthProvider) => {
      try {
        const loopback = await prepareDesktopCloudOAuthLoopback();
        if (loopback) {
          const result = await authClient.startOAuth(provider, loopback.redirectUrl);
          await openDesktopExternalUrl(result.authUrl);
          const fragment = await waitForDesktopCloudOAuthLoopback(loopback.requestId);
          const oauthResult = parseCloudOAuthHashResult(fragment);
          if (!oauthResult) {
            throw new CloudAuthError('unknown', 'OAuth sign-in did not return a valid Kordi session.', 0);
          }
          await completeCloudAuthResult({
            result: oauthResult,
            currentAccountId: accountIdRef.current,
            saveSession,
            setAuthenticated,
            registerDevice: (input) => ensureCloudDeviceRegistered({ ...input, client: authClient }),
            reloadWindow: reloadForAccountStorageSwitch,
          });
          return;
        }

        const redirectAfter = typeof window !== 'undefined'
          ? `${window.location.origin}${window.location.pathname}`
          : 'http://127.0.0.1/';
        const result = await authClient.startOAuth(provider, redirectAfter);
        if (typeof window !== 'undefined') {
          window.location.assign(result.authUrl);
        }
      } catch (caught) {
        if (caught instanceof CloudAuthError) {
          setError(caught);
          throw caught;
        }
        const wrapped = new CloudAuthError(
          'unknown',
          caught instanceof Error ? caught.message : 'OAuth sign-in failed.',
          0,
        );
        setError(wrapped);
        throw wrapped;
      }
    },
    [authClient, reloadForAccountStorageSwitch, setAuthenticated],
  );

  const updateProfile = useCallback(
    async (input: CloudProfileUpdateInput) => {
      const stored = await loadSession();
      if (!stored?.token) {
        const missing = new CloudAuthError('invalid_session', 'Not signed in.', 401);
        setError(missing);
        throw missing;
      }
      try {
        const next = await authClient.updateProfile(stored.token, input);
        setAuthenticated(next);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('kordi-cloud-profile-updated', { detail: next }));
        }
        return next;
      } catch (caught) {
        if (caught instanceof CloudAuthError) {
          setError(caught);
          throw caught;
        }
        const wrapped = new CloudAuthError(
          'unknown',
          caught instanceof Error ? caught.message : 'Profile update failed.',
          0,
        );
        setError(wrapped);
        throw wrapped;
      }
    },
    [authClient, setAuthenticated],
  );

  const signOut = useCallback(async () => {
    try {
      const stored = await loadSession();
      if (stored) {
        try {
          await authClient.logout(stored.token);
        } catch {
          // Best-effort: still clear local state below.
        }
      }
    } finally {
      await clearSessionAndNotifySignedOut();
      setSignedOut();
    }
  }, [authClient, setSignedOut]);

  const clearError = useCallback(() => setError(null), []);

  return {
    status,
    account,
    error,
    signIn,
    signUp,
    signInWithProvider,
    updateProfile,
    signOut,
    clearError,
  };
}
