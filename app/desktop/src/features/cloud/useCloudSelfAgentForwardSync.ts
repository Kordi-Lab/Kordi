import {
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import type { CanonicalSessionState } from '@/kordi-app/types';
import type {
  CloudAccount,
  CloudAuthClient,
  CloudMessage,
} from './authClient';
import { encodeCloudAgentResponse } from './cloudAgentMessages';
import {
  loadCloudSelfAgentForwardBaseline,
  loadCloudSelfAgentSyncLedger,
  planCloudSelfAgentSync,
  saveCloudSelfAgentForwardBaseline,
  saveCloudSelfAgentSyncLedger,
  seedCloudSelfAgentForwardSyncLedger,
  type CloudSelfAgentSyncStatus,
} from './cloudSelfAgentForwardSync';
import { loadSession } from './session';

export function useCloudSelfAgentForwardSync({
  account,
  canonicalState,
  canonicalStateRef,
  client,
  cancelledRef,
  processedRequestIdsRef,
  setSyncStatusBySessionId,
  mergeMessage,
  syncCloudCollaborationDiff,
  reportWarning,
}: {
  account: CloudAccount | null;
  canonicalState: CanonicalSessionState | null | undefined;
  canonicalStateRef: MutableRefObject<CanonicalSessionState | null>;
  client: CloudAuthClient;
  cancelledRef: MutableRefObject<boolean>;
  processedRequestIdsRef: MutableRefObject<Set<string>>;
  setSyncStatusBySessionId: Dispatch<
    SetStateAction<Record<string, CloudSelfAgentSyncStatus>>
  >;
  mergeMessage: (message: CloudMessage) => void;
  syncCloudCollaborationDiff: () => Promise<void>;
  reportWarning: (message: string, error: unknown) => void;
}) {
  const syncingRef = useRef(false);

  useEffect(() => {
    if (!account || syncingRef.current) return;

    syncingRef.current = true;
    let plannedSessionIds: string[] = [];
    void (async () => {
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
        return;
      }
      const operations = planCloudSelfAgentSync(
        latestState,
        initialLedger,
      );
      if (operations.length === 0) return;

      plannedSessionIds = [
        ...new Set(
          operations.map((operation) => operation.sessionId),
        ),
      ];
      const session = await loadSession();
      if (!session?.token) return;
      const pendingBySession = operations.reduce<Record<string, number>>(
        (counts, operation) => {
          counts[operation.sessionId] =
            (counts[operation.sessionId] ?? 0) + 1;
          return counts;
        },
        {},
      );
      setSyncStatusBySessionId((current) => {
        const next = { ...current };
        for (
          const [sessionId, pendingCount]
          of Object.entries(pendingBySession)
        ) {
          next[sessionId] = {
            state: 'syncing',
            pendingCount,
            updatedAtMs: Date.now(),
          };
        }
        return next;
      });
      const ledger = loadCloudSelfAgentSyncLedger(account.accountId);
      for (const operation of operations) {
        if (cancelledRef.current) return;
        if (ledger[operation.localMessageId]) continue;
        let body = operation.text;
        if (operation.role === 'agent') {
          const parentCloudMessageId = operation.parentLocalMessageId
            ? ledger[operation.parentLocalMessageId]?.cloudMessageId
              ?? null
            : null;
          if (!parentCloudMessageId) continue;
          body = encodeCloudAgentResponse({
            requestId: parentCloudMessageId,
            text: operation.text,
          });
        }
        const message = await client.sendMessage(
          session.token,
          account.accountId,
          body,
          {
            sessionId: operation.sessionId,
            clientCreatedAt:
              new Date(operation.createdAtMs).toISOString(),
          },
        );
        if (operation.role === 'user') {
          // These are historical local-agent requests, not fresh Cloud asks.
          // Suppress the direct-agent runner so backfill does not answer old
          // prompts a second time before the historical response is uploaded.
          processedRequestIdsRef.current.add(message.messageId);
        }
        ledger[operation.localMessageId] = {
          cloudMessageId: message.messageId,
          syncedAtMs: Date.now(),
        };
        saveCloudSelfAgentSyncLedger(account.accountId, ledger);
        pendingBySession[operation.sessionId] = Math.max(
          0,
          (pendingBySession[operation.sessionId] ?? 1) - 1,
        );
        setSyncStatusBySessionId((current) => ({
          ...current,
          [operation.sessionId]:
            pendingBySession[operation.sessionId] > 0
              ? {
                  state: 'syncing',
                  pendingCount: pendingBySession[operation.sessionId],
                  updatedAtMs: Date.now(),
                }
              : {
                  state: 'synced',
                  updatedAtMs: Date.now(),
                },
        }));
        mergeMessage(message);
      }
      await syncCloudCollaborationDiff();
    })()
      .catch((error) => {
        const message =
          error instanceof Error ? error.message : String(error);
        if (plannedSessionIds.length > 0) {
          setSyncStatusBySessionId((current) => {
            const next = { ...current };
            for (const sessionId of plannedSessionIds) {
              next[sessionId] = {
                state: 'error',
                message,
                updatedAtMs: Date.now(),
              };
            }
            return next;
          });
        }
        reportWarning(
          '[cloud-self-agent-sync] failed to sync local history',
          error,
        );
      })
      .finally(() => {
        syncingRef.current = false;
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
    setSyncStatusBySessionId,
    syncCloudCollaborationDiff,
  ]);
}
