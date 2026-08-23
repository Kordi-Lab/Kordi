import type { CloudAuthClient, CloudMessageAttachment } from './authClient';
import { createCompressedImagePreviewDataUrl } from './cloudAttachmentPreviewGeneration';
import { safeCloudAttachmentPreviewUrl } from './cloudAttachmentPreviewUrl';

const MAX_PREVIEW_RECOVERY_BYTES = 25 * 1024 * 1024;

export type CloudAttachmentPreviewGenerator = (
  blob: Blob,
  attachment: {
    name: string;
    kind: 'image' | 'file';
    mimeType?: string | null;
    sizeBytes?: number | null;
  },
) => Promise<string | null>;

export async function recoverCloudAttachmentPreview({
  token,
  client,
  attachment,
  createPreviewDataUrl = createCompressedImagePreviewDataUrl,
}: {
  token: string;
  client: Pick<CloudAuthClient, 'downloadAttachmentContent' | 'updateAttachmentPreview'>;
  attachment: Pick<
    CloudMessageAttachment,
    'attachmentId' | 'name' | 'kind' | 'mimeType' | 'sizeBytes' | 'previewUrl'
  >;
  createPreviewDataUrl?: CloudAttachmentPreviewGenerator;
}): Promise<string | null> {
  if (attachment.kind !== 'image') return null;
  if (safeCloudAttachmentPreviewUrl(attachment.previewUrl)) return null;
  if ((attachment.sizeBytes ?? 0) > MAX_PREVIEW_RECOVERY_BYTES) return null;
  const attachmentId = attachment.attachmentId?.trim();
  if (!attachmentId) return null;

  const blob = await client.downloadAttachmentContent(token, attachmentId);
  if (blob.size > MAX_PREVIEW_RECOVERY_BYTES) return null;
  const previewUrl = safeCloudAttachmentPreviewUrl(await createPreviewDataUrl(blob, {
    name: attachment.name,
    kind: attachment.kind,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes ?? blob.size,
  }));
  if (!previewUrl) return null;
  await client.updateAttachmentPreview(token, attachmentId, previewUrl);
  return previewUrl;
}
