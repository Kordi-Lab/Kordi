import { useCallback, type RefObject } from 'react';

import { requestAccountEmailCode, verifyAccountEmail } from './accountEmailVerificationClient';
import type { CloudAuthClient } from './authClient';
import { CloudAuthError } from './cloudAuthError';
import type { CloudAccount } from './cloudIdentityTypes';
import { loadSession as loadStoredSession } from './session';
import type { CloudAccountEmailVerificationInput, CloudSignupCodeChallenge } from './signupEmailTypes';

export type CloudAccountEmailVerificationActions = {
  requestAccountEmailCode(this: void): Promise<CloudSignupCodeChallenge>;
  verifyAccountEmail(this: void, input: CloudAccountEmailVerificationInput): Promise<void>;
  /** Reloads the account after the server reports its email as verified. */
  refreshAccountEmailVerified(this: void): Promise<void>;
};

type Options = {
  authClient: Pick<CloudAuthClient, 'request' | 'me'>;
  accountRef: RefObject<CloudAccount | null>;
  setAuthenticated: (account: CloudAccount) => void;
  loadSession?: typeof loadStoredSession;
};

export function useCloudAccountEmailVerification({
  authClient,
  accountRef,
  setAuthenticated,
  loadSession = loadStoredSession,
}: Options): CloudAccountEmailVerificationActions {
  const sessionToken = useCallback(async () => {
    const stored = await loadSession();
    if (!stored?.token) throw new CloudAuthError('invalid_session', 'Not signed in.', 401);
    return stored.token;
  }, [loadSession]);

  const requestCode = useCallback(
    async () => requestAccountEmailCode(authClient, await sessionToken()),
    [authClient, sessionToken],
  );

  const refreshAccountEmailVerified = useCallback(async () => {
    const stored = await loadSession();
    let next: CloudAccount | null = null;
    try {
      if (stored?.token) next = await authClient.me(stored.token);
    } catch {
      // The server already confirmed the email; the periodic profile refresh repairs anything else.
    }
    const current = accountRef.current;
    if (next && next.accountId === current?.accountId) setAuthenticated(next);
    else if (current) setAuthenticated({ ...current, primaryEmailVerified: true });
  }, [accountRef, authClient, loadSession, setAuthenticated]);

  const verify = useCallback(async (input: CloudAccountEmailVerificationInput) => {
    await verifyAccountEmail(authClient, await sessionToken(), input);
    await refreshAccountEmailVerified();
  }, [authClient, refreshAccountEmailVerified, sessionToken]);

  return { requestAccountEmailCode: requestCode, verifyAccountEmail: verify, refreshAccountEmailVerified };
}
