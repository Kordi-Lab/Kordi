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
import type {
  CloudAccount,
  CloudAuthClient,
  CloudMessage,
} from './authClient';
import {
  loadCloudSelfAgentForwardBaseline,
  loadCloudSelfAgentForwardCutoff,
  loadCloudSelfAgentSyncLedger,
  planCloudSelfAgentSync,
  saveCloudSelfAgentForwardBaseline,
  saveCloudSelfAgentForwardCutoff,
  saveCloudSelfAgentSyncLedger,
  seedCloudSelfAgentForwardSyncLedger,
} from './cloudSelfAgentForwardSync';
import {
  CLOUD_SELF_AGENT_HEARTBEAT_MS,
  publishCloudSelfAgentHeartbeat,
  publishCloudSelfAgentOperations,
} from './cloudSelfAgentForwardExecution';
import { loadSession } from './session';

export function useCloudSelfAgentForwardSync({
  account,
  canonicalState,
  canonicalStateRef,
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
  localTurnsBySessionId?: Record<string, DesktopChatTurnSnapshot>;
  client: CloudAuthClient;
  cancelledRef: MutableRefObject<boolean>;
  processedRequestIdsRef: MutableRefObject<Set<string>>;
  mergeMessage: (message: CloudMessage) => void;
  syncCloudCollaborationDiff: () => Promise<void>;
  reportWarning: (message: string, error: unknown) => void;
}) {
  const syncFlightRef = useRef(createSingleFlightState());
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
    mergeMessage,
    reportWarning,
    syncCloudCollaborationDiff,
  ]);

  useEffect(() => {
    if (!account) return;

    void requestSingleFlightRun(syncFlightRef.current, async () => {
      try {
        const latestState =
          canonicalStateRef.current ?? canonicalState ?? null;
        if (!latestState) return;
        const initialLedger = loadCloudSelfAgentSyncLedger(
          account.accountId,
        );
        if (!loadCloudSelfAgentForwardBaseline(account.accountId)) {
          const seeded = seedCloudSelfAgentForwardSyncLedger(
            latestState,
            initialLedger,
          );
          if (seeded.changed) {
            saveCloudSelfAgentSyncLedger(
              account.accountId,
              seeded.ledger,
            );
          }
          saveCloudSelfAgentForwardBaseline(account.accountId);
          saveCloudSelfAgentForwardCutoff(account.accountId);
          return;
        }
        // Older app versions stored only a boolean baseline. Establish a
        // timestamp boundary before planning so history that appears later via
        // SQLite pagination is never mistaken for a newly-created live turn.
        const forwardCutoffMs = loadCloudSelfAgentForwardCutoff(
          account.accountId,
        ) ?? saveCloudSelfAgentForwardCutoff(account.accountId);
        const operations = planCloudSelfAgentSync(
          latestState,
          initialLedger,
          { createdAfterMs: forwardCutoffMs },
        );
        if (operations.length === 0) return;

        const session = await loadSession();
        if (!session?.token) return;
        const ledger = loadCloudSelfAgentSyncLedger(account.accountId);
        if (cancelledRef.current) return;
        await publishCloudSelfAgentOperations({
          accountId: account.accountId,
          client,
          ledger,
          mergeMessage,
          onRequestPublished: (message) => {
            processedRequestIdsRef.current.add(message.messageId);
          },
          operations,
          saveLedger: (nextLedger) => {
            saveCloudSelfAgentSyncLedger(account.accountId, nextLedger);
          },
          shouldContinue: () => !cancelledRef.current,
          token: session.token,
        });
        await syncCloudCollaborationDiff();
      } catch (error) {
        reportWarning(
          '[cloud-self-agent-sync] failed to sync local history',
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
    mergeMessage,
    processedRequestIdsRef,
    reportWarning,
    syncCloudCollaborationDiff,
  ]);
}
