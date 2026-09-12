import { convertFileSrc } from '@tauri-apps/api/core';

import {
  isAnimatedGifAttachment,
  isMp4VideoAttachment,
} from '@/features/chat/attachmentMediaGallery';
import { isNativeDesktopShell } from '@/lib/desktop';
import type { CloudAuthClient, CloudMessageAttachment } from './authClient';
import {
  cloudAttachmentPreviewCacheId,
  loadCachedCloudAttachmentLocalPath,
  persistCloudAttachmentBytes,
} from './cloudAttachmentLocalPathCache';

export type PreviewDownloadClient = Pick<CloudAuthClient, 'downloadAttachmentContent'>
  & Partial<Pick<CloudAuthClient, 'downloadAttachmentPreviewContent'>>;
export type CloudAttachmentPreviewTarget = Pick<
  CloudMessageAttachment,
  'attachmentId' | 'previewAttachmentId' | 'name' | 'kind' | 'mimeType'
> & Partial<Pick<CloudMessageAttachment, 'sizeBytes' | 'widthPixels' | 'heightPixels'>>;

// Includes encoded bytes and a conservative single decoded frame when source
// dimensions are available. Animation frames and WebKit/GPU overhead vary.
export function cloudPreviewMemoryCost(attachment: CloudAttachmentPreviewTarget, encodedBytes: number) {
  const width = attachment.widthPixels ?? 0;
  const height = attachment.heightPixels ?? 0;
  const frameBytes = Number.isFinite(width) && Number.isFinite(height)
    && width > 0 && height > 0 ? width * height * 4 : 0;
  return Math.max(0, encodedBytes) + frameBytes;
}

export async function loadCloudAttachmentPreview({
  token,
  client,
  attachment,
  signal,
  createObjectUrl = (blob) => URL.createObjectURL(blob),
  onMemoryCost,
}: {
  token: string;
  client: PreviewDownloadClient;
  attachment: CloudAttachmentPreviewTarget;
  signal?: AbortSignal;
  createObjectUrl?: (blob: Blob) => string;
  onMemoryCost?: (bytes: number) => void;
}) {
  const isVideo = isMp4VideoAttachment(attachment);
  if (attachment.kind !== 'image' && !isVideo) return null;
  const previewCacheId = cloudAttachmentPreviewCacheId(
    attachment.attachmentId,
    attachment.previewAttachmentId,
  );
  const previewCacheName = isVideo ? `${attachment.name}.preview.jpg` : attachment.name;
  if (isNativeDesktopShell()) {
    const cachedPath = await loadCachedCloudAttachmentLocalPath(previewCacheId, previewCacheName);
    if (cachedPath) {
      onMemoryCost?.(cloudPreviewMemoryCost(attachment, attachment.sizeBytes ?? 1024 * 1024));
      return convertFileSrc(cachedPath);
    }
  }
  const isAnimatedGif = isAnimatedGifAttachment(attachment);
  const contentAttachmentId = isVideo || isAnimatedGif
    ? attachment.attachmentId?.trim()
    : attachment.previewAttachmentId?.trim() || attachment.attachmentId?.trim();
  if (!contentAttachmentId) return null;
  const previewBlob = !isAnimatedGif && client.downloadAttachmentPreviewContent
    ? await client.downloadAttachmentPreviewContent(token, contentAttachmentId, signal).catch(() => null)
    : null;
  const blob = previewBlob
    ?? await client.downloadAttachmentContent(token, contentAttachmentId, signal);
  if (signal?.aborted) {
    const error = new Error('Attachment preview request was aborted.');
    error.name = 'AbortError';
    throw error;
  }
  if (isNativeDesktopShell()) {
    await persistCloudAttachmentBytes(previewCacheId, previewCacheName, blob);
  }
  onMemoryCost?.(cloudPreviewMemoryCost(attachment, blob.size));
  return createObjectUrl(blob);
}
