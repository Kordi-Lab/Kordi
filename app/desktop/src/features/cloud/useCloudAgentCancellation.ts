import {
  useCallback,
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
  DesktopCollaborationState,
} from '@/kordi-app/types';
import { mergeCanonicalMessageRow } from '@/features/canonical/canonicalStateReducers';
import type {
  CloudAccount,
  CloudAuthClient,
  CloudMessage,
} from './authClient';
import {
  cloudGroupAgentCancelledNoticeRequest,
  cloudGroupAgentCancelRoleForRequest,
  cloudGroupAgentProcessingMessageForRequest,
  optimisticCloudAgentCancelMessage,
} from './cloudAgentCancellation';
import {
  encodeCloudAgentCancel,
  parseCloudAgentCancel,
} from './cloudAgentMessages';
import {
  cloudPeerAccountIdFromConversationId,
} from './cloudCollaborationState';
import {
  cloudGroupAgentConversationId,
  cloudGroupIdFromAgentConversationId,
} from './cloudGroupMessages';
import type { CloudMessageIndex } from './cloudMessageIndex';
import {
  cloudAgentCancelOperationId,
  cloudMessageRecipientOperationId,
} from './cloudMessageLifecycle';
import {
  collapseCloudAgentOfflinePlaceholderForRequest,
} from './cloudAgentRequestState';
import {
  loadSession,
} from './session';

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
      void upsertCanonicalMessageFast(cancelNoticeRequest)
        .then((persistedNotice) => {
          setCanonicalState((current) => {
            const nextState = mergeCanonicalMessageRow(
              current,
              persistedNotice,
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
        })
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

export function useCloudAgentRequestCancellation({
  account,
  client,
  canonicalState,
  setCanonicalState,
  messageIndex,
  mergeMessage,
  syncDiff,
  processedRequestIdsRef,
  turnIdsByRequestIdRef,
  setCollaborationOverride,
}: {
  account: CloudAccount | null;
  client: CloudAuthClient;
  canonicalState?: CanonicalSessionState | null;
  setCanonicalState?: Dispatch<
    SetStateAction<CanonicalSessionState | null>
  >;
  messageIndex: CloudMessageIndex;
  mergeMessage: (message: CloudMessage) => void;
  syncDiff: () => Promise<void>;
  processedRequestIdsRef: MutableRefObject<Set<string>>;
  turnIdsByRequestIdRef: MutableRefObject<Map<string, string>>;
  setCollaborationOverride: Dispatch<
    SetStateAction<DesktopCollaborationState | null>
  >;
}) {
  return useCallback(async (
    conversationId: string,
    requestId: string,
  ) => {
    const trimmedRequestId = requestId.trim();
    if (!trimmedRequestId) {
      throw new Error('Unable to resolve request.');
    }
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    const cloudRun = await client.cancelCloudAgentRunForRequest(
      session.token,
      trimmedRequestId,
    ).catch(() => null);
    if (cloudRun?.status === 'completed' || cloudRun?.status === 'failed') {
      await syncDiff();
      setCollaborationOverride(null);
      return;
    }

    const groupId =
      cloudGroupIdFromAgentConversationId(conversationId);
    if (groupId) {
      processedRequestIdsRef.current.add(trimmedRequestId);
      const turnId =
        turnIdsByRequestIdRef.current.get(trimmedRequestId);
      if (turnId) {
        await cancelDesktopChatTurn(turnId).finally(() => {
          turnIdsByRequestIdRef.current.delete(trimmedRequestId);
        });
      }
      const processingMessage = canonicalState
        ? cloudGroupAgentProcessingMessageForRequest(
            canonicalState.messages,
            groupId,
            trimmedRequestId,
          )
        : null;
      if (
        processingMessage
        && setCanonicalState
        && account
        && canonicalState
      ) {
        const cancelNoticeRequest =
          cloudGroupAgentCancelledNoticeRequest({
            processingMessage,
            requestId: trimmedRequestId,
            conversationId,
            cancelledByAccountId: account.accountId,
            cancelledByRole: cloudGroupAgentCancelRoleForRequest({
              state: canonicalState,
              requestId: trimmedRequestId,
              processingMessage,
              cancelledByAccountId: account.accountId,
            }),
            now: Date.now(),
          });
        const persistedNotice = await upsertCanonicalMessageFast(
          cancelNoticeRequest,
        );
        // Apply the cancel and offline-placeholder removal together so
        // the replacement notice cannot flicker between renders.
        setCanonicalState((current) => {
          const cancelledState = mergeCanonicalMessageRow(
            current,
            persistedNotice,
          );
          if (!cancelledState) return cancelledState;
          return collapseCloudAgentOfflinePlaceholderForRequest(
            cancelledState,
            processingMessage,
            trimmedRequestId,
          );
        });
      }
      const cancelBody = encodeCloudAgentCancel({
        requestId: trimmedRequestId,
      });
      const groupEnvelope = messageIndex.groupRows.find((row) => (
        row.envelope.kind === 'group-message'
        && row.envelope.groupId === groupId
        && row.canonicalMessageId === trimmedRequestId
      ))?.envelope;
      const targetAccountIds = [...new Set(
        (groupEnvelope?.participants ?? [])
          .map((participant) => participant.accountId.trim())
          .filter(
            (accountId) =>
              Boolean(accountId)
              && accountId !== account?.accountId,
          ),
      )];
      const sent = await Promise.allSettled(
        targetAccountIds.map(
          (targetAccountId) => client.sendMessage(
            session.token,
            targetAccountId,
            cancelBody,
            {
              clientMessageId: cloudMessageRecipientOperationId(
                cloudAgentCancelOperationId(trimmedRequestId),
                targetAccountId,
              ),
            },
          ),
        ),
      );
      sent.forEach((result) => {
        if (result.status === 'fulfilled') {
          mergeMessage(result.value);
        }
      });
      await syncDiff();
      setCollaborationOverride(null);
      return;
    }

    const peerId =
      cloudPeerAccountIdFromConversationId(conversationId);
    if (!peerId || !account) {
      throw new Error('Unable to resolve request.');
    }
    mergeMessage(optimisticCloudAgentCancelMessage({
      account,
      peerAccountId: peerId,
      requestId: trimmedRequestId,
    }));
    const message = await client.sendMessage(
      session.token,
      peerId,
      encodeCloudAgentCancel({ requestId: trimmedRequestId }),
      {
        clientMessageId: cloudMessageRecipientOperationId(
          cloudAgentCancelOperationId(trimmedRequestId),
          peerId,
        ),
      },
    );
    mergeMessage(message);
    await syncDiff();
    setCollaborationOverride(null);
  }, [
    account,
    canonicalState,
    client,
    mergeMessage,
    messageIndex,
    processedRequestIdsRef,
    setCanonicalState,
    setCollaborationOverride,
    syncDiff,
    turnIdsByRequestIdRef,
  ]);
}
