import {
  useEffect,
  useRef,
  type MutableRefObject,
} from 'react';
import type {
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
import type {
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
  cloudSelfAgentForwardMessageKind,
  cloudSelfAgentProgressPolicy,
  cloudSelfAgentShouldPublishProgress,
} from './cloudSelfAgentForwardPolicy';
import {
  CLOUD_SELF_AGENT_HEARTBEAT_MS,
  cloudSelfAgentProcessingLedgerKey,
  publishCloudSelfAgentHeartbeat,
  publishCloudSelfAgentOperations,
} from './cloudSelfAgentForwardExecution';
import { useCloudSelfAgentExecutionStreaming } from './useCloudSelfAgentExecutionStreaming';
import { loadSession } from './session';
import {
  cloudAgentIdentitySyncedSessionIds,
  cloudSyncedLocalAgentSessionIds,
  publishCloudAgentIdentityMarkers,
} from './cloudSelfAgentSessionIdentity';
import {
  loadCanonicalRecoveryMessages,
  loadRemoteRecoveryMessages,
} from './cloudSelfAgentRecoveryMessages';

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
        const historySessionIds = cloudSyncedLocalAgentSessionIds(state);
        for (const sessionId of activeSessionIds) {
          if (!cloudSelfAgentShouldPublishProgress(sessionId, historySessionIds, true)) continue;
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
        const initialLedger = loadCloudSelfAgentSyncLedger(account.accountId);

        const pendingRecoverySessionIds =
          loadCloudSelfAgentRecoverySessionIds(account.accountId);
        const identitySyncedSessionIds = cloudAgentIdentitySyncedSessionIds(
          latestState,
          initialLedger,
        );
        const reconciliation = planCloudSelfAgentSessionReconciliation(
          latestState,
          localChat?.conversations ?? [],
          { identitySyncedSessionIds, pendingRecoverySessionIds },
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

        const identityResult = await publishCloudAgentIdentityMarkers({
          accountId: account.accountId,
          client,
          ledger: initialLedger,
          plans: reconciliation,
          token: session.token,
        });
        if (identityResult.changed) {
          saveCloudSelfAgentSyncLedger(account.accountId, identityResult.ledger);
        }
        const identityLedger = identityResult.ledger;

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
        const historySessionIds = new Set([
          ...recoverySessionIds,
          ...cloudSyncedLocalAgentSessionIds(recoveryState),
        ]);
        let ledger = identityLedger;
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
          const shouldPublishProgress = cloudSelfAgentProgressPolicy(
            historySessionIds,
            activeLocalTurnSessionKey,
          );
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
            messageKindForOperation: (operation) => cloudSelfAgentForwardMessageKind(
              operation,
              historySessionIds,
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
              shouldPublishProgress(operation.sessionId)
            ),
            shouldPublishProcessing: (operation) => (
              shouldPublishProgress(operation.sessionId)
            ),
            executionSnapshotForOperation: (operation) => (
              shouldPublishProgress(operation.sessionId)
                ? executionBySessionIdRef.current[operation.sessionId]
                : undefined
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
    activeLocalTurnSessionKey,
    mergeMessage,
    processedRequestIdsRef,
    reportWarning,
    syncCloudCollaborationDiff,
  ]);
}
