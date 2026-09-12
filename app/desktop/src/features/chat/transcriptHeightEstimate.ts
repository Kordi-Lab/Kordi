import type { Message } from '@/kordi-app/types';
import { attachmentImageDisplaySize, attachmentVideoDisplaySize, isAnimatedGifAttachment, isMp4VideoAttachment, shouldPreviewAttachmentInline } from './attachmentMediaGallery';
import { TRANSCRIPT_WINDOW_ESTIMATED_MESSAGE_HEIGHT } from './transcriptWindowing';

// Initial estimates only. The virtualizer retains actual measurements by
// stable message key and corrects geometry without moving the reading anchor.
export function estimateTranscriptMessageHeight(message: Message, hasTimeSeparator = false) {
  const text = message.text || message.turn?.assistantText || '';
  const sample = text.slice(0, 16_384);
  const lines = sample.split('\n').reduce((count, line) => {
    let columns = 0;
    for (const character of line) columns += character.codePointAt(0)! > 0xff ? 2 : 1;
    return count + Math.max(1, Math.ceil(columns / 64));
  }, 0);
  const textHeight = sample.trim() ? Math.min(1_200, lines * 24) : 0;
  const media = (message.attachments ?? []).filter((attachment) => shouldPreviewAttachmentInline(attachment) || isMp4VideoAttachment(attachment));
  const files = (message.attachments?.length ?? 0) - media.length;
  const mediaHeight = media.reduce((height, attachment) => {
    const size = isMp4VideoAttachment(attachment)
      ? attachmentVideoDisplaySize(attachment)
      : attachmentImageDisplaySize(attachment);
    const fallback = attachment.subtype === 'sticker' || isAnimatedGifAttachment(attachment) ? 180 : 240;
    return Math.max(height, size?.height ?? fallback);
  }, 0) + (media.length > 1 ? 24 : 0);
  return Math.max(TRANSCRIPT_WINDOW_ESTIMATED_MESSAGE_HEIGHT,
    36 + textHeight + mediaHeight + files * 60 + (textHeight && mediaHeight ? 8 : 0))
    + (hasTimeSeparator ? 32 : 0);
}
