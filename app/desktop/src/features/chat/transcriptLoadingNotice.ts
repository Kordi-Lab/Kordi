import type { Message } from '@/kordi-app/types';

export const TRANSCRIPT_LOADING_NOTICE_DETAIL = 'transcript-loading';

export function transcriptLoadingNotice(text = 'Loading chat history…'): Message {
  return {
    role: 'system',
    text,
    time: '--:--',
    detail: TRANSCRIPT_LOADING_NOTICE_DETAIL,
  };
}

export function isTranscriptLoadingNotice(message: Message): boolean {
  return message.role === 'system' && message.detail === TRANSCRIPT_LOADING_NOTICE_DETAIL;
}

const SYSTEM_NOTICE_BASE_CLASS = 'app-system-notice-text max-w-[min(100%,34rem)] truncate px-2.5 py-0.5 text-center text-[11px] leading-5 text-[color:var(--utility-muted-text)]';

export function transcriptSystemNoticeClassName(message: Message): string {
  return isTranscriptLoadingNotice(message)
    ? `${SYSTEM_NOTICE_BASE_CLASS} app-transcript-loading-notice`
    : SYSTEM_NOTICE_BASE_CLASS;
}
