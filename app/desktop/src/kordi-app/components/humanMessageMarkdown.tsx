import type { Message, MessageMention } from '../types';
import { MarkdownContent } from './markdown';
import { MarkdownInlineContent } from './markdownInline';

function messageForMentionProfile(message: Message, mention: MessageMention): Message | null {
  if (mention.targetKind !== 'person') return null;
  const humanId = mention.humanId?.trim()
    || mention.targetIdentityId?.trim().replace(/^human:/, '');
  if (!humanId) return null;
  return {
    ...message,
    sender: mention.displayLabel?.trim() || mention.label.trim() || message.sender,
    senderIdentityId: humanId,
    senderType: 'human',
    isOwnMessage: false,
  };
}

export function HumanMessageMarkdown({
  message,
  inline = false,
  onOpenSenderProfile,
}: {
  message: Message;
  inline?: boolean;
  onOpenSenderProfile?: (message: Message, anchorRect: DOMRect) => void;
}) {
  const openMention = onOpenSenderProfile
    ? (mention: MessageMention, anchorRect: DOMRect) => {
        const target = messageForMentionProfile(message, mention);
        if (target) onOpenSenderProfile(target, anchorRect);
      }
    : undefined;
  const props = {
    text: message.text,
    tone: 'inherit' as const,
    showLinkIcons: true,
    mentions: message.mentions,
    onOpenMention: openMention,
  };

  return inline
    ? <MarkdownInlineContent {...props} />
    : <MarkdownContent {...props} copySurface="message" preserveLineBreaks />;
}
