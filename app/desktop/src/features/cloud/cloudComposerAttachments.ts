import type { AttachmentItem } from '@/features/chat/composerController.types';
import { readDesktopChatAttachment } from '@/lib/desktop';
import type {
  CloudAuthClient,
  SendCloudMessageAttachmentInput,
} from './authClient';
import { createCompressedImagePreviewDataUrl } from './cloudAttachmentPreviewGeneration';
import {
  cacheCloudAttachmentLocalPath,
  persistCloudAttachmentPath,
} from './cloudAttachmentLocalPathCache';
import {
  isNativeAttachmentUploadAvailable,
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
}: {
  token: string;
  client: Pick<CloudAuthClient, 'uploadAttachment'>
    & Partial<Pick<CloudAuthClient, 'updateAttachmentPreview'>>;
  attachments: AttachmentItem[];
  readAttachment?: (path: string) => Promise<number[]>;
  createPreviewDataUrl?: PreviewGenerator;
  nativeUpload?: typeof uploadNativeCloudAttachment;
  useNativeUpload?: boolean;
}): Promise<SendCloudMessageAttachmentInput[]> {
  const uploaded: SendCloudMessageAttachmentInput[] = [];
  for (const attachment of attachments) {
    const mimeType = attachment.mimeType?.trim() || null;
    const kind = attachment.kind === 'image' ? 'image' : 'file';
    let previewUrl = kind === 'image'
      ? safeCloudAttachmentPreviewUrl(attachment.previewUrl)
      : null;
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
    await persistCloudAttachmentPath(summary.attachmentId, attachment.name, attachment.path);
    if (previewUrl && client.updateAttachmentPreview) {
      await client.updateAttachmentPreview(token, summary.attachmentId, previewUrl).catch(() => undefined);
    }
    uploaded.push({
      attachmentId: summary.attachmentId,
      name: attachment.name,
      kind,
      ...(attachment.subtype === 'meme' ? {
        subtype: 'meme' as const,
        altText: attachment.altText?.trim() || null,
      } : {}),
      mimeType,
      sizeBytes: attachment.sizeBytes ?? summary.sizeBytes,
      ...(previewUrl ? { previewUrl } : {}),
    });
  }
  return uploaded;
}
