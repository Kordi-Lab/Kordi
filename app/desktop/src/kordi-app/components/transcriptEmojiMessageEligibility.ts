import { emojiItemFromComposerValue } from '@/features/emoji/emojiCatalog';

import type { Message } from '../types';
import { firstExternalMessageLink } from './messageLinks';

export function standaloneEmojiItemForMessage(
  message: Message,
  options: { isHuman: boolean; showsSender: boolean; footerDetail?: string },
) {
  if (
    !options.isHuman
    || options.showsSender
    || message.messageAction
    || message.sourceMessage
    || message.attachments?.length
    || message.voiceMessage
    || firstExternalMessageLink(message.text)
    || message.supportContactResponse
    || message.supportContactTyping
    || options.footerDetail
    || message.replySummary
    || message.editedAt
  ) return null;
  return emojiItemFromComposerValue(message.text);
}
