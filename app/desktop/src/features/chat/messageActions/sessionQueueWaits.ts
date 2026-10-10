import { waitForCloudAgentTurn } from '@/features/cloud/cloudAgentLocalExecution';
import type { CanonicalSessionState, DesktopChatTurnSnapshot } from '@/kordi-app/types';
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import {
  releaseTrackedHostedRequestWait,
  reviewHostedRequestWait,
  subscribeHostedRequestWaitRelease,
  type HostedRequestWaitTracker,
} from './hostedRequestWait';
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
  const canonicalSessionStateRef = useRef(canonicalSessionState);
  const [hostedWaits] = useState<HostedRequestWaitTracker>(() => ({
    waits: () => waitingHostedRequestsRef.current,
    state: () => canonicalSessionStateRef.current,
    isSettled: hostedRequestIsSettled,
    onRelease: (sessionId) => flushQueuedDesktopMessagesForSessionRef.current(sessionId),
    activity: new Map(),
    timers: new Map(),
  }));

  useEffect(() => {
    const waitingSessionTurns = waitingSessionTurnsRef.current;
    const waitingHostedRequests = waitingHostedRequestsRef.current;
    return () => {
      for (const timer of hostedWaits.timers.values()) clearTimeout(timer);
      hostedWaits.timers.clear();
      hostedWaits.activity.clear();
      waitingSessionTurns.clear();
      waitingHostedRequests.clear();
    };
  }, [hostedWaits, waitingHostedRequestsRef, waitingSessionTurnsRef]);

  const releaseHostedRequestWait = useCallback((sessionId: string) => {
    releaseTrackedHostedRequestWait(hostedWaits, sessionId);
  }, [hostedWaits]);

  const waitForHostedRequest = useCallback((sessionId: string, requestMessageId: string) => {
    waitingHostedRequestsRef.current.set(sessionId, requestMessageId);
    hostedWaits.activity.delete(sessionId);
    reviewHostedRequestWait(hostedWaits, sessionId);
  }, [hostedWaits, waitingHostedRequestsRef]);

  useEffect(() => {
    canonicalSessionStateRef.current = canonicalSessionState;
    for (const sessionId of [...waitingHostedRequestsRef.current.keys()]) reviewHostedRequestWait(hostedWaits, sessionId);
  }, [canonicalSessionState, hostedWaits, waitingHostedRequestsRef]);

  useEffect(() => subscribeHostedRequestWaitRelease(releaseHostedRequestWait), [releaseHostedRequestWait]);

  const waitForSessionQueue = useCallback((sessionId: string, turn: DesktopChatTurnSnapshot) => {
    if (waitingSessionTurnsRef.current.get(sessionId) === turn.id) return;
    waitingSessionTurnsRef.current.set(sessionId, turn.id);
    void waitForCloudAgentTurn(turn.id).catch(() => undefined).finally(() => {
      if (waitingSessionTurnsRef.current.get(sessionId) !== turn.id) return;
      waitingSessionTurnsRef.current.delete(sessionId);
      flushQueuedDesktopMessagesForSessionRef.current(sessionId);
    });
  }, [flushQueuedDesktopMessagesForSessionRef, waitingSessionTurnsRef]);

  return { waitForHostedRequest, waitForSessionQueue, releaseHostedRequestWait };
}
