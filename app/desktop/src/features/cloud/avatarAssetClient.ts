import { avatarDataUrlBlob, type CanonicalAvatarMutation } from './canonicalAvatar';

type CloudRequest = <TResponse>(
  path: string,
  init: RequestInit,
  fallbackMessage: string,
) => Promise<TResponse>;

export async function uploadCloudAvatarAsset({
  request, token, entityType, entityId, dataUrl,
}: {
  request: CloudRequest;
  token: string;
  entityType: 'human' | 'agent';
  entityId: string;
  dataUrl: string;
}) {
  const blob = avatarDataUrlBlob(dataUrl);
  const params = new URLSearchParams({ entityType, entityId });
  const response = await request<{ uploadedAsset: string }>(
    `/v1/cloud/avatar-assets?${params.toString()}`,
    {
      method: 'POST',
      headers: { 'content-type': blob.type, authorization: `Bearer ${token}` },
      body: blob,
    },
    'Could not upload the avatar.',
  );
  if (!response.uploadedAsset) throw new Error('Avatar upload response was invalid.');
  return response.uploadedAsset;
}

export async function referenceBackedAvatarMutation({
  request, token, entityType, entityId, mutation,
}: {
  request: CloudRequest;
  token: string;
  entityType: 'human' | 'agent';
  entityId: string | null;
  mutation: CanonicalAvatarMutation | undefined;
}): Promise<CanonicalAvatarMutation | undefined> {
  if (
    mutation?.action !== 'upload'
    || !mutation.uploadedAsset?.startsWith('data:image/')
  ) return mutation;
  if (!entityId) throw new Error('Cloud account identity is unavailable.');
  return {
    ...mutation,
    uploadedAsset: await uploadCloudAvatarAsset({
      request,
      token,
      entityType,
      entityId,
      dataUrl: mutation.uploadedAsset,
    }),
  };
}
