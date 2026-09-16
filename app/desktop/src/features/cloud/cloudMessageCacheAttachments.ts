import { normalizedLivePhoto } from '@/features/chat/livePhotos';
import { normalizedImagePixelDimensions } from '@/lib/imageDimensions';
import type { CloudMessageAttachment } from './authClient';
import { safeCloudAttachmentPreviewUrl } from './cloudAttachments';

const cleanText = (value: unknown) => typeof value === 'string' ? value.trim() : '';

export function cloudMessageAttachmentMetadataOnly(
  value: unknown,
  messageKind?: string | null,
): CloudMessageAttachment | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const attachmentId = cleanText(record.attachmentId);
  const name = cleanText(record.name);
  const kind = record.kind === 'image' ? 'image' : record.kind === 'file' ? 'file' : null;
  if (!attachmentId || !name || !kind) return null;
  const mimeType = cleanText(record.mimeType) || null;
  const sizeBytes = typeof record.sizeBytes === 'number' && Number.isFinite(record.sizeBytes) && record.sizeBytes >= 0
    ? record.sizeBytes
    : null;
  const previewAttachmentId = cleanText(record.previewAttachmentId);
  const previewUrl = safeCloudAttachmentPreviewUrl(
    typeof record.previewUrl === 'string' ? record.previewUrl : null,
  );
  return {
    attachmentId,
    name,
    kind,
    // Rows cached before the subtype left the wire carry none, so fall back to
    // the message kind rather than re-rendering them as full-size images.
    ...((record.subtype === 'sticker' || messageKind === 'sticker') && kind === 'image'
      ? { subtype: 'sticker' as const }
      : {}),
    mimeType,
    sizeBytes,
    ...(normalizedImagePixelDimensions(record.widthPixels, record.heightPixels) ?? {}),
    ...(normalizedLivePhoto(record.livePhoto) ? { livePhoto: normalizedLivePhoto(record.livePhoto) } : {}),
    ...(previewAttachmentId ? { previewAttachmentId } : {}),
    ...(previewUrl ? { previewUrl } : {}),
  };
}
