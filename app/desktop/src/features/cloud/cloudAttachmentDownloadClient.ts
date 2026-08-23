import { buildCloudAuthError, CloudAuthError } from './cloudAuthError';

export async function downloadCloudAttachmentBlob({
  baseUrl,
  fetchImpl,
  token,
  attachmentId,
  resource,
  signal,
}: {
  baseUrl: string;
  fetchImpl: typeof fetch;
  token: string;
  attachmentId: string;
  resource: 'content' | 'preview-content';
  signal?: AbortSignal;
}) {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/v1/cloud/attachments/${encodeURIComponent(attachmentId)}/${resource}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'Network request failed.';
    throw new CloudAuthError('network_error', message, 0);
  }
  if (!response.ok) {
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    throw buildCloudAuthError(
      response.status,
      body,
      resource === 'content' ? 'Could not download attachment.' : 'Could not download attachment preview.',
    );
  }
  return response.blob();
}
