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
  closeCloudWebSocketQuietly,
  cloudWebSocketUrl,
  cloudWebSocketsEnabled,
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

const CLOUD_PROFILE_REFRESH_INTERVAL_MS = 15_000;
const CLOUD_PROFILE_UPDATED_SUBJECT_PREFIX = 'kordi.events.account.profile.updated.';

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function shouldRefreshCloudSessionProfileForWsSubject(subject: string | undefined | null, accountId: string | undefined | null): boolean {
  const cleanAccountId = accountId?.trim();
  return Boolean(cleanAccountId && subject === `${CLOUD_PROFILE_UPDATED_SUBJECT_PREFIX}${cleanAccountId}`);
}

export function applyCloudSessionProfileUpdate(account: CloudAccount | null, payload: unknown): CloudAccount | null {
  if (!account) return null;
  const record = objectRecord(payload);
  if (record?.account_id !== account.accountId) return null;
  const displayName = typeof record.display_name === 'string' ? record.display_name : account.displayName;
  const avatarUrl = typeof record.avatar_url === 'string' ? record.avatar_url : account.avatarUrl;
  return {
    ...account,
    displayName,
    avatarUrl,
  };
}

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
  }) => Promise<unknown>;
  reloadWindow?: () => void;
};

export async function completeCloudAuthResult({
  result,
  currentAccountId,
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
  const switchedAuthenticatedAccount = Boolean(
    activation.storageRoot && currentAccountId && currentAccountId !== result.account.accountId,
  );
  if (activation.requiresReload || switchedAuthenticatedAccount) {
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
  const accountRef = useRef<CloudAccount | null>(null);

  const setAuthenticated = useCallback((next: CloudAccount) => {
    accountIdRef.current = next.accountId;
    accountRef.current = next;
    if (!mountedRef.current) return;
    setAccount(next);
    setStatus('authenticated');
    setError(null);
  }, []);

  const setSignedOut = useCallback(() => {
    accountIdRef.current = null;
    accountRef.current = null;
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
    if (!enabled || status !== 'authenticated' || !account?.accountId || typeof window === 'undefined') return;
    let cancelled = false;

    const refreshAccount = async () => {
      try {
        const stored = await loadSession();
        if (!stored?.token || cancelled) return;
        const next = await authClient.me(stored.token);
        if (!cancelled && next.accountId === account.accountId) setAuthenticated(next);
      } catch {
        // Session bootstrap/sign-out owns auth failure handling. Profile sync is
        // best-effort so temporary network errors do not kick users out.
      }
    };

    const timer = window.setInterval(() => { void refreshAccount(); }, CLOUD_PROFILE_REFRESH_INTERVAL_MS);
    window.addEventListener('focus', refreshAccount);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshAccount);
    };
  }, [account?.accountId, authClient, enabled, setAuthenticated, status]);

  useEffect(() => {
    if (!enabled || status !== 'authenticated' || !account?.accountId || typeof WebSocket === 'undefined' || !cloudWebSocketsEnabled()) return;
    let cancelled = false;
    let ws: WebSocket | null = null;

    void loadSession()
      .then((stored) => {
        if (cancelled || !stored?.token) return;
        ws = new WebSocket(cloudWebSocketUrl(stored.token));
        ws.onmessage = (event) => {
          try {
            const frame = JSON.parse(typeof event.data === 'string' ? event.data : '');
            const subject = typeof frame?.subject === 'string' ? frame.subject : '';
            if (!shouldRefreshCloudSessionProfileForWsSubject(subject, account.accountId)) return;
            const patched = applyCloudSessionProfileUpdate(accountRef.current, frame?.payload);
            if (patched) {
              setAuthenticated(patched);
              return;
            }
            void authClient.me(stored.token).then((next) => {
              if (!cancelled && next.accountId === account.accountId) setAuthenticated(next);
            }).catch(() => undefined);
          } catch {
            // Ignore malformed frames. The polling fallback will repair stale profile state.
          }
        };
        ws.onclose = () => {
          if (ws) ws = null;
        };
        ws.onerror = () => {
          closeCloudWebSocketQuietly(ws);
        };
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      closeCloudWebSocketQuietly(ws);
    };
  }, [account?.accountId, authClient, enabled, setAuthenticated, status]);

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
