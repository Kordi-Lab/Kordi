import { cloudApiBaseUrl } from '@/features/cloud/cloudApiEnvironment';
import { baseCloudFetchImpl, defaultCloudRequestTimeoutMs } from '@/features/cloud/cloudTransport';

export type CloudOrganizationKind = 'personal' | 'team';
export type CloudOrganizationRole = 'owner' | 'admin' | 'member';

/** One organization the signed-in account belongs to. */
export type CloudOrganization = {
  organizationId: string;
  name: string;
  kind: CloudOrganizationKind;
  role: CloudOrganizationRole;
  memberCount: number;
};

export type CloudOrganizationClientOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOrganization(value: unknown): CloudOrganization | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const organizationId = text(record.organizationId);
  const kind = text(record.kind);
  if (!organizationId || (kind !== 'personal' && kind !== 'team')) return null;
  const role = text(record.role);
  return {
    organizationId,
    name: text(record.name) || (kind === 'personal' ? 'Personal' : organizationId),
    kind,
    role: role === 'owner' || role === 'admin' ? role : 'member',
    memberCount: typeof record.memberCount === 'number' ? record.memberCount : 1,
  };
}

/** Valid organizations from a list response, personal first, without duplicates. */
export function normalizeCloudOrganizations(body: unknown): CloudOrganization[] {
  const list = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as { organizations?: unknown }).organizations
    : null;
  const seen = new Set<string>();
  const organizations = (Array.isArray(list) ? list : [])
    .map(normalizeOrganization)
    .filter((organization): organization is CloudOrganization => {
      if (!organization || seen.has(organization.organizationId)) return false;
      seen.add(organization.organizationId);
      return true;
    });
  return [
    ...organizations.filter((organization) => organization.kind === 'personal'),
    ...organizations.filter((organization) => organization.kind === 'team'),
  ];
}

export async function fetchCloudOrganizations(
  token: string,
  options: CloudOrganizationClientOptions = {},
): Promise<CloudOrganization[]> {
  const baseUrl = options.baseUrl ?? cloudApiBaseUrl();
  // An account route: sent without the organization header, so recovering
  // from an organization mismatch can always read the current list.
  const fetchImpl = options.fetchImpl ?? baseCloudFetchImpl();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.requestTimeoutMs ?? defaultCloudRequestTimeoutMs(baseUrl),
  );
  try {
    const response = await fetchImpl(`${baseUrl}/v1/cloud/organizations`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Organization list failed: ${response.status}`);
    return normalizeCloudOrganizations(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}
