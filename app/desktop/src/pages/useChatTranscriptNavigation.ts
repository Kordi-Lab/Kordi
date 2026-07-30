import { useCallback, useRef, useState } from 'react';

import { resolveTranscriptMessageIdForSource } from '@/features/chat/messageNavigation';
import type {
  Conversation,
  Message,
  MessageSourceReference,
} from '@/kordi-app/types';
import {
  sameTranscriptNavigationRequest,
  type TranscriptNavigationRequest,
} from '@/pages/chatsPage.navigation';

type TranscriptNavigationTarget = {
  conversation: Conversation | null;
  messages: readonly Message[];
};

type UseChatTranscriptNavigationInput = {
  main: TranscriptNavigationTarget;
  companion: TranscriptNavigationTarget & {
    onShowMessages: () => void;
  };
};

export function useChatTranscriptNavigation({
  main,
  companion,
}: UseChatTranscriptNavigationInput) {
  const [mainRequest, setMainRequest] = useState<TranscriptNavigationRequest | null>(null);
  const [companionRequest, setCompanionRequest] = useState<TranscriptNavigationRequest | null>(null);
  const nonceRef = useRef(0);

  const acknowledgeMain = useCallback((handled: TranscriptNavigationRequest) => {
    setMainRequest((current) => (
      current && sameTranscriptNavigationRequest(current, handled) ? null : current
    ));
  }, []);

  const acknowledgeCompanion = useCallback((handled: TranscriptNavigationRequest) => {
    setCompanionRequest((current) => (
      current && sameTranscriptNavigationRequest(current, handled) ? null : current
    ));
  }, []);

  const navigateMain = useCallback((
    messageId: string,
    sourceMessage?: MessageSourceReference,
  ) => {
    if (!main.conversation) return;
    const targetMessageId = sourceMessage
      ? resolveTranscriptMessageIdForSource(sourceMessage, main.messages)
      : messageId;
    nonceRef.current += 1;
    setMainRequest({
      id: targetMessageId || messageId,
      nonce: nonceRef.current,
      sessionKey: main.conversation.id,
    });
  }, [main.conversation, main.messages]);

  const navigateCompanion = useCallback((
    messageId: string,
    sourceMessage?: MessageSourceReference,
  ) => {
    if (!companion.conversation) return;
    const targetMessageId = sourceMessage
      ? resolveTranscriptMessageIdForSource(sourceMessage, companion.messages)
      : messageId;
    nonceRef.current += 1;
    companion.onShowMessages();
    setCompanionRequest({
      id: targetMessageId || messageId,
      nonce: nonceRef.current,
      sessionKey: companion.conversation.id,
    });
  }, [companion]);

  return {
    main: {
      request: mainRequest,
      acknowledge: acknowledgeMain,
      navigate: navigateMain,
    },
    companion: {
      request: companionRequest,
      acknowledge: acknowledgeCompanion,
      navigate: navigateCompanion,
    },
  };
}
