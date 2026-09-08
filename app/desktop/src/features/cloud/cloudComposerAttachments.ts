import type { LivePhoto, LivePhotoResource } from '@/features/chat/livePhotos';
import type { AttachmentItem } from '@/features/chat/composerController.types';
import { isMp4VideoAttachment } from '@/features/chat/attachmentMediaGallery';
import { readDesktopChatAttachment } from '@/lib/desktop';
import type {
  CloudAuthClient,
  SendCloudMessageAttachmentInput,
} from './authClient';
import { blobToDataUrl, createCompressedImagePreviewDataUrl } from './cloudAttachmentPreviewGeneration';
import {
  cacheCloudAttachmentLocalPath,
  persistCloudAttachmentPreviewDataUrl,
  persistCloudAttachmentPath,
} from './cloudAttachmentLocalPathCache';
import {
  isNativeAttachmentUploadAvailable,
  trackLivePhotoUpload,
  uploadNativeCloudAttachment,
} from './cloudAttachmentUpload';
import { safeCloudAttachmentPreviewUrl } from './cloudAttachmentPreviewUrl';

type PreviewGenerator = (
  blob: Blob,
  attachment: {
    name: string;
    kind: 'image' | 'file';
    mimeType?: string | null;
    sizeBytes?: number | null;
  },
) => Promise<string | null>;

export async function uploadComposerAttachments({
  token,
  client,
  attachments,
  readAttachment = readDesktopChatAttachment,
  createPreviewDataUrl = createCompressedImagePreviewDataUrl,
  nativeUpload = uploadNativeCloudAttachment,
  useNativeUpload = isNativeAttachmentUploadAvailable(),
  persistAttachmentPath = persistCloudAttachmentPath,
}: {
  token: string;
  client: Pick<CloudAuthClient, 'uploadAttachment'>
    & Partial<Pick<CloudAuthClient, 'updateAttachmentPreview'>>;
  attachments: AttachmentItem[];
  readAttachment?: (path: string) => Promise<number[]>;
  createPreviewDataUrl?: PreviewGenerator;
  nativeUpload?: typeof uploadNativeCloudAttachment;
  useNativeUpload?: boolean;
  persistAttachmentPath?: typeof persistCloudAttachmentPath;
}): Promise<SendCloudMessageAttachmentInput[]> {
  const uploaded: SendCloudMessageAttachmentInput[] = [];
  for (const attachment of attachments) {
    const liveUpload = useNativeUpload && attachment.livePhotoFiles
      ? trackLivePhotoUpload(attachment.path, [attachment.livePhotoFiles.videoPath, attachment.livePhotoFiles.playbackPath]) : null;
    try {
      const mimeType = attachment.mimeType?.trim() || null;
      const kind = attachment.kind === 'image' ? 'image' : 'file';
      const supportsPreview = kind === 'image' || isMp4VideoAttachment(attachment);
      let previewUrl = supportsPreview
        ? safeCloudAttachmentPreviewUrl(attachment.previewUrl)
        : null;
      if (!previewUrl && attachment.livePhotoFiles?.previewPath) {
        const bytes = await readAttachment(attachment.livePhotoFiles.previewPath);
        previewUrl = safeCloudAttachmentPreviewUrl(await blobToDataUrl(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' })));
      }
      if (attachment.livePhotoFiles && (!previewUrl?.startsWith('data:image/') || !client.updateAttachmentPreview)) {
        throw new Error('This Live Photo could not prepare its still preview. Try attaching it again.');
      }
      if (isMp4VideoAttachment(attachment) && !previewUrl) {
        throw new Error('This video could not prepare a poster. Choose another MP4 file.');
      }
      let summary: Awaited<ReturnType<typeof uploadNativeCloudAttachment>>;
      if (useNativeUpload) {
        summary = await nativeUpload({ path: attachment.path, contentType: mimeType });
      } else {
        const bytes = await readAttachment(attachment.path);
        const blob = new Blob([new Uint8Array(bytes)], mimeType ? { type: mimeType } : undefined);
        previewUrl ??= kind === 'image'
          ? safeCloudAttachmentPreviewUrl(await createPreviewDataUrl(blob, {
            name: attachment.name,
            kind,
            mimeType,
            sizeBytes: attachment.sizeBytes ?? blob.size,
          }))
          : null;
        summary = await client.uploadAttachment(token, blob);
      }
      cacheCloudAttachmentLocalPath(summary.attachmentId, attachment.path);
      await persistAttachmentPath(summary.attachmentId, attachment.name, attachment.path);
      if (attachment.expressiveMedia) {
        cacheCloudAttachmentLocalPath(summary.attachmentId, attachment.path);
      }
      if (previewUrl && client.updateAttachmentPreview) {
        if (isMp4VideoAttachment(attachment) || attachment.livePhotoFiles) {
          await client.updateAttachmentPreview(token, summary.attachmentId, previewUrl);
          await persistCloudAttachmentPreviewDataUrl(
            summary.attachmentId,
            attachment.name,
            previewUrl,
          );
        } else {
          await client.updateAttachmentPreview(token, summary.attachmentId, previewUrl).catch(() => undefined);
        }
      } else if (previewUrl && isMp4VideoAttachment(attachment)) {
        throw new Error('This video poster could not be stored. Try again.');
      }
      let livePhoto: LivePhoto | undefined;
      if (attachment.livePhoto && !attachment.livePhotoFiles) {
        throw new Error('The original Live Photo resources are unavailable. Download them before sending.');
      }
      if (attachment.livePhotoFiles) {
        const uploadResource = async (path: string, name: string, mimeType: string): Promise<LivePhotoResource> => {
          liveUpload?.check();
          const result = useNativeUpload
            ? await nativeUpload({ path, contentType: mimeType })
            : await client.uploadAttachment(token, new Blob([new Uint8Array(await readAttachment(path))], { type: mimeType }));
          if (!result.sizeBytes || result.sizeBytes > 256 * 1024 * 1024) throw new Error('Live Photo motion must be 256 MiB or smaller.');
          await persistAttachmentPath(result.attachmentId, name, path);
          return { attachmentId: result.attachmentId, name, mimeType, sizeBytes: result.sizeBytes };
        };
        const video = await uploadResource(attachment.livePhotoFiles.videoPath, 'Live.mov', 'video/quicktime');
        const playback = await uploadResource(attachment.livePhotoFiles.playbackPath, 'Live.mp4', 'video/mp4');
        livePhoto = { video, playback };
      }
      liveUpload?.check();
      uploaded.push({
        attachmentId: summary.attachmentId,
        ...(livePhoto ? { livePhoto } : {}),
        name: attachment.name,
        kind,
        ...(attachment.subtype === 'meme' ? {
          subtype: 'meme' as const,
          altText: attachment.altText?.trim() || null,
        } : {}),
        mimeType,
        sizeBytes: attachment.sizeBytes ?? summary.sizeBytes,
        ...(attachment.widthPixels && attachment.heightPixels ? {
          widthPixels: attachment.widthPixels,
          heightPixels: attachment.heightPixels,
        } : {}),
      });
    } finally { liveUpload?.finish(); }
  }
  return uploaded;
}
