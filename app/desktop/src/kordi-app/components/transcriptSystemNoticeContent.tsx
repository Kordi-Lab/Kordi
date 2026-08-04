import { LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  isTranscriptLoadingNotice,
  transcriptSystemNoticeClassName,
} from '@/features/chat/transcriptLoadingNotice';
import type { Message } from '@/kordi-app/types';

export function TranscriptSystemNoticeContent({
  message,
  children,
}: {
  message: Message;
  children: ReactNode;
}) {
  const loading = isTranscriptLoadingNotice(message);
  return (
    <div
      className={transcriptSystemNoticeClassName(message)}
      role={loading ? 'status' : undefined}
      aria-live={loading ? 'polite' : undefined}
      aria-atomic={loading || undefined}
    >
      {loading ? (
        <LoaderCircle
          className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : null}
      {children}
    </div>
  );
}
