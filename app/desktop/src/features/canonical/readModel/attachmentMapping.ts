import type { MessageAttachment } from '@/kordi-app/types';

function contentRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function canonicalAttachments(value: unknown): MessageAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments = value.flatMap((item) => {
    const record = contentRecord(item);
    const name = stringValue(record.name);
    const rawKind = stringValue(record.kind);
    if (!name || (rawKind !== 'image' && rawKind !== 'file')) return [];

    const kind: MessageAttachment['kind'] = rawKind;
    const attachment: MessageAttachment = {
      kind,
      ...(record.subtype === 'meme' && kind === 'image' ? {
        subtype: 'meme' as const,
        altText: stringValue(record.altText) ?? null,
      } : {}),
      name,
      formatLabel: stringValue(record.formatLabel) ?? null,
      previewUrl: stringValue(record.previewUrl) ?? null,
      mimeType: stringValue(record.mimeType) ?? null,
      localPath: stringValue(record.localPath) ?? null,
      sizeBytes: numberValue(record.sizeBytes) ?? null,
    };
    const downloadUrl = stringValue(record.downloadUrl);
    const attachmentId = stringValue(record.attachmentId);
    if (downloadUrl) attachment.downloadUrl = downloadUrl;
    if (attachmentId) attachment.attachmentId = attachmentId;
    return [attachment];
  });
  return attachments.length > 0 ? attachments : undefined;
}
