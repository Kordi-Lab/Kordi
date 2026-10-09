import { waitForCloudAgentTurn } from '@/features/cloud/cloudAgentLocalExecution';
import type { CanonicalSessionState, DesktopChatTurnSnapshot } from '@/kordi-app/types';
import { useCallback, useEffect, type MutableRefObject } from 'react';
import { hostedRequestIsSettled } from './localChatQueue';

/**
 * Tracks the runs each session's queued messages wait on, and flushes a
 * session's queue once the run it waits on is over.
 */
export function useSessionQueueWaits({
  canonicalSessionState,
  flushQueuedDesktopMessagesForSessionRef,
  waitingSessionTurnsRef,
  waitingHostedRequestsRef,
}: {
  canonicalSessionState: CanonicalSessionState | null | undefined;
  flushQueuedDesktopMessagesForSessionRef: MutableRefObject<(sessionId: string) => void>;
  /** Session id to the native turn id its queue waits on. */
  waitingSessionTurnsRef: MutableRefObject<Map<string, string>>;
  /** Session id to the Kordi Cloud request message id its queue waits on. */
  waitingHostedRequestsRef: MutableRefObject<Map<string, string>>;
}) {
  useEffect(() => () => { waitingSessionTurnsRef.current.clear(); waitingHostedRequestsRef.current.clear(); }, [waitingHostedRequestsRef, waitingSessionTurnsRef]);

  const waitForHostedRequest = useCallback((sessionId: string, requestMessageId: string) => {
    waitingHostedRequestsRef.current.set(sessionId, requestMessageId);
  }, [waitingHostedRequestsRef]);

  useEffect(() => {
    for (const [sessionId, requestMessageId] of waitingHostedRequestsRef.current) {
      if (!hostedRequestIsSettled(canonicalSessionState, requestMessageId)) continue;
      waitingHostedRequestsRef.current.delete(sessionId);
      flushQueuedDesktopMessagesForSessionRef.current(sessionId);
    }
  }, [canonicalSessionState, flushQueuedDesktopMessagesForSessionRef, waitingHostedRequestsRef]);

  const waitForSessionQueue = useCallback((sessionId: string, turn: DesktopChatTurnSnapshot) => {
    if (waitingSessionTurnsRef.current.get(sessionId) === turn.id) return;
    waitingSessionTurnsRef.current.set(sessionId, turn.id);
    void waitForCloudAgentTurn(turn.id).catch(() => undefined).finally(() => {
      if (waitingSessionTurnsRef.current.get(sessionId) !== turn.id) return;
      waitingSessionTurnsRef.current.delete(sessionId);
      flushQueuedDesktopMessagesForSessionRef.current(sessionId);
    });
  }, [flushQueuedDesktopMessagesForSessionRef, waitingSessionTurnsRef]);

  return { waitForHostedRequest, waitForSessionQueue };
}
