import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  CloudAuthClient,
  CloudAuthError,
  defaultCloudAuthClient,
  type CloudAccount,
} from './authClient';
import { ensureCloudDeviceRegistered } from './deviceRegistration';
import {
  clearSession,
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
    avatarSeed?: string;
  }): Promise<void>;
  signOut(): Promise<void>;
  clearError(): void;
};

export type UseCloudSessionOptions = {
  client?: CloudAuthClient;
  /** When false, skip bootstrap (network + keychain) — useful when caller is
   * supplying a stubbed session value externally. */
  enabled?: boolean;
};

export function useCloudSession({
  client,
  enabled = true,
}: UseCloudSessionOptions = {}): UseCloudSessionResult {
  const authClient = useMemo(() => client ?? defaultCloudAuthClient(), [client]);
  const [status, setStatus] = useState<CloudSessionStatus>(enabled ? 'loading' : 'signed-out');
  const [account, setAccount] = useState<CloudAccount | null>(null);
  const [error, setError] = useState<CloudAuthError | null>(null);
  const mountedRef = useRef(true);

  const setAuthenticated = useCallback((next: CloudAccount) => {
    if (!mountedRef.current) return;
    setAccount(next);
    setStatus('authenticated');
    setError(null);
  }, []);

  const setSignedOut = useCallback(() => {
    if (!mountedRef.current) return;
    setAccount(null);
    setStatus('signed-out');
  }, []);

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
        const stored = await loadSession();
        if (!stored) {
          if (!cancelled && mountedRef.current) setStatus('signed-out');
          return;
        }
        try {
          const me = await authClient.me(stored.token);
          if (!cancelled && mountedRef.current) setAuthenticated(me);
          // Best-effort device registration on bootstrap. We don't await its
          // failure path — if the bridges register call fails, the user is
          // still authenticated; we'll retry next sign-in or app launch.
          void ensureCloudDeviceRegistered({
            accountId: me.accountId,
            sessionToken: stored.token,
            client: authClient,
            account: me,
          }).catch(() => {});
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
  }, [authClient, enabled, setAuthenticated, setSignedOut]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      try {
        const result = await authClient.login({ email, password });
        await saveSession({
          token: result.session.token,
          accountId: result.account.accountId,
          expiresAt: result.session.expiresAt,
        });
        setAuthenticated(result.account);
        void ensureCloudDeviceRegistered({
          accountId: result.account.accountId,
          sessionToken: result.session.token,
          client: authClient,
          account: result.account,
        }).catch(() => {});
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
    [authClient, setAuthenticated],
  );

  const signUp = useCallback<UseCloudSessionResult['signUp']>(
    async ({ email, password, displayName, avatarSeed }) => {
      try {
        const result = await authClient.signup({ email, password, displayName, avatarSeed });
        await saveSession({
          token: result.session.token,
          accountId: result.account.accountId,
          expiresAt: result.session.expiresAt,
        });
        setAuthenticated(result.account);
        void ensureCloudDeviceRegistered({
          accountId: result.account.accountId,
          sessionToken: result.session.token,
          client: authClient,
          account: result.account,
        }).catch(() => {});
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
      await clearSession();
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
    signOut,
    clearError,
  };
}
