import type { ForwardedContent, Message } from '@/kordi-app/types/message';

/** Accept only rendering data; never copy arbitrary source/tool metadata. */
export function forwardedContentFromRecord(value: unknown): ForwardedContent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.text !== 'string') return undefined;
  return { text: record.text, ...(typeof record.comment === 'string' ? { comment: record.comment } : {}) };
}

export function forwardedMessageContent(message: Pick<Message, 'text' | 'messageAction'>): ForwardedContent {
  const action = message.messageAction;
  const content = forwardedContentFromRecord(action?.forwardedContent);
  if (action?.kind !== 'forward') return { text: message.text };
  if (content) return content;
  // Schema-v1 forwards may contain only a comment in the outer body. Recover
  // the available excerpt without pretending that it is the complete original.
  const excerpt = action.source.textPreview;
  const previewBody = excerpt.replace(/…$/, '').replace(/\s+/g, ' ').trim();
  const bodyIncludesExcerpt = previewBody && message.text.replace(/\s+/g, ' ').includes(previewBody);
  if (excerpt && action.source.attachmentCount === 0 && !bodyIncludesExcerpt) {
    return { text: excerpt, ...(message.text ? { comment: message.text } : {}) };
  }
  return { text: message.text || (action.source.attachmentCount === 0 ? excerpt : '') };
}

export function visibleForwardedText(message: Pick<Message, 'text' | 'messageAction'>): string {
  if (message.messageAction?.kind !== 'forward') return message.text;
  const { text, comment } = forwardedMessageContent(message);
  return [comment, text].filter(Boolean).join('\n\n');
}
