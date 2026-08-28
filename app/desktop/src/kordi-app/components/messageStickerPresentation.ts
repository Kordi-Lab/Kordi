import { expressiveMediaLibraryKindForAttachment } from '@/features/emoji/expressiveMediaLibrary';
import type { Message, MessageAttachment } from '../types';

export function messageStickerAttachment(message: Message): MessageAttachment | undefined {
  const attachments = message.attachments ?? [];
  if (attachments.length !== 1 || attachments[0]?.kind !== 'image') return undefined;
  const attachment = attachments[0];
  return attachment.subtype === 'sticker'
    || message.messageKind === 'sticker'
    || expressiveMediaLibraryKindForAttachment(attachment) === 'sticker'
    ? attachment
    : undefined;
}
