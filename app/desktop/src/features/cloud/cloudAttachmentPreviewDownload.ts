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
>;

export async function loadCloudAttachmentPreview({
  token,
  client,
  attachment,
  signal,
  createObjectUrl = (blob) => URL.createObjectURL(blob),
}: {
  token: string;
  client: PreviewDownloadClient;
  attachment: CloudAttachmentPreviewTarget;
  signal?: AbortSignal;
  createObjectUrl?: (blob: Blob) => string;
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
    if (cachedPath) return convertFileSrc(cachedPath);
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
  return createObjectUrl(blob);
}
