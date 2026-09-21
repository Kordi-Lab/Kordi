import type { Message } from '@/kordi-app/types';
import { attachmentImageDisplaySize, attachmentVideoDisplaySize, isAnimatedGifAttachment, isMp4VideoAttachment, shouldPreviewAttachmentInline } from './attachmentMediaGallery';

// Initial estimates only. The virtualizer retains actual measurements by
// stable message key and corrects geometry without moving the reading anchor.
// Accuracy still matters: every pixel an estimate misses is a scroll correction
// applied while the reader is moving, which shows up as vertical jitter. Model
// the rendered bubble instead of a single generic row.

/** Body text line height of a rendered message bubble. */
const MESSAGE_LINE_HEIGHT = 21;
/** Horizontal padding plus border of a plain message bubble. */
const MESSAGE_TEXT_PADDING = 24;
/** Padding reserved around a media-only bubble, calibrated by the media tests. */
const MESSAGE_MEDIA_BASE = 36;
/** Sender/owner header row shown above Agent messages. */
const MESSAGE_SENDER_META_HEIGHT = 23;
/** Columns of body text that fit on one line in a desktop transcript pane. */
const MESSAGE_TEXT_COLUMNS = 96;
/** Approximate width of one body-text column at the desktop transcript font. */
const MESSAGE_COLUMN_WIDTH = 8.3;
/** Extra vertical spacing a Markdown list item adds around its line. */
const MESSAGE_LIST_ITEM_EXTRA_HEIGHT = 9;
/** Fallback height when media dimensions are unknown. */
const MESSAGE_MIN_HEIGHT = 24;

/** Body-text columns for a transcript viewport, so narrow panes wrap like the render. */
export function transcriptContentColumns(viewportWidth: number) {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return MESSAGE_TEXT_COLUMNS;
  return Math.max(40, Math.min(140, Math.round(viewportWidth / MESSAGE_COLUMN_WIDTH)));
}

function messageHasSenderMeta(message: Message) {
  if (!message.sender) return false;
  return message.role !== 'person' && message.role !== 'user';
}

function isMarkdownListItem(line: string) {
  return /^\s*(?:[-*+]|\d+[.)])\s+/.test(line);
}

export function estimateTranscriptMessageHeight(
  message: Message,
  hasTimeSeparator = false,
  contentColumns = MESSAGE_TEXT_COLUMNS,
) {
  const text = message.text || message.turn?.assistantText || '';
  const sample = text.slice(0, 16_384);
  const columnsPerLine = Math.max(20, contentColumns);
  let lines = 0;
  let listItems = 0;
  for (const line of sample.split('\n')) {
    let columns = 0;
    for (const character of line) columns += character.codePointAt(0)! > 0xff ? 2 : 1;
    lines += Math.max(1, Math.ceil(columns / columnsPerLine));
    if (isMarkdownListItem(line)) listItems += 1;
  }
  const textHeight = sample.trim()
    ? Math.min(1_200, lines * MESSAGE_LINE_HEIGHT + listItems * MESSAGE_LIST_ITEM_EXTRA_HEIGHT)
    : 0;
  const media = (message.attachments ?? []).filter((attachment) => shouldPreviewAttachmentInline(attachment) || isMp4VideoAttachment(attachment));
  const files = (message.attachments?.length ?? 0) - media.length;
  const mediaHeight = media.reduce((height, attachment) => {
    const size = isMp4VideoAttachment(attachment)
      ? attachmentVideoDisplaySize(attachment)
      : attachmentImageDisplaySize(attachment);
    const fallback = attachment.subtype === 'sticker' || isAnimatedGifAttachment(attachment) ? 180 : 240;
    return Math.max(height, size?.height ?? fallback);
  }, 0) + (media.length > 1 ? 24 : 0);
  const hasText = Boolean(sample.trim());
  const base = (hasText ? MESSAGE_TEXT_PADDING : MESSAGE_MEDIA_BASE)
    + (messageHasSenderMeta(message) ? MESSAGE_SENDER_META_HEIGHT : 0);
  return Math.max(MESSAGE_MIN_HEIGHT,
    base + textHeight + mediaHeight + files * 60 + (textHeight && mediaHeight ? 8 : 0))
    + (hasTimeSeparator ? 32 : 0);
}
