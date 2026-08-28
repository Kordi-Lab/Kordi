import { shouldPreviewAttachmentInline } from '@/features/chat/attachmentMediaGallery';
import { messageStickerAttachment } from './messageStickerPresentation';
import type { Message } from '../types';

export function messageContextMenuMediaAttachment(msg: Message, target: Element | null) {
  const card = target?.closest('[data-attachment-image-card="true"]');
  const rawIndex = card?.getAttribute('data-attachment-image-index');
  if (rawIndex === null || rawIndex === undefined) return null;
  const index = Number.parseInt(rawIndex, 10);
  if (!Number.isSafeInteger(index) || index < 0) return null;
  const attachment = (msg.attachments ?? []).filter(shouldPreviewAttachmentInline)[index] ?? null;
  return attachment === messageStickerAttachment(msg) ? null : attachment;
}
