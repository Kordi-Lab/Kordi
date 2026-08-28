import { normalizedImagePixelDimensions } from '@/lib/imageDimensions';
import type { CloudMessageAttachment } from './authClient';

export type CloudGroupAttachmentReferenceInput = Pick<
  CloudMessageAttachment,
  'attachmentId' | 'name' | 'kind' | 'subtype' | 'altText'
> & {
  mimeType?: string | null;
  sizeBytes?: number | null;
  widthPixels?: number | null;
  heightPixels?: number | null;
};

export function cloudGroupAttachmentReferences(
  attachments: readonly CloudGroupAttachmentReferenceInput[],
): CloudMessageAttachment[] {
  return attachments.map((attachment) => ({
    attachmentId: attachment.attachmentId,
    name: attachment.name,
    kind: attachment.kind,
    ...(attachment.subtype === 'sticker' ? { subtype: 'sticker' as const }
      : attachment.subtype === 'meme' ? { subtype: 'meme' as const, altText: attachment.altText ?? null } : {}),
    mimeType: attachment.mimeType ?? null,
    sizeBytes: attachment.sizeBytes ?? null,
    ...(normalizedImagePixelDimensions(attachment.widthPixels, attachment.heightPixels) ?? {}),
  }));
}
