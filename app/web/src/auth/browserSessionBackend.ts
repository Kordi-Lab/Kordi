import type { CloudAccount } from '@/features/cloud/cloudIdentityTypes';
import type { CloudAuthResult } from '@/features/cloud/authClient';
import type { SessionStorageBackend, StoredSession } from '@/features/cloud/session';
import { browserSessionAccountId, browserSessionMarker } from '@web/auth/browserAppRuntime';

type WebSessionResponse = {
  account: CloudAccount;
  session?: { expiresAt?: string; deviceId?: string; organizationId?: string };
};

export function browserAuthResult(result: WebSessionResponse): CloudAuthResult {
  if (!result.account?.accountId) throw new Error('The web session did not return an account.');
  return {
    account: result.account,
    session: {
      token: browserSessionMarker(result.account.accountId),
      // Only display/cache metadata; the server checks actual cookie expiry on every request.
      expiresAt: result.session?.expiresAt ?? new Date(0).toISOString(),
      deviceId: result.session?.deviceId,
    },
  };
}

export class BrowserSessionBackend implements SessionStorageBackend {
  constructor(private readonly fetchImpl: typeof fetch, private readonly baseUrl: string) {}

  async load(): Promise<StoredSession | null> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/cloud/auth/web/session`, {
      method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401) return null;
    if (!response.ok) throw new Error('Could not restore the browser session.');
    const result = await response.json() as WebSessionResponse;
    const auth = browserAuthResult(result);
    return { ...auth.session, accountId: auth.account.accountId, organizationId: result.session?.organizationId };
  }

  save(session: StoredSession): Promise<void> {
    if (browserSessionAccountId(session.token) !== session.accountId || session.refreshToken) {
      return Promise.reject(new Error('Browser sessions must use the HttpOnly session cookie.'));
    }
    return Promise.resolve();
  }

  async clear(): Promise<void> {
    // The login/logout endpoints own cookies. No browser credential is kept in JS storage.
  }

  async switchOrganization(session: StoredSession, organizationId: string): Promise<StoredSession> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/cloud/auth/organization-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ organization_id: organizationId }),
      signal: AbortSignal.timeout(20_000),
    });
    const result = await response.json() as { account_id?: string; device_id?: string; organization_id?: string };
    if (!response.ok) throw new Error(response.status === 401 ? 'not_signed_in' : 'switch_failed');
    if (result.account_id !== session.accountId || (session.deviceId && result.device_id !== session.deviceId)) {
      throw new Error('account_mismatch');
    }
    if (result.organization_id !== organizationId) throw new Error('switch_failed');
    return { ...session, organizationId };
  }
}
