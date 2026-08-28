import type { SendCloudMessageAttachmentInput } from './authClient';
import { normalizedImagePixelDimensions } from '@/lib/imageDimensions';

export type CloudGroupOutboxAttachmentSource = {
  id: string;
  path: string;
  name: string;
  kind: 'image' | 'file';
  subtype?: 'meme' | 'sticker' | null;
  altText?: string | null;
  memeRightsConfirmed?: boolean;
  formatLabel?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  widthPixels?: number | null;
  heightPixels?: number | null;
};

function cleanText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizedCloudGroupOutboxAttachments(value: unknown): SendCloudMessageAttachmentInput[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments = value.flatMap((candidate): SendCloudMessageAttachmentInput[] => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const record = candidate as Record<string, unknown>;
    const attachmentId = cleanText(record.attachmentId);
    const name = cleanText(record.name);
    const kind = record.kind === 'image' || record.kind === 'file' ? record.kind : null;
    const previewUrl = cleanText(record.previewUrl);
    const dimensions = normalizedImagePixelDimensions(record.widthPixels, record.heightPixels);
    if (!attachmentId || !name || !kind) return [];
    return [{
      attachmentId,
      name,
      kind,
      ...(record.subtype === 'sticker' && kind === 'image'
        ? { subtype: 'sticker' as const }
        : record.subtype === 'meme' && kind === 'image' ? {
            subtype: 'meme' as const,
            altText: typeof record.altText === 'string' ? record.altText : null,
          } : {}),
      mimeType: cleanText(record.mimeType) || null,
      sizeBytes: typeof record.sizeBytes === 'number' && Number.isFinite(record.sizeBytes) ? record.sizeBytes : null,
      ...(dimensions ?? {}),
      ...(previewUrl ? { previewUrl } : {}),
    }];
  });
  return attachments.length > 0 ? attachments : undefined;
}

export function normalizedCloudGroupOutboxPendingAttachments(value: unknown): CloudGroupOutboxAttachmentSource[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments = value.flatMap((candidate, index): CloudGroupOutboxAttachmentSource[] => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const record = candidate as Record<string, unknown>;
    const path = cleanText(record.path);
    const name = cleanText(record.name);
    const kind = record.kind === 'image' || record.kind === 'file' ? record.kind : null;
    if (!path || !name || !kind) return [];
    const id = cleanText(record.id) || `pending-attachment:${index}:${path}`;
    const dimensions = normalizedImagePixelDimensions(record.widthPixels, record.heightPixels);
    return [{
      id,
      path,
      name,
      kind,
      ...(record.subtype === 'sticker' && kind === 'image'
        ? { subtype: 'sticker' as const }
        : record.subtype === 'meme' && kind === 'image' ? {
            subtype: 'meme' as const,
            altText: typeof record.altText === 'string' ? record.altText : null,
            memeRightsConfirmed: record.memeRightsConfirmed === true,
          } : {}),
      formatLabel: cleanText(record.formatLabel) || null,
      mimeType: cleanText(record.mimeType) || null,
      sizeBytes: typeof record.sizeBytes === 'number' && Number.isFinite(record.sizeBytes) ? record.sizeBytes : null,
      ...(dimensions ?? {}),
    }];
  });
  return attachments.length > 0 ? attachments : undefined;
}
