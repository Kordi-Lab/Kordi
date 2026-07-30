import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import {
  cancelDesktopChatTurn,
  upsertCanonicalMessageFast,
} from '@/lib/desktop';
import type {
  CanonicalSessionMessage,
  CanonicalSessionState,
} from '@/kordi-app/types';
import type { CloudAccount } from './authClient';
import {
  cloudGroupAgentCancelledNoticeRequest,
  cloudGroupAgentCancelRoleForRequest,
  cloudGroupAgentProcessingMessageForRequest,
} from './cloudAgentCancellation';
import { parseCloudAgentCancel } from './cloudAgentMessages';
import { cloudGroupAgentConversationId } from './cloudGroupMessages';
import type { CloudMessageIndex } from './cloudMessageIndex';
import {
  collapseCloudAgentOfflinePlaceholderForRequest,
  upsertCanonicalRequestIntoLocalState,
} from './cloudAgentRequestState';

export function useCloudAgentCancellation({
  account,
  canonicalStateRef,
  setCanonicalState,
  messageIndex,
  initialMessagesSettled,
  processedRequestIdsRef,
  turnIdsByRequestIdRef,
  reportWarning,
}: {
  account: CloudAccount | null;
  canonicalStateRef: MutableRefObject<CanonicalSessionState | null>;
  setCanonicalState?: Dispatch<
    SetStateAction<CanonicalSessionState | null>
  >;
  messageIndex: CloudMessageIndex;
  initialMessagesSettled: boolean;
  processedRequestIdsRef: MutableRefObject<Set<string>>;
  turnIdsByRequestIdRef: MutableRefObject<Map<string, string>>;
  reportWarning: (message: string, error: unknown) => void;
}) {
  useEffect(() => {
    if (!account || !initialMessagesSettled) return;
    for (const message of messageIndex.allMessages) {
      if (
        message.fromAccountId !== account.accountId
        && message.toAccountId !== account.accountId
      ) continue;
      const cancel = parseCloudAgentCancel(message.body);
      if (!cancel) continue;
      processedRequestIdsRef.current.add(cancel.requestId);
      const turnId = turnIdsByRequestIdRef.current.get(cancel.requestId);
      if (turnId) {
        void cancelDesktopChatTurn(turnId)
          .catch((error) => {
            reportWarning(
              '[cloud-agent-mention] local agent cancel failed',
              error,
            );
          })
          .finally(() => {
            turnIdsByRequestIdRef.current.delete(cancel.requestId);
          });
      }
      const currentCanonicalState = canonicalStateRef.current;
      if (!currentCanonicalState || !setCanonicalState) continue;
      const processingMessage = currentCanonicalState.messages
        .map((candidate) => cloudGroupAgentProcessingMessageForRequest(
          [candidate],
          candidate.sessionId,
          cancel.requestId,
        ))
        .find((
          candidate,
        ): candidate is CanonicalSessionMessage => Boolean(candidate));
      if (!processingMessage) continue;
      if (currentCanonicalState.messages.some((candidate) => {
        const content =
          candidate.content
          && typeof candidate.content === 'object'
          && !Array.isArray(candidate.content)
            ? candidate.content as Record<string, unknown>
            : {};
        return candidate.status === 'cancelled'
          && candidate.sourceTransport === 'cloud-group-agent'
          && (
            typeof content.requestId === 'string'
              ? content.requestId.trim()
              : ''
          ) === cancel.requestId;
      })) continue;
      const cancelCreatedAtMs = Date.parse(message.createdAt);
      const cancelDeliveredAtMs = Date.parse(message.deliveredAt ?? '');
      const cancelNoticeRequest = cloudGroupAgentCancelledNoticeRequest({
        processingMessage,
        requestId: cancel.requestId,
        conversationId: cloudGroupAgentConversationId(
          processingMessage.sessionId,
        ),
        cancelledByAccountId: message.fromAccountId,
        cancelledByRole: cloudGroupAgentCancelRoleForRequest({
          state: currentCanonicalState,
          requestId: cancel.requestId,
          processingMessage,
          cancelledByAccountId: message.fromAccountId,
        }),
        now: Number.isFinite(cancelCreatedAtMs)
          ? cancelCreatedAtMs
          : Number.isFinite(cancelDeliveredAtMs)
            ? cancelDeliveredAtMs
            : undefined,
      });
      setCanonicalState((current) => {
        const nextState = upsertCanonicalRequestIntoLocalState(
          current,
          cancelNoticeRequest,
        );
        if (!nextState) return nextState;
        const collapsedState =
          collapseCloudAgentOfflinePlaceholderForRequest(
            nextState,
            processingMessage,
            cancel.requestId,
          );
        canonicalStateRef.current = collapsedState;
        return collapsedState;
      });
      void upsertCanonicalMessageFast(cancelNoticeRequest)
        .catch((error) => {
          reportWarning(
            '[cloud-agent-mention] group cancel notice failed',
            error,
          );
        });
    }
  }, [
    account,
    canonicalStateRef,
    initialMessagesSettled,
    messageIndex,
    processedRequestIdsRef,
    reportWarning,
    setCanonicalState,
    turnIdsByRequestIdRef,
  ]);
}
