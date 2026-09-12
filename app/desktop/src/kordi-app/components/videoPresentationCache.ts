import { acquireCloudAttachmentPreviewLease, retainCloudAttachmentPreviewResource } from '@/features/cloud/cloudAttachmentPreviewCache';

type CachedVideoPresentation = {
  widthPixels: number;
  heightPixels: number;
};

export const videoPresentationCache = new Map<string, CachedVideoPresentation>();

export function cacheVideoPresentation(key: string, presentation: CachedVideoPresentation & { posterUrl: string }) {
  videoPresentationCache.delete(key);
  videoPresentationCache.set(key, { widthPixels: presentation.widthPixels, heightPixels: presentation.heightPixels });
  // Blob posters belong to the download cache and its active leases. Never keep
  // an unleased copy of a blob URL in this metadata cache.
  if (!presentation.posterUrl.startsWith('blob:')) {
    const resource = retainCloudAttachmentPreviewResource(`video-poster:${key}`, presentation.posterUrl,
      presentation.posterUrl.length * 2 + presentation.widthPixels * presentation.heightPixels * 4);
    acquireCloudAttachmentPreviewLease(resource).release();
  }
  while (videoPresentationCache.size > 128) {
    const oldest = videoPresentationCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    videoPresentationCache.delete(oldest);
  }
}
