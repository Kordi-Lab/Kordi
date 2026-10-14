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
  rememberUploadedAttachmentSource,
} from './cloudAttachmentLocalPathCache';
import {
  isNativeAttachmentUploadAvailable,
  trackLivePhotoUpload,
  uploadNativeCloudAttachment,
} from './cloudAttachmentUpload';
import { safeCloudAttachmentPreviewUrl } from './cloudAttachmentPreviewUrl';
import { linkCloudDocumentSource } from '@/features/documents/documentShareClient';

type DocumentSourceLinker = (token: string, copyAttachmentId: string, sourceAttachmentId: string) => Promise<unknown>;

/** Fired when a forwarded document could not be linked to its original; the message is still sent. */
export const DOCUMENT_LINK_FAILED_EVENT = 'kordi-document-link-failed';

function logDocumentLinkFailure(error: unknown) {
  if (typeof window === 'undefined') return;
  const message = error instanceof Error ? error.message : String(error);
  window.dispatchEvent(new window.CustomEvent(DOCUMENT_LINK_FAILED_EVENT, { detail: { message } }));
}

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
  createPreviewDataUrl = (blob) => createCompressedImagePreviewDataUrl(blob),
  nativeUpload = uploadNativeCloudAttachment,
  useNativeUpload = isNativeAttachmentUploadAvailable(),
  persistAttachmentPath = persistCloudAttachmentPath,
  linkDocumentSource = client.request
    ? (sessionToken, copyId, sourceId) => linkCloudDocumentSource({ request: client.request!.bind(client) }, sessionToken, copyId, sourceId)
    : undefined,
  reportLinkFailure = logDocumentLinkFailure,
}: {
  token: string;
  client: Pick<CloudAuthClient, 'uploadAttachment'>
    & Partial<Pick<CloudAuthClient, 'updateAttachmentPreview' | 'request'>>;
  attachments: AttachmentItem[];
  readAttachment?: (path: string) => Promise<number[]>;
  createPreviewDataUrl?: PreviewGenerator;
  nativeUpload?: typeof uploadNativeCloudAttachment;
  useNativeUpload?: boolean;
  persistAttachmentPath?: typeof persistCloudAttachmentPath;
  /** Links a forwarded document copy to its original; a failure is logged and the send goes on. */
  linkDocumentSource?: DocumentSourceLinker;
  reportLinkFailure?: (error: unknown) => void;
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
      rememberUploadedAttachmentSource(attachment.path, summary.attachmentId);
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
      const sourceAttachmentId = attachment.sourceAttachmentId?.trim();
      if (sourceAttachmentId && linkDocumentSource && sourceAttachmentId !== summary.attachmentId) {
        await linkDocumentSource(token, summary.attachmentId, sourceAttachmentId).catch(reportLinkFailure);
      }
      liveUpload?.check();
      uploaded.push({
        attachmentId: summary.attachmentId,
        ...(livePhoto ? { livePhoto } : {}),
        name: attachment.name,
        kind,
        ...(attachment.subtype === 'sticker' ? { subtype: 'sticker' as const } : {}),
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
