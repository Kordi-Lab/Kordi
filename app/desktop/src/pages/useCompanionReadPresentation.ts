import { useCallback, useEffect, type RefObject } from 'react';
import { useActiveConversationReadPresentation } from '@/app/useActiveConversationReadPresentation';
import { transcriptIsAtLatest } from '@/features/cloud/activeConversationReadPolicy';

export function useCompanionReadPresentation({
  sessionId, isPresented, scrollRef, onChange,
}: {
  sessionId: string | null;
  isPresented: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  onChange?: (sessionId: string | null) => void;
}) {
  const { canMarkRead, setIsTranscriptAtLatest } = useActiveConversationReadPresentation({
    activeNav: 'chats',
    activeConversationId: isPresented ? sessionId ?? '' : '',
  });
  useEffect(() => {
    if (!isPresented) setIsTranscriptAtLatest(false);
  }, [isPresented, setIsTranscriptAtLatest]);
  useEffect(() => {
    onChange?.(canMarkRead && isPresented ? sessionId : null);
    return () => onChange?.(null);
  }, [canMarkRead, isPresented, onChange, sessionId]);

  return useCallback((isAtLatest?: boolean) => {
    const container = scrollRef.current;
    setIsTranscriptAtLatest(isAtLatest ?? (container ? transcriptIsAtLatest(container) : false));
  }, [scrollRef, setIsTranscriptAtLatest]);
}
