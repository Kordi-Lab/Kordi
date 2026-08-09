import type {
  CloudGroupInvitation,
  CloudGroupInvitationAcceptance,
  CloudGroupInvitationCreateInput,
  CloudGroupInvitationPreview,
} from './cloudIdentityTypes';

type CloudRequestClient = {
  request<TResponse>(path: string, init: RequestInit, fallbackMessage: string): Promise<TResponse>;
};

export function createCloudGroupInvitation(
  client: CloudRequestClient,
  token: string,
  input: CloudGroupInvitationCreateInput,
): Promise<CloudGroupInvitation> {
  return client.request('/v1/cloud/invitations/groups', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  }, 'Could not create group invitation.');
}

export function resolveCloudGroupInvitation(
  client: CloudRequestClient,
  invitationToken: string,
): Promise<CloudGroupInvitationPreview> {
  return client.request(
    `/v1/cloud/invitations/groups/resolve/${encodeURIComponent(invitationToken)}`,
    { method: 'GET' },
    'Could not load group invitation.',
  );
}

export function acceptCloudGroupInvitation(
  client: CloudRequestClient,
  token: string,
  invitationToken: string,
): Promise<CloudGroupInvitationAcceptance> {
  return client.request(
    `/v1/cloud/invitations/groups/accept/${encodeURIComponent(invitationToken)}`,
    { method: 'POST', headers: { authorization: `Bearer ${token}` } },
    'Could not join group.',
  );
}

export async function revokeCloudGroupInvitation(
  client: CloudRequestClient,
  token: string,
  invitationId: string,
): Promise<void> {
  await client.request(
    `/v1/cloud/invitations/groups/${encodeURIComponent(invitationId)}`,
    { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
    'Could not revoke group invitation.',
  );
}
