import type { CloudAuthClient } from './authClient';
import { cloudApiBaseUrl } from './cloudApiEnvironment';
import type { CloudAttachmentPlaybackResult } from './cloudAttachmentTypes';

export async function cloudAttachmentPlaybackUrl(
  client: Pick<CloudAuthClient, 'request'>,
  token: string,
  attachmentId: string,
  baseUrl = cloudApiBaseUrl(),
) {
  const result = await client.request<CloudAttachmentPlaybackResult>(
    `/v1/cloud/attachments/${encodeURIComponent(attachmentId)}/playback`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    },
    'Could not prepare video playback.',
  );
  return new URL(result.playbackPath, baseUrl).toString();
}
