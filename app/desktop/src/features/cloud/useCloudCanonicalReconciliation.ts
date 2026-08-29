import {
  useEffect,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type {
  CanonicalSessionState,
} from '@/kordi-app/types';
import type {
  CloudAccount,
} from './authClient';
import {
  cloudSessionIdFromConversationId,
} from './cloudCollaborationState';
import {
  cloudGroupUnreadCountsBySessionId,
} from './cloudGroupMessages';
import {
  patchCanonicalDeliverySummaries,
  type CloudMessageIndex,
} from './cloudMessageIndex';
import {
  cloudGroupReadCursorsBySessionId,
} from './cloudSelfAgentCanonicalSync';
import {
  patchCanonicalCloudUnreadCounts,
} from './cloudUnreadReconciliation';

export function useCloudCanonicalReconciliation({
  account,
  activeConversationId,
  canonical,
  messages,
  unread,
}: {
  account: CloudAccount | null;
  activeConversationId: string | null | undefined;
  canonical: {
    state: CanonicalSessionState | null | undefined;
    setState?: Dispatch<
      SetStateAction<CanonicalSessionState | null>
    >;
  };
  messages: {
    index: CloudMessageIndex;
    authoritative: boolean;
  };
  unread: {
    contextKey: string | null;
    setPublishedContextKey: Dispatch<
      SetStateAction<string | null>
    >;
  };
}) {
  const { state: canonicalState, setState: setCanonicalState } =
    canonical;
  const { index: messageIndex, authoritative } = messages;
  const {
    contextKey: unreadContextKey,
    setPublishedContextKey,
  } = unread;

  useEffect(() => {
    if (!account || !setCanonicalState) return;
    if (messageIndex.deliveryByMessageId.size === 0) return;
    setCanonicalState((current) =>
      patchCanonicalDeliverySummaries(
        current,
        messageIndex.deliveryByMessageId,
      )
    );
  }, [account, canonicalState?.messages.length, messageIndex, setCanonicalState]);

  useEffect(() => {
    if (
      !account
      || !canonicalState
      || !setCanonicalState
      || !authoritative
      || !unreadContextKey
    ) return;
    const activeConversationIds = [
      activeConversationId,
      activeConversationId
        ? cloudSessionIdFromConversationId(activeConversationId)
        : null,
    ];
    const unreadBySessionId = cloudGroupUnreadCountsBySessionId({
      accountId: account.accountId,
      activeConversationIds,
      readCursorsBySessionId:
        cloudGroupReadCursorsBySessionId(canonicalState),
      groupRows: messageIndex.groupRows,
    });
    setCanonicalState((current) =>
      patchCanonicalCloudUnreadCounts(
        current,
        unreadBySessionId,
      )
    );
    setPublishedContextKey((current) =>
      current === unreadContextKey ? current : unreadContextKey
    );
  }, [
    account,
    activeConversationId,
    authoritative,
    canonicalState,
    messageIndex,
    setCanonicalState,
    setPublishedContextKey,
    unreadContextKey,
  ]);
}
