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
  const persistedReadSignatureRef = useRef<string | null>(null);
  const accountId = account?.accountId ?? '';

  useEffect(() => {
    persistedReadSignatureRef.current = null;
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
        && ![
          'canonical-fork-snapshot',
          'cloud-group-fork-snapshot',
        ].includes(message.sourceTransport ?? '')
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
    if (persistedReadSignatureRef.current === signature) return;
    persistedReadSignatureRef.current = signature;
    const localRead = !latestMessage
      || selfParticipant?.lastReadMessageId === latestMessage.id
      ? Promise.resolve(null)
      : markCanonicalSessionRead({
          sessionId,
          messageId: latestMessage.id,
        });
    const cloudRead = markRead([sessionId]);
    void Promise.all([localRead, cloudRead])
      .then(([delta]) => {
        if (delta) {
          setCanonicalState?.((current) =>
            mergeCanonicalReadCursorDelta(current, delta)
          );
        }
      })
      .catch(() => {
        persistedReadSignatureRef.current = null;
      });
  }, [
    accountId,
    activeConversationId,
    canMarkActiveConversationRead,
    canonicalState,
    markRead,
    setCanonicalState,
  ]);
}
