import {
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  markCanonicalSessionRead,
} from '@/lib/desktop';
import {
  mergeCanonicalReadCursorDelta,
} from '@/features/canonical/canonicalStateReducers';
import type {
  CanonicalSessionState,
} from '@/kordi-app/types';
import {
  cloudConversationKindFromConversationId,
  cloudDirectPersonSessionId,
  cloudPeerAccountIdFromConversationId,
  cloudSessionIdFromConversationId,
} from '@/features/collaboration/conversationIds';
import type {
  CloudAccount,
} from './authClient';

export function canonicalActiveSessionId(
  activeConversationId: string | null | undefined,
  accountId: string,
): string {
  const activeId = activeConversationId?.trim() ?? '';
  const explicitSessionId = cloudSessionIdFromConversationId(activeId);
  if (explicitSessionId) return explicitSessionId;
  const peerAccountId = cloudPeerAccountIdFromConversationId(activeId);
  return peerAccountId
    && cloudConversationKindFromConversationId(activeId) === 'person'
    ? cloudDirectPersonSessionId(accountId, peerAccountId)
    : activeId;
}

export function useCanonicalActiveSessionRead({
  account,
  activeConversationId,
  canMarkActiveConversationRead,
  canonicalState,
  markRead,
  setCanonicalState,
}: {
  account: CloudAccount | null;
  activeConversationId: string | null | undefined;
  canMarkActiveConversationRead: boolean;
  canonicalState: CanonicalSessionState | null | undefined;
  markRead: (sessionIds: string[]) => Promise<void>;
  setCanonicalState?: Dispatch<
    SetStateAction<CanonicalSessionState | null>
  >;
}) {
  const readRequestRef = useRef<{ signature: string } | null>(null);
  const accountScopeRef = useRef<object | null>(null);
  const accountId = account?.accountId ?? '';

  useEffect(() => {
    const scope = {};
    accountScopeRef.current = scope;
    readRequestRef.current = null;
    return () => {
      accountScopeRef.current = null;
    };
  }, [accountId]);

  useEffect(() => {
    const sessionId = canonicalActiveSessionId(
      activeConversationId,
      accountId,
    );
    if (
      !accountId
      || !canMarkActiveConversationRead
      || !sessionId
      || !canonicalState
    ) return;
    const canonicalSession = canonicalState.sessions.find(
      (session) => session.id === sessionId,
    );
    const latestMessages = canonicalState.messages
      .filter((message) => (
        message.sessionId === sessionId
        && message.sourceTransport !== 'canonical-fork-snapshot'
        && !['sending', 'processing'].includes(
          message.status.trim().toLowerCase(),
        )
      ))
      .sort((left, right) =>
        left.sequenceNum - right.sequenceNum
        || left.createdAtMs - right.createdAtMs
      );
    const latestMessage =
      latestMessages[latestMessages.length - 1];
    const selfParticipant = canonicalState.participants.find(
      (participant) => (
        participant.sessionId === sessionId
        && participant.role === 'self'
        && (
          !canonicalState.profile.humanIdentityId
          || participant.identityId
            === canonicalState.profile.humanIdentityId
        )
      ),
    ) ?? canonicalState.participants.find(
      (participant) =>
        participant.sessionId === sessionId
        && participant.role === 'self',
    );
    const readTarget = latestMessage?.id
      ?? `${canonicalSession?.lastMessageAtMs ?? 0}:${canonicalSession?.updatedAtMs ?? 0}`;
    const signature =
      `${accountId}:${sessionId}:${readTarget}`;
    if (readRequestRef.current?.signature === signature) return;
    const request = { signature };
    const accountScope = accountScopeRef.current;
    readRequestRef.current = request;
    const allowRetry = () => {
      if (accountScopeRef.current === accountScope && readRequestRef.current === request) {
        readRequestRef.current = null;
      }
    };
    const localRead = !latestMessage
      || selfParticipant?.lastReadMessageId === latestMessage.id
      ? Promise.resolve(null)
      : markCanonicalSessionRead({
          sessionId,
          messageId: latestMessage.id,
        });
    // Publish the durable local cursor without waiting for network read or
    // preference acknowledgments. Navigation must not cancel an observed read.
    void localRead
      .then((delta) => {
        if (delta && accountScopeRef.current === accountScope) {
          setCanonicalState?.((current) =>
            accountScopeRef.current === accountScope
              ? mergeCanonicalReadCursorDelta(current, delta)
              : current
          );
        }
      })
      .catch(allowRetry);
    // Cloud repair still runs even when the local cursor is already current.
    void markRead([sessionId]).catch(allowRetry);
  }, [
    accountId,
    activeConversationId,
    canMarkActiveConversationRead,
    canonicalState,
    markRead,
    setCanonicalState,
  ]);
}
