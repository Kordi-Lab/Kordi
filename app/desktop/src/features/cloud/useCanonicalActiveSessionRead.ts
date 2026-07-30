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
import type {
  CloudAccount,
} from './authClient';
import {
  isSharedCloudSessionId,
} from './cloudSelfAgentCanonicalSync';

export function useCanonicalActiveSessionRead({
  account,
  activeConversationId,
  canonicalState,
  setCanonicalState,
}: {
  account: CloudAccount | null;
  activeConversationId: string | null | undefined;
  canonicalState: CanonicalSessionState | null | undefined;
  setCanonicalState?: Dispatch<
    SetStateAction<CanonicalSessionState | null>
  >;
}) {
  const persistedReadSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    persistedReadSignatureRef.current = null;
  }, [account?.accountId]);

  useEffect(() => {
    const sessionId = activeConversationId?.trim() ?? '';
    if (
      !account
      || !sessionId
      || !isSharedCloudSessionId(sessionId)
      || !canonicalState
    ) return;
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
    if (!latestMessage) return;
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
    if (
      selfParticipant?.lastReadMessageId === latestMessage.id
    ) return;

    const signature =
      `${account.accountId}:${sessionId}:${latestMessage.id}`;
    if (persistedReadSignatureRef.current === signature) return;
    persistedReadSignatureRef.current = signature;
    void markCanonicalSessionRead({
      sessionId,
      messageId: latestMessage.id,
    })
      .then((delta) => {
        setCanonicalState?.((current) =>
          mergeCanonicalReadCursorDelta(current, delta)
        );
      })
      .catch(() => {
        persistedReadSignatureRef.current = null;
      });
  }, [
    account,
    activeConversationId,
    canonicalState,
    setCanonicalState,
  ]);
}
