import { useEffect, useRef, type MutableRefObject } from 'react';

import type {
  CanonicalSessionState,
  DesktopChatTurnSnapshot,
} from '@/kordi-app/types';
import type {
  CloudAccount,
  CloudAuthClient,
  CloudMessage,
} from './authClient';
import {
  cloudAgentExecutionFingerprint,
  cloudAgentExecutionSnapshotFromTurn,
} from './cloudAgentExecutionTrace';
import type { CloudAgentExecutionSnapshot } from './cloudAgentMessages';
import {
  CLOUD_SELF_AGENT_EXECUTION_STREAM_MS,
  publishCloudSelfAgentExecutionSnapshot,
} from './cloudSelfAgentForwardExecution';
import { loadCloudSelfAgentSyncLedger } from './cloudSelfAgentForwardSync';
import { loadSession } from './session';

export function useCloudSelfAgentExecutionStreaming({
  account,
  canonicalStateRef,
  cancelledRef,
  client,
  localTurnsBySessionId,
  mergeMessage,
  reportWarning,
  syncMessages,
}: {
  account: CloudAccount | null;
  canonicalStateRef: MutableRefObject<CanonicalSessionState | null>;
  cancelledRef: MutableRefObject<boolean>;
  client: CloudAuthClient;
  localTurnsBySessionId: Record<string, DesktopChatTurnSnapshot>;
  mergeMessage: (message: CloudMessage) => void;
  reportWarning: (message: string, error: unknown) => void;
  syncMessages: () => Promise<void>;
}) {
  const executionBySessionIdRef = useRef<
    Record<string, CloudAgentExecutionSnapshot>
  >({});
  const localTurnsRef = useRef(localTurnsBySessionId);
  const publishedFingerprintBySessionRef = useRef<Record<string, string>>({});
  const publishTimerRef = useRef<number | null>(null);
  const publishRevisionRef = useRef(0);
  const lastPublishAtMsRef = useRef(0);
  const executionKey = Object.values(localTurnsBySessionId)
    .filter((turn) => !turn.completed)
    .map((turn) => {
      const execution = cloudAgentExecutionSnapshotFromTurn(turn, 0);
      return `${turn.sessionId}\u0001${cloudAgentExecutionFingerprint(execution)}`;
    })
    .sort()
    .join('\u0000');

  useEffect(() => {
    localTurnsRef.current = localTurnsBySessionId;
    for (const turn of Object.values(localTurnsBySessionId)) {
      if (!turn.completed) {
        executionBySessionIdRef.current[turn.sessionId] =
          cloudAgentExecutionSnapshotFromTurn(turn);
      }
    }
  }, [executionKey, localTurnsBySessionId]);

  useEffect(() => {
    publishedFingerprintBySessionRef.current = {};
    publishRevisionRef.current = 0;
    lastPublishAtMsRef.current = 0;
    return () => {
      if (publishTimerRef.current !== null) {
        window.clearTimeout(publishTimerRef.current);
        publishTimerRef.current = null;
      }
    };
  }, [account?.accountId]);

  useEffect(() => {
    if (!account || !executionKey || publishTimerRef.current !== null) return;
    const waitMs = Math.max(
      0,
      lastPublishAtMsRef.current
        + CLOUD_SELF_AGENT_EXECUTION_STREAM_MS
        - Date.now(),
    );
    publishTimerRef.current = window.setTimeout(() => {
      publishTimerRef.current = null;
      void (async () => {
        const state = canonicalStateRef.current;
        const session = await loadSession();
        if (!state || !session?.token || cancelledRef.current) return;
        const ledger = loadCloudSelfAgentSyncLedger(account.accountId);
        let published = false;
        for (const turn of Object.values(localTurnsRef.current)) {
          if (turn.completed || cancelledRef.current) continue;
          const localRequest = state.messages
            .filter((message) => (
              message.sessionId === turn.sessionId
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
          if (!localRequest || !cloudRequestMessageId) continue;
          const execution = cloudAgentExecutionSnapshotFromTurn(turn);
          const fingerprint = cloudAgentExecutionFingerprint(execution);
          if (
            publishedFingerprintBySessionRef.current[turn.sessionId]
            === fingerprint
          ) continue;
          executionBySessionIdRef.current[turn.sessionId] = execution;
          publishRevisionRef.current += 1;
          const message = await publishCloudSelfAgentExecutionSnapshot({
            accountId: account.accountId,
            client,
            cloudRequestMessageId,
            execution,
            localRequestMessageId: localRequest.id,
            revision: publishRevisionRef.current,
            sessionId: turn.sessionId,
            token: session.token,
          });
          if (cancelledRef.current) return;
          publishedFingerprintBySessionRef.current[turn.sessionId] = fingerprint;
          mergeMessage(message);
          published = true;
        }
        lastPublishAtMsRef.current = Date.now();
        if (published && !cancelledRef.current) await syncMessages();
      })().catch((error) => reportWarning(
        '[cloud-self-agent-sync] failed to stream owner execution status',
        error,
      ));
    }, waitMs);
  }, [
    account,
    executionKey,
    cancelledRef,
    canonicalStateRef,
    client,
    mergeMessage,
    reportWarning,
    syncMessages,
  ]);

  return executionBySessionIdRef;
}
