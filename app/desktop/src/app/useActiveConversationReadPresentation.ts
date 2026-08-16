import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import {
  canMarkActiveConversationRead,
  documentHasActivePresentation,
} from '@/features/cloud/activeConversationReadPolicy';
import type { NavId } from '@/kordi-app/types';

function currentForegroundState() {
  if (typeof document === 'undefined') return false;
  return documentHasActivePresentation(document);
}

export function useActiveConversationReadPresentation({
  activeNav,
  activeConversationId,
}: {
  activeNav: NavId;
  activeConversationId: string;
}) {
  const [isAppForeground, setIsAppForeground] = useState(
    currentForegroundState,
  );
  const presentationKey = `${activeNav}:${activeConversationId}`;
  const [transcriptPosition, setTranscriptPosition] = useState({
    presentationKey: '',
    isAtLatest: false,
  });

  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return;
    }

    const synchronizeForegroundState = () => {
      setIsAppForeground(currentForegroundState());
    };

    synchronizeForegroundState();
    document.addEventListener('visibilitychange', synchronizeForegroundState);
    window.addEventListener('focus', synchronizeForegroundState);
    window.addEventListener('blur', synchronizeForegroundState);
    return () => {
      document.removeEventListener(
        'visibilitychange',
        synchronizeForegroundState,
      );
      window.removeEventListener('focus', synchronizeForegroundState);
      window.removeEventListener('blur', synchronizeForegroundState);
    };
  }, []);

  const isTranscriptPresented = activeNav === 'chats'
    && Boolean(activeConversationId.trim());
  const isTranscriptAtLatest = transcriptPosition.presentationKey === presentationKey
    && transcriptPosition.isAtLatest;
  const canMarkRead = canMarkActiveConversationRead({
    isSelected: isTranscriptPresented,
    isTranscriptPresented,
    isAppForeground,
    isAtLatest: isTranscriptAtLatest,
  });

  const setIsTranscriptAtLatest = useCallback<Dispatch<SetStateAction<boolean>>>(
    (value) => {
      setTranscriptPosition((previous) => ({
        presentationKey,
        isAtLatest: typeof value === 'function'
          ? value(
            previous.presentationKey === presentationKey
              ? previous.isAtLatest
              : false,
          )
          : value,
      }));
    },
    [presentationKey],
  );

  return {
    canMarkRead,
    setIsTranscriptAtLatest,
  };
}
