import {
  useEffect,
  useRef,
  type MutableRefObject,
} from 'react';
import type {
  CanonicalSessionMessage,
  CanonicalSessionState,
  DesktopChatTurnSnapshot,
} from '@/kordi-app/types';
import {
  createSingleFlightState,
  requestSingleFlightRun,
} from '@/lib/singleFlight';
import {
  loadChatSyncLocalState,
} from '@/lib/desktopChatSync';
import { fetchCanonicalSessionMessages } from '@/lib/desktop';
import type {
  ChatSyncConversation,
  ChatSyncMessage,
  CloudAccount,
  CloudAuthClient,
  CloudMessage,
} from './authClient';
import {
  loadCloudSelfAgentForwardBaseline,
  loadCloudSelfAgentForwardCutoff,
  loadCloudSelfAgentSyncLedger,
  loadCloudSelfAgentRecoverySessionIds,
  cloudSelfAgentOperationClientMessageId,
  planCloudSelfAgentSessionReconciliation,
  planCloudSelfAgentSync,
  saveCloudSelfAgentForwardBaseline,
  saveCloudSelfAgentForwardCutoff,
  saveCloudSelfAgentSyncLedger,
  saveCloudSelfAgentRecoverySessionIds,
  seedCloudSelfAgentForwardSyncLedger,
} from './cloudSelfAgentForwardSync';
import {
  CLOUD_SELF_AGENT_HEARTBEAT_MS,
  cloudSelfAgentProcessingLedgerKey,
  publishCloudSelfAgentHeartbeat,
  publishCloudSelfAgentOperations,
} from './cloudSelfAgentForwardExecution';
import { useCloudSelfAgentExecutionStreaming } from './useCloudSelfAgentExecutionStreaming';
import { loadSession } from './session';

async function loadCanonicalRecoveryMessages(
  sessionIds: ReadonlySet<string>,
  shouldContinue: () => boolean,
) {
  const pages = await Promise.all([...sessionIds].map(async (sessionId) => {
    const messages: CanonicalSessionMessage[] = [];
    let beforeSequenceNum: number | null = null;
    let pageCount = 0;
    do {
      if (!shouldContinue()) return [];
      const page = await fetchCanonicalSessionMessages(
        sessionId,
        beforeSequenceNum,
        200,
      );
      if (!page) return [];
      messages.push(...page.messages);
      if (!page.hasOlder || page.oldestSequenceNum === null) break;
      beforeSequenceNum = page.oldestSequenceNum;
      pageCount += 1;
      if (pageCount >= 10_000) {
        throw new Error('Canonical agent history pagination did not finish.');
      }
    } while (true);
    return messages;
  }));
  return pages.flat();
}

async function loadRemoteRecoveryMessages(
  client: CloudAuthClient,
  token: string,
  conversations: readonly ChatSyncConversation[],
  sessionIds: ReadonlySet<string>,
  shouldContinue: () => boolean,
): Promise<ChatSyncMessage[]> {
  const conversationBySessionId = new Map(conversations.map((conversation) => [
    conversation.legacy_session_id ?? conversation.id,
    conversation,
  ]));
  const pages = await Promise.all([...sessionIds].map(async (sessionId) => {
    const conversation = conversationBySessionId.get(sessionId);
    if (!conversation || conversation.latest_message_sequence === 0) {
      return [];
    }
    const messages: ChatSyncMessage[] = [];
    let beforeSequence: number | undefined;
    let pageCount = 0;
    do {
      if (!shouldContinue()) return [];
      const page = await client.listChatConversationHistoryPage(
        token,
        conversation.id,
        beforeSequence,
        200,
      );
      messages.push(...page.messages);
      if (!page.hasMore || page.nextBeforeSequence === null) break;
      beforeSequence = page.nextBeforeSequence;
      pageCount += 1;
      if (pageCount >= 10_000) {
        throw new Error('Remote agent history pagination did not finish.');
      }
    } while (true);
    return messages;
  }));
  return pages.flat();
}

export function useCloudSelfAgentForwardSync({
  account,
  canonicalState,
  canonicalStateRef,
  initialMessagesSettled,
  localTurnsBySessionId = {},
  client,
  cancelledRef,
  processedRequestIdsRef,
  mergeMessage,
  syncCloudCollaborationDiff,
  reportWarning,
}: {
  account: CloudAccount | null;
  canonicalState: CanonicalSessionState | null | undefined;
  canonicalStateRef: MutableRefObject<CanonicalSessionState | null>;
  initialMessagesSettled: boolean;
  localTurnsBySessionId?: Record<string, DesktopChatTurnSnapshot>;
  client: CloudAuthClient;
  cancelledRef: MutableRefObject<boolean>;
  processedRequestIdsRef: MutableRefObject<Set<string>>;
  mergeMessage: (message: CloudMessage) => void;
  syncCloudCollaborationDiff: () => Promise<void>;
  reportWarning: (message: string, error: unknown) => void;
}) {
  const syncFlightRef = useRef(createSingleFlightState());
  const executionBySessionIdRef = useCloudSelfAgentExecutionStreaming({
    account,
    canonicalStateRef,
    cancelledRef,
    client,
    localTurnsBySessionId,
    mergeMessage,
    reportWarning,
    syncMessages: syncCloudCollaborationDiff,
  });
  const activeLocalTurnSessionKey = Array.from(new Set(
    Object.values(localTurnsBySessionId)
      .filter((turn) => !turn.completed)
      .map((turn) => turn.sessionId),
  )).sort().join('\u0000');
  useEffect(() => {
    if (!account || !activeLocalTurnSessionKey) return;
    const activeSessionIds = activeLocalTurnSessionKey.split('\u0000');
    let cancelled = false;
    let refreshing = false;
    const publishHeartbeat = () => {
      if (refreshing || cancelled) return;
      refreshing = true;
      void (async () => {
        const state = canonicalStateRef.current;
        const session = await loadSession();
        if (!state || !session?.token || cancelled) return;
        const ledger = loadCloudSelfAgentSyncLedger(account.accountId);
        const heartbeatAtMs = Date.now();
        for (const sessionId of activeSessionIds) {
          const localRequest = state.messages
            .filter((message) => (
              message.sessionId === sessionId
              && message.senderRole === 'user'
              && !message.sourceTransport?.startsWith('cloud-')
            ))
            .sort((left, right) => (
              right.sequenceNum - left.sequenceNum
              || right.createdAtMs - left.createdAtMs
            ))[0];
          const cloudRequestMessageId = localRequest
            ? ledger[localRequest.id]?.cloudMessageId ?? null
            : null;
          if (!localRequest || !cloudRequestMessageId || cancelled) continue;
          const heartbeat = await publishCloudSelfAgentHeartbeat({
            accountId: account.accountId,
            client,
            cloudRequestMessageId,
            execution: executionBySessionIdRef.current[sessionId],
            localRequestMessageId: localRequest.id,
            nowMs: heartbeatAtMs,
            sessionId,
            token: session.token,
          });
          mergeMessage(heartbeat);
        }
        if (!cancelled) await syncCloudCollaborationDiff();
      })().catch((error) => {
        reportWarning(
          '[cloud-self-agent-sync] failed to refresh execution claim',
          error,
        );
      }).finally(() => {
        refreshing = false;
      });
    };
    const intervalId = window.setInterval(
      publishHeartbeat,
      CLOUD_SELF_AGENT_HEARTBEAT_MS,
    );
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    account,
    activeLocalTurnSessionKey,
    canonicalStateRef,
    client,
    executionBySessionIdRef,
    mergeMessage,
    reportWarning,
    syncCloudCollaborationDiff,
  ]);

  useEffect(() => {
    if (!account || !initialMessagesSettled) return;

    void requestSingleFlightRun(syncFlightRef.current, async () => {
      try {
        const latestState =
          canonicalStateRef.current ?? canonicalState ?? null;
        if (!latestState) return;
        const [session, localChat] = await Promise.all([
          loadSession(),
          loadChatSyncLocalState(account.accountId),
        ]);
        if (!session?.token || cancelledRef.current) return;

        const pendingRecoverySessionIds =
          loadCloudSelfAgentRecoverySessionIds(account.accountId);
        const reconciliation = planCloudSelfAgentSessionReconciliation(
          latestState,
          localChat?.conversations ?? [],
          { pendingRecoverySessionIds },
        );
        for (const plan of reconciliation) {
          if (plan.recoverHistory) {
            pendingRecoverySessionIds.add(plan.sessionId);
          }
        }
        // Persist the recovery intent before creating any remote rows. A crash
        // after conversation creation must resume the historical snapshot
        // upload instead of mistaking a partially-filled conversation for a
        // completed migration.
        saveCloudSelfAgentRecoverySessionIds(
          account.accountId,
          pendingRecoverySessionIds,
        );
        const conversationsToCreate = reconciliation.filter(
          (plan) => plan.createConversation,
        );
        const createdConversations = await Promise.all(
          conversationsToCreate.map((plan) => (
            client.ensureChatConversation(session.token, {
              accountId: account.accountId,
              peerAccountId: account.accountId,
              sessionId: plan.sessionId,
              kind: 'ai',
              memberAccountIds: [account.accountId],
              sharedTitle: plan.title,
            })
          )),
        );
        if (cancelledRef.current) return;

        const recoverySessionIds = new Set(pendingRecoverySessionIds);
        const [canonicalRecoveryMessages, remoteRecoveryMessages] =
          await Promise.all([
            loadCanonicalRecoveryMessages(
              recoverySessionIds,
              () => !cancelledRef.current,
            ),
            loadRemoteRecoveryMessages(
              client,
              session.token,
              [
                ...(localChat?.conversations ?? []),
                ...createdConversations,
              ],
              recoverySessionIds,
              () => !cancelledRef.current,
            ),
          ]);
        if (cancelledRef.current) return;
        const remoteMessages = [
          ...(localChat?.messages ?? []),
          ...remoteRecoveryMessages,
        ];
        const remoteMessageIds = new Set(
          remoteMessages.map((message) => message.id),
        );
        const remoteMessageByClientId = new Map(
          remoteMessages.map((message) => [
            message.client_message_id,
            message,
          ]),
        );
        const recoveryState = {
          ...latestState,
          messages: [
            ...latestState.messages.filter((message) => (
              !recoverySessionIds.has(message.sessionId)
            )),
            ...canonicalRecoveryMessages.filter((message) => !(
              message.sourceTransport === 'cloud-self-agent'
              && message.sourceEventId
              && remoteMessageIds.has(message.sourceEventId)
            )),
          ],
        };
        let ledger = loadCloudSelfAgentSyncLedger(account.accountId);
        let forwardCutoffMs = loadCloudSelfAgentForwardCutoff(
          account.accountId,
        );
        if (!loadCloudSelfAgentForwardBaseline(account.accountId)) {
          const seeded = seedCloudSelfAgentForwardSyncLedger(
            recoveryState,
            ledger,
          );
          if (seeded.changed) {
            saveCloudSelfAgentSyncLedger(
              account.accountId,
              seeded.ledger,
            );
            ledger = seeded.ledger;
          }
          saveCloudSelfAgentForwardBaseline(account.accountId);
          forwardCutoffMs = saveCloudSelfAgentForwardCutoff(
            account.accountId,
          );
        }
        // Older app versions stored only a boolean baseline. Establish a
        // timestamp boundary before planning so history that appears later via
        // SQLite pagination is never mistaken for a newly-created live turn.
        forwardCutoffMs ??= saveCloudSelfAgentForwardCutoff(
          account.accountId,
        );
        const allRecoveryOperations = planCloudSelfAgentSync(
          recoveryState,
          ledger,
          {
            createdAfterMs: forwardCutoffMs,
            recoverSessionIds: recoverySessionIds,
          },
        );
        let ledgerChanged = false;
        ledger = { ...ledger };
        for (const operation of allRecoveryOperations) {
          const remote = remoteMessageByClientId.get(
            cloudSelfAgentOperationClientMessageId(operation),
          );
          if (!remote) continue;
          ledger[operation.localMessageId] = {
            cloudMessageId: remote.id,
            syncedAtMs: Date.now(),
          };
          ledgerChanged = true;
        }
        if (ledgerChanged) {
          saveCloudSelfAgentSyncLedger(account.accountId, ledger);
        }
        const operations = planCloudSelfAgentSync(
          recoveryState,
          ledger,
          {
            createdAfterMs: forwardCutoffMs,
            recoverSessionIds: recoverySessionIds,
            remoteClientMessageIds: new Set(
              remoteMessageByClientId.keys(),
            ),
          },
        );
        if (operations.length > 0) {
          const executionLedger = { ...ledger };
          for (const operation of operations) {
            if (!recoverySessionIds.has(operation.sessionId)) continue;
            delete executionLedger[operation.localMessageId];
            if (operation.role === 'user') {
              delete executionLedger[
                cloudSelfAgentProcessingLedgerKey(
                  operation.localMessageId,
                )
              ];
            }
          }
          await publishCloudSelfAgentOperations({
            accountId: account.accountId,
            client,
            ledger: executionLedger,
            mergeMessage,
            messageKindForOperation: (operation) => (
              recoverySessionIds.has(operation.sessionId)
                ? operation.role === 'user'
                  ? 'canonical-history-user'
                  : 'canonical-history-agent'
                : null
            ),
            onRequestPublished: (message, operation) => {
              if (!recoverySessionIds.has(operation.sessionId)) {
                processedRequestIdsRef.current.add(message.messageId);
              }
            },
            operations,
            saveLedger: (nextLedger) => {
              saveCloudSelfAgentSyncLedger(
                account.accountId,
                nextLedger,
              );
            },
            shouldContinue: () => !cancelledRef.current,
            shouldMergeMessage: (operation) => (
              !recoverySessionIds.has(operation.sessionId)
            ),
            shouldPublishProcessing: (operation) => (
              !recoverySessionIds.has(operation.sessionId)
            ),
            executionSnapshotForOperation: (operation) => (
              recoverySessionIds.has(operation.sessionId)
                ? undefined
                : executionBySessionIdRef.current[operation.sessionId]
            ),
            token: session.token,
          });
        }
        if (
          reconciliation.length > 0
          || operations.length > 0
        ) await syncCloudCollaborationDiff();
        saveCloudSelfAgentRecoverySessionIds(
          account.accountId,
          new Set(),
        );
      } catch (error) {
        reportWarning(
          '[cloud-self-agent-sync] failed to reconcile agent sessions',
          error,
        );
      }
    });
  }, [
    account,
    cancelledRef,
    canonicalState,
    canonicalStateRef,
    client,
    executionBySessionIdRef,
    initialMessagesSettled,
    mergeMessage,
    processedRequestIdsRef,
    reportWarning,
    syncCloudCollaborationDiff,
  ]);
}
