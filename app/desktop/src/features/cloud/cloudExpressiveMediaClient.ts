import type {
  CloudExpressiveMediaItem,
  CloudExpressiveMediaListResponse,
  CloudExpressiveMediaMutationResponse,
} from './cloudAttachmentTypes';

type CloudExpressiveMediaRequest = <TResponse>(
  path: string,
  init: RequestInit,
  fallbackMessage: string,
) => Promise<TResponse>;

export class CloudExpressiveMediaClient {
  constructor(private readonly request: CloudExpressiveMediaRequest) {}

  async list(token: string): Promise<CloudExpressiveMediaItem[]> {
    const response = await this.request<CloudExpressiveMediaListResponse>(
      '/v1/cloud/expressive-media',
      { method: 'GET', headers: { authorization: `Bearer ${token}` } },
      'Could not synchronize your saved stickers and GIFs.',
    );
    return response.items;
  }

  async save(
    token: string,
    input: Pick<CloudExpressiveMediaItem, 'attachmentId' | 'kind' | 'name'>,
  ): Promise<CloudExpressiveMediaItem> {
    const response = await this.request<CloudExpressiveMediaMutationResponse>(
      '/v1/cloud/expressive-media',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(input),
      },
      'Could not synchronize this saved media.',
    );
    return response.item;
  }

  delete(token: string, mediaId: string): Promise<void> {
    return this.request<void>(
      `/v1/cloud/expressive-media/${encodeURIComponent(mediaId)}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
      'Could not delete this saved media.',
    );
  }
}
