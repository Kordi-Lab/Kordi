import type { Message } from '@/kordi-app/types';

export const TRANSCRIPT_LOADING_NOTICE_DETAIL = 'transcript-loading';

function placeholderWidth(length: number) {
  return length <= 18 ? 'short' : length <= 54 ? 'medium' : 'long';
}

function placeholderLines(length: number) {
  return length <= 34 ? 1 : length <= 88 ? 2 : 3;
}

function loadingPlaceholder(message: Message): NonNullable<
  Message['loadingPlaceholders']
>[number] | null {
  if (message.role === 'system' || message.role === 'action' || message.role === 'edit') {
    return null;
  }
  const text = message.turn?.assistantText?.trim() || message.text.trim();
  const own = (message.isOwnMessage ?? message.role === 'user')
    && (message.senderType ?? 'human') === 'human';
  const peer = !own && (message.senderType === 'human' || message.role === 'person');
  const imageOnly = !text
    && Boolean(message.attachments?.length)
    && message.attachments?.every((attachment) => attachment.kind === 'image');
  const length = Array.from(text).length;
  return {
    kind: imageOnly
      ? 'image'
      : !peer && !own
        ? 'agent'
        : /(?:https?:\/\/|www\.)\S+/i.test(text)
          ? 'link'
          : 'message',
    side: own ? 'own' : 'peer',
    lines: placeholderLines(length),
    width: placeholderWidth(length),
  };
}

export function transcriptLoadingNotice(
  text = '',
  cachedRows: readonly Message[] = [],
): Message {
  const loadingPlaceholders = cachedRows
    .slice(-8)
    .map(loadingPlaceholder)
    .filter((placeholder): placeholder is NonNullable<typeof placeholder> => Boolean(placeholder));
  return {
    role: 'system',
    text,
    time: '--:--',
    detail: TRANSCRIPT_LOADING_NOTICE_DETAIL,
    loadingPlaceholders: loadingPlaceholders.length > 0
      ? loadingPlaceholders
      : undefined,
  };
}

export function isTranscriptLoadingNotice(message: Message): boolean {
  return message.role === 'system' && message.detail === TRANSCRIPT_LOADING_NOTICE_DETAIL;
}

const SYSTEM_NOTICE_BASE_CLASS = 'app-system-notice-text max-w-[min(100%,34rem)] truncate px-2.5 py-0.5 text-center text-[11px] leading-5 text-[color:var(--utility-muted-text)]';

export function transcriptSystemNoticeClassName(message: Message): string {
  return isTranscriptLoadingNotice(message)
    ? 'sr-only'
    : SYSTEM_NOTICE_BASE_CLASS;
}
