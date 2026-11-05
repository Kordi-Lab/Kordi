// Organizations the signed-in account can join by the domain of its verified
// email, and the two ways in: an organization email code (a direct join) or a
// join request an admin approves. Account routes: sent without the
// organization header.
import { cloudApiBaseUrl } from '@/features/cloud/cloudApiEnvironment';
import { baseCloudFetchImpl, defaultCloudRequestTimeoutMs } from '@/features/cloud/cloudTransport';
import { loadSession } from '@/features/cloud/session';

export type JoinRequestField = { key: string; label: string; required: boolean; maxLength: number };

export type JoinableOrganization = {
  /** The configured organization id the account routes take. */
  id: string;
  organizationId: string;
  name: string;
  memberCount: number;
  /** Joins at once with an email code sent to the verified email. */
  canJoin: boolean;
  /** An admin approves a request. */
  canRequest: boolean;
  /** The account already has an open join request. */
  requested: boolean;
  joinRequestFields: JoinRequestField[];
};

export type JoinableOrganizations = {
  email: string | null;
  emailDomain: string | null;
  organizations: JoinableOrganization[];
};

export type OrganizationJoinClientOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  token?: string;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizeField(value: unknown): JoinRequestField | null {
  const field = record(value);
  const key = text(field?.key);
  if (!field || !key) return null;
  return {
    key,
    label: text(field.label) || key,
    required: field.required === true,
    maxLength: typeof field.maxLength === 'number' && field.maxLength > 0 ? field.maxLength : 1000,
  };
}

function normalizeJoinable(value: unknown): JoinableOrganization | null {
  const item = record(value);
  const id = text(item?.id);
  const name = text(item?.name);
  if (!item || !id || !name) return null;
  const options = record(item.joinOptions);
  const requested = item.requested === true;
  const canJoin = !requested && options?.emailCode === true;
  const canRequest = !requested && options?.joinRequest === true;
  if (!requested && !canJoin && !canRequest) return null;
  return {
    id,
    organizationId: text(item.organizationId),
    name,
    memberCount: typeof item.memberCount === 'number' ? Math.max(0, item.memberCount) : 0,
    canJoin,
    canRequest,
    requested,
    joinRequestFields: (Array.isArray(item.joinRequestFields) ? item.joinRequestFields : [])
      .map(normalizeField)
      .filter((field): field is JoinRequestField => field !== null),
  };
}

export function normalizeJoinableOrganizations(body: unknown): JoinableOrganizations {
  const value = record(body);
  const seen = new Set<string>();
  const organizations = (Array.isArray(value?.organizations) ? value.organizations : [])
    .map(normalizeJoinable)
    .filter((organization): organization is JoinableOrganization => {
      if (!organization || seen.has(organization.id)) return false;
      seen.add(organization.id);
      return true;
    });
  return {
    email: text(value?.email) || null,
    emailDomain: text(value?.emailDomain) || null,
    organizations,
  };
}

async function sessionToken(options: OrganizationJoinClientOptions): Promise<string> {
  const token = options.token ?? (await loadSession())?.token;
  if (!token) throw new Error('Sign in to join an organization.');
  return token;
}

async function call(path: string, body: unknown, options: OrganizationJoinClientOptions): Promise<unknown> {
  const baseUrl = options.baseUrl ?? cloudApiBaseUrl();
  const fetchImpl = options.fetchImpl ?? baseCloudFetchImpl();
  const token = await sessionToken(options);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), defaultCloudRequestTimeoutMs(baseUrl));
  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined
        ? { authorization: `Bearer ${token}` }
        : { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const parsed: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(text(record(parsed)?.message) || 'Something went wrong. Try again.');
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

function accountPath(organization: Pick<JoinableOrganization, 'id'>, suffix: string): string {
  return `/v1/cloud/account/organizations/${encodeURIComponent(organization.id)}/${suffix}`;
}

export async function fetchJoinableOrganizations(options: OrganizationJoinClientOptions = {}): Promise<JoinableOrganizations> {
  return normalizeJoinableOrganizations(await call('/v1/cloud/account/joinable-organizations', undefined, options));
}

/** Sends an organization email code to `email`; returns the verification id. */
export async function sendOrganizationEmailCode(
  organization: Pick<JoinableOrganization, 'id'>,
  email: string,
  options: OrganizationJoinClientOptions = {},
): Promise<string> {
  const body = await call(accountPath(organization, 'email-code'), { email }, options);
  const verificationId = text(record(body)?.verificationId);
  if (!verificationId) throw new Error('Could not send the email code. Try again.');
  return verificationId;
}

export async function verifyOrganizationEmailCode(
  organization: Pick<JoinableOrganization, 'id'>,
  verificationId: string,
  verificationCode: string,
  options: OrganizationJoinClientOptions = {},
): Promise<void> {
  await call(accountPath(organization, 'email-code/verify'), { verificationId, verificationCode }, options);
}

export async function submitOrganizationJoinRequest(
  organization: Pick<JoinableOrganization, 'id'>,
  fields: Record<string, string>,
  options: OrganizationJoinClientOptions = {},
): Promise<void> {
  await call(accountPath(organization, 'join-requests'), { fields }, options);
}
