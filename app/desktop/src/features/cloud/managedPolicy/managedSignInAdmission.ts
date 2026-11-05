// Enforces the managed organization policy on sessions
// (docs/development/managed-devices.md): a new sign-in is admitted only after
// the membership check passes, and a restored or refreshed session that no
// longer qualifies is signed out locally.

import type { CloudAuthResult } from '../authClient';
import { revokeAppSignIn, type AppSignInRefresh } from '../appSignIn/appSignInClient';
import { CloudAuthError } from '../cloudAuthError';
import { cloudApiBaseUrl } from '../cloudApiEnvironment';
import { cloudFetchImpl } from '../cloudTransport';
import { clearSessionAndNotifySignedOut, type StoredSession } from '../session';
import {
  accountSatisfiesPolicy,
  loadManagedSignInPolicy,
  MANAGED_ORGANIZATION_CHECK_FAILED_MESSAGE,
  MANAGED_ORGANIZATION_REFUSED_MESSAGE,
  MANAGED_SIGNED_OUT_MESSAGE,
  restrictsOrganizations,
  setManagedSignedOutNotice,
  type ManagedSignInPolicy,
} from './managedSignInPolicy';

export const ACCOUNT_ORGANIZATIONS_PATH = '/v1/cloud/account/organizations';
const CHECK_TIMEOUT_MS = 15_000;

/** `failed` means the server gave no usable answer (network, timeout, error status). */
export type ManagedMembership = 'allowed' | 'refused' | 'failed';

export type ManagedAdmissionOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  policy?: ManagedSignInPolicy;
  timeoutMs?: number;
};

function cleanBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/** Endpoint and transport, resolved only when a check actually runs. */
function transport(options: ManagedAdmissionOptions) {
  return {
    baseUrl: cleanBaseUrl(options.baseUrl ?? cloudApiBaseUrl()),
    fetchImpl: options.fetchImpl ?? cloudFetchImpl(),
    timeoutMs: options.timeoutMs ?? CHECK_TIMEOUT_MS,
  };
}

export async function checkManagedMembership(
  token: string,
  options: ManagedAdmissionOptions = {},
): Promise<ManagedMembership> {
  const policy = options.policy ?? await loadManagedSignInPolicy();
  if (!restrictsOrganizations(policy)) return 'allowed';
  const { baseUrl, fetchImpl, timeoutMs } = transport(options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}${ACCOUNT_ORGANIZATIONS_PATH}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return 'failed';
    const body: unknown = JSON.parse(await response.text());
    if (!body || typeof body !== 'object' || !Array.isArray((body as { organizations?: unknown }).organizations)) {
      return 'failed';
    }
    return accountSatisfiesPolicy(body, policy) ? 'allowed' : 'refused';
  } catch {
    return 'failed';
  } finally {
    clearTimeout(timer);
  }
}

async function revokeNewSession(
  result: CloudAuthResult & { refresh?: AppSignInRefresh },
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  try {
    const session: StoredSession = {
      token: result.session.token,
      accountId: result.account.accountId,
      expiresAt: result.session.expiresAt,
      ...result.refresh,
    };
    // Browser sign-ins end through revocation; other sessions through logout.
    if (await revokeAppSignIn(session, fetchImpl)) return;
    await fetchImpl(`${baseUrl}/v1/cloud/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${result.session.token}` },
    });
  } catch {
    // Best effort: the session is never stored either way.
  }
}

/**
 * Runs before a new sign-in is stored. A refused account or a failed check
 * revokes the new session and throws the message the sign-in screen shows.
 */
export async function admitManagedSignIn(
  result: CloudAuthResult & { refresh?: AppSignInRefresh },
  options: ManagedAdmissionOptions = {},
): Promise<void> {
  const policy = options.policy ?? await loadManagedSignInPolicy();
  const membership = await checkManagedMembership(result.session.token, { ...options, policy });
  if (membership === 'allowed') {
    setManagedSignedOutNotice(null);
    return;
  }
  const { baseUrl, fetchImpl } = transport(options);
  await revokeNewSession(result, baseUrl, fetchImpl);
  throw membership === 'refused'
    ? new CloudAuthError('organization_not_allowed', MANAGED_ORGANIZATION_REFUSED_MESSAGE, 0)
    : new CloudAuthError('organization_check_failed', MANAGED_ORGANIZATION_CHECK_FAILED_MESSAGE, 0);
}

/**
 * Checks a restored or refreshed session. Only a definitive refusal returns
 * true (and records the signed-out notice); a failed check keeps the session.
 */
export async function sessionRefusedByManagedPolicy(
  session: Pick<StoredSession, 'token'>,
  options: ManagedAdmissionOptions = {},
): Promise<boolean> {
  if ((await checkManagedMembership(session.token, options)) !== 'refused') return false;
  setManagedSignedOutNotice(MANAGED_SIGNED_OUT_MESSAGE);
  return true;
}

/** App start: signs out locally when the restored session no longer qualifies. */
export async function signOutIfManagedPolicyRefuses(
  session: Pick<StoredSession, 'token'>,
  options: ManagedAdmissionOptions = {},
): Promise<boolean> {
  if (!(await sessionRefusedByManagedPolicy(session, options))) return false;
  await clearSessionAndNotifySignedOut();
  return true;
}
