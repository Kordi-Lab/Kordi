import { useCallback, useRef, useState } from 'react';

import { resolveTranscriptNavigationIdsForSource } from '@/features/chat/messageNavigation';
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

function navigationIds(
  messageId: string,
  sourceMessage: MessageSourceReference | undefined,
  messages: readonly Message[],
) {
  const fallbackId = messageId.trim();
  if (!sourceMessage) {
    return {
      id: fallbackId,
      lookupIds: fallbackId ? [fallbackId] : [],
    };
  }
  const resolved = resolveTranscriptNavigationIdsForSource(sourceMessage, messages);
  if (resolved.id) return resolved;
  return {
    id: fallbackId,
    lookupIds: fallbackId ? [fallbackId] : [],
  };
}

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
    const target = navigationIds(messageId, sourceMessage, main.messages);
    if (!target.id) return;
    nonceRef.current += 1;
    setMainRequest({
      id: target.id,
      lookupIds: target.lookupIds,
      nonce: nonceRef.current,
      sessionKey: main.conversation.id,
    });
  }, [main.conversation, main.messages]);

  const navigateCompanion = useCallback((
    messageId: string,
    sourceMessage?: MessageSourceReference,
  ) => {
    if (!companion.conversation) return;
    const target = navigationIds(messageId, sourceMessage, companion.messages);
    if (!target.id) return;
    nonceRef.current += 1;
    companion.onShowMessages();
    setCompanionRequest({
      id: target.id,
      lookupIds: target.lookupIds,
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
