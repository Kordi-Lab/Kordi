import { attachmentsAreOnlyMp4Videos, shouldPreviewAttachmentInline } from '@/features/chat/attachmentMediaGallery';
import type { Message } from '../types';

export function transcriptAttachmentLayout(msg: Message, hasText: boolean, hasVoice: boolean) {
  const attachments = msg.attachments ?? [];
  const imageCount = attachments.filter(shouldPreviewAttachmentInline).length;
  const hasAttachments = attachments.length > 0;
  const hasOnlyImageAttachments = imageCount > 0 && imageCount === attachments.length && !hasText && !hasVoice;
  const hasOnlyBorderlessMediaAttachments = hasOnlyImageAttachments
    || (!hasText && !hasVoice && attachmentsAreOnlyMp4Videos(attachments));
  // Keep a single message identity and receipt, with images beside the caption/files surface.
  const hasDetachedImageGroup = imageCount > 0
    && (hasText || hasVoice || Boolean(msg.planCard) || imageCount < attachments.length);
  return {
    hasAttachments,
    hasOnlyBorderlessMediaAttachments,
    hasMixedImageAttachments: imageCount > 0 && hasText,
    hasGroupedImageAttachments: imageCount > 1,
    hasDetachedImageGroup,
    hasBubbleAttachments: hasDetachedImageGroup ? imageCount < attachments.length : hasAttachments,
  };
}
