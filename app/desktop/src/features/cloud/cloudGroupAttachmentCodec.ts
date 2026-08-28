import type { CloudMessageAttachment } from './authClient';
import { normalizedImagePixelDimensions } from '@/lib/imageDimensions';

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cloudMessageAttachmentFromRecord(value: unknown): CloudMessageAttachment | null {
  const record = objectRecord(value);
  const attachmentId = typeof record.attachmentId === 'string' ? record.attachmentId.trim() : '';
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const kind = record.kind === 'image' || record.kind === 'file' ? record.kind : null;
  if (!attachmentId || !name || !kind) return null;
  const mimeType = typeof record.mimeType === 'string' && record.mimeType.trim() ? record.mimeType.trim() : null;
  const sizeBytes = typeof record.sizeBytes === 'number' && Number.isFinite(record.sizeBytes) && record.sizeBytes >= 0 ? record.sizeBytes : null;
  const downloadUrl = typeof record.downloadUrl === 'string' && record.downloadUrl.trim() ? record.downloadUrl.trim() : null;
  const previewUrl = typeof record.previewUrl === 'string' && record.previewUrl.trim() ? record.previewUrl.trim() : null;
  const dimensions = normalizedImagePixelDimensions(record.widthPixels, record.heightPixels);
  return {
    attachmentId,
    name,
    kind,
    ...(record.subtype === 'sticker' && kind === 'image'
      ? { subtype: 'sticker' as const }
      : record.subtype === 'meme' && kind === 'image' ? {
          subtype: 'meme' as const,
          altText: typeof record.altText === 'string' ? record.altText : null,
        } : {}),
    mimeType,
    sizeBytes,
    ...(dimensions ?? {}),
    downloadUrl,
    previewUrl,
  };
}

export function cloudMessageAttachmentsFromRecord(value: unknown): CloudMessageAttachment[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(cloudMessageAttachmentFromRecord)
    .filter((attachment): attachment is CloudMessageAttachment => Boolean(attachment));
}
