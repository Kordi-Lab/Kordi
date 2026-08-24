import type { ReactNode } from 'react';

import {
  isTranscriptLoadingNotice,
  transcriptSystemNoticeClassName,
} from '@/features/chat/transcriptLoadingNotice';
import type { Message } from '@/kordi-app/types';
import { TranscriptCallActivityContent } from './transcriptCallActivityContent';

export function TranscriptSystemNoticeContent({
  message,
  children,
}: {
  message: Message;
  children: ReactNode;
}) {
  if (message.callActivity) return <TranscriptCallActivityContent message={message} />;
  const loading = isTranscriptLoadingNotice(message);
  if (loading) return null;
  return (
    <div
      className={transcriptSystemNoticeClassName(message)}
    >
      {children}
    </div>
  );
}
