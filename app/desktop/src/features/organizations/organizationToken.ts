// Organization token exchange for sessions kept outside the native shell
// (browser previews and tests). The desktop app switches in Rust instead
// (`cloud_session_switch_organization`), with the same error codes.
import type { StoredSession } from '@/features/cloud/session';

export const ORGANIZATION_TOKEN_PATH = '/v1/cloud/auth/organization-token';
const APP_TOKEN_PATH = '/v1/cloud/auth/app/token';

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function errorCodeFor(status: number, body: unknown): string {
  const errorCode = body && typeof body === 'object' ? text((body as { errorCode?: unknown }).errorCode) : null;
  if (status === 404 && errorCode === 'organization_not_found') return 'organization_not_found';
  if (status === 404 || status === 405) return 'unsupported';
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  return 'switch_failed';
}

/** The session after a switch response. Throws a stable code unless it names the same account and device. */
export function switchedSession(
  start: StoredSession,
  organizationId: string,
  status: number,
  body: unknown,
  now: number,
): StoredSession {
  if (status < 200 || status >= 300) throw new Error(errorCodeFor(status, body));
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  if (text(record.account_id) !== start.accountId) throw new Error('account_mismatch');
  const deviceId = text(record.device_id);
  if (start.deviceId && deviceId && deviceId !== start.deviceId) throw new Error('account_mismatch');
  if (text(record.organization_id) !== organizationId) throw new Error('switch_failed');
  const token = text(record.access_token);
  if (!token) throw new Error('switch_failed');
  const expiresIn = typeof record.expires_in === 'number' ? record.expires_in : 0;
  return {
    ...start,
    token,
    expiresAt: expiresIn > 0 ? new Date(now + expiresIn * 1000).toISOString() : start.expiresAt,
    organizationId,
  };
}

function switchEndpoint(session: StoredSession, baseUrl: string): string {
  const base = session.tokenEndpoint?.endsWith(APP_TOKEN_PATH)
    ? session.tokenEndpoint.slice(0, -APP_TOKEN_PATH.length)
    : baseUrl;
  return `${base.replace(/\/+$/, '')}${ORGANIZATION_TOKEN_PATH}`;
}

export async function exchangeOrganizationToken(
  session: StoredSession,
  organizationId: string,
  fetchImpl: typeof fetch,
  baseUrl: string,
  now: () => number = Date.now,
): Promise<StoredSession> {
  let response: Response;
  try {
    response = await fetchImpl(switchEndpoint(session, baseUrl), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${session.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ organization_id: organizationId }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error('network_error');
  }
  const body: unknown = await response.json().catch(() => null);
  return switchedSession(session, organizationId, response.status, body, now());
}
