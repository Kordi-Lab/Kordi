// Typed calls for `GET`/`PUT /v1/cloud/contacts/{accountId}/permissions`: per-person restrictions on
// using the viewer's agents and seeing the viewer's card. The other person is never told.

import {
  authorizedRequest,
  contactPath,
  normalizeContactPermissionFlags,
  type CloudContactPermissionFlags,
  type FetchContactProfileOptions,
} from './contactProfileClient';

export type CloudContactPermissions = CloudContactPermissionFlags & {
  accountId: string;
  updatedAt: string | null;
};

/** Either key may be left out to keep the stored value. */
export type CloudContactPermissionsPatch = Partial<CloudContactPermissionFlags>;

/** Contact permissions route version a server advertises, or null when it offers none. */
export function contactPermissionsVersionFromCapabilities(
  capabilities: { contactPermissionsVersion?: number | null } | null | undefined,
): number | null {
  const version = capabilities?.contactPermissionsVersion;
  return typeof version === 'number' && version > 0 ? version : null;
}

export function normalizeContactPermissions(value: unknown, fallbackAccountId: string): CloudContactPermissions | null {
  const flags = normalizeContactPermissionFlags(value);
  if (!flags) return null;
  const row = value as Record<string, unknown>;
  const accountId = typeof row.accountId === 'string' && row.accountId.trim() ? row.accountId.trim() : fallbackAccountId;
  const updatedAt = typeof row.updatedAt === 'string' && row.updatedAt.trim() ? row.updatedAt.trim() : null;
  return { accountId, ...flags, updatedAt };
}

export async function fetchContactPermissions(accountId: string, options: FetchContactProfileOptions = {}): Promise<CloudContactPermissions> {
  const body = await authorizedRequest<unknown>(`${contactPath(accountId)}/permissions`, 'GET', options, 'Could not load permissions.');
  const permissions = normalizeContactPermissions(body, accountId.trim());
  if (!permissions) throw new Error('Could not load permissions.');
  return permissions;
}

export async function updateContactPermissions(
  accountId: string,
  patch: CloudContactPermissionsPatch,
  options: FetchContactProfileOptions = {},
): Promise<CloudContactPermissions> {
  const body: CloudContactPermissionsPatch = {};
  if (typeof patch.agentAccess === 'boolean') body.agentAccess = patch.agentAccess;
  if (typeof patch.cardAccess === 'boolean') body.cardAccess = patch.cardAccess;
  const response = await authorizedRequest<unknown>(
    `${contactPath(accountId)}/permissions`, 'PUT', options, 'Could not save permissions.', body,
  );
  const permissions = normalizeContactPermissions(response, accountId.trim());
  if (!permissions) throw new Error('Could not save permissions.');
  return permissions;
}

/** `GET /v1/cloud/contacts/permissions`: everyone the signed-in owner restricted in any way. */
export async function fetchRestrictedPeople(options: FetchContactProfileOptions = {}): Promise<CloudContactPermissions[]> {
  const body = await authorizedRequest<unknown>('/v1/cloud/contacts/permissions', 'GET', options, 'Could not load permissions.');
  const people = (body as { people?: unknown } | null)?.people;
  if (!Array.isArray(people)) return [];
  return people.flatMap((row) => {
    const permissions = normalizeContactPermissions(row, '');
    return permissions?.accountId ? [permissions] : [];
  });
}
