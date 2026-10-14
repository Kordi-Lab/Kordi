import { useEffect, useRef, type MutableRefObject } from 'react';
import type { CanonicalSessionMessage, CanonicalSessionState } from '@/kordi-app/types';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import { closeDesktopChatInterruptedRequest } from '@/lib/desktopInterruptedRequests';
import {
  cloudAgentTurnLifecycleState,
  isTerminalCloudAgentTurnState,
} from '@/features/canonical/cloudAgentTurnLifecycle';
import type { CloudAuthClient } from './authClient';
import { routeRunsOnKordiCloud } from './cloudAgentRuntimeRoute';
import {
  releaseInterruptedCloudAgentRequests,
  type InterruptedCloudAgentRequest,
} from './cloudInterruptedTurnRelease';
import { CLOUD_SELF_AGENT_LOCAL_EXECUTION_WINDOW_MS } from './cloudSelfAgentExecutionState';
import { cloudSyncedLocalAgentSessionIds } from './cloudSelfAgentSessionIdentity';

/** Requests sent from here before this load can only run in an earlier app process. */
const APP_LOADED_AT_MS = Date.now();

export type InterruptedCloudSelfAgentTurnPlan = {
  /** The processing replies this plan covers, so a later pass skips them. */
  rowIds: string[];
  /** Sessions whose request this Mac's native runtime ran. */
  nativeSessionIds: string[];
  /** Requests a leased run executed; the server ends only this device's run. */
  releaseRequests: InterruptedCloudAgentRequest[];
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isProcessingSelfAgentReply(message: CanonicalSessionMessage) {
  if (
    message.sourceTransport !== 'cloud-self-agent'
    || message.messageKind !== 'agent-turn'
    || message.senderRole !== 'owned-agent'
  ) return false;
  const lifecycle = cloudAgentTurnLifecycleState(message);
  return lifecycle === 'queued' || lifecycle === 'processing';
}

function isTerminalAgentReply(message: CanonicalSessionMessage) {
  return message.senderRole === 'owned-agent'
    && isTerminalCloudAgentTurnState(cloudAgentTurnLifecycleState(message));
}

/**
 * The processing replies of the user's own agent that no running turn will
 * end: their turn ran in an app process that has quit. A request this Mac
 * sent ran in its native runtime, which closes it; a leased request is
 * released on the server, which ends it only when this device held the run.
 */
export function planInterruptedCloudSelfAgentTurns({
  state,
  attemptedRowIds,
  activeRequestIds,
  loadedAtMs = APP_LOADED_AT_MS,
  nowMs = Date.now(),
}: {
  state: CanonicalSessionState;
  attemptedRowIds: ReadonlySet<string>;
  /** Requests this app is executing or has started since it loaded. */
  activeRequestIds: ReadonlySet<string>;
  loadedAtMs?: number;
  nowMs?: number;
}): InterruptedCloudSelfAgentTurnPlan {
  const plan: InterruptedCloudSelfAgentTurnPlan = {
    rowIds: [],
    nativeSessionIds: [],
    releaseRequests: [],
  };
  const candidates = state.messages.filter((message) => (
    !attemptedRowIds.has(message.id) && isProcessingSelfAgentReply(message)
  ));
  if (candidates.length === 0) return plan;

  const byId = new Map<string, CanonicalSessionMessage>();
  const bySourceEventId = new Map<string, CanonicalSessionMessage>();
  const answeredRequestIds = new Set<string>();
  for (const message of state.messages) {
    byId.set(message.id, message);
    if (message.sourceEventId) bySourceEventId.set(message.sourceEventId, message);
    if (message.parentMessageId && isTerminalAgentReply(message)) {
      answeredRequestIds.add(message.parentMessageId);
    }
  }
  const localSessionIds = cloudSyncedLocalAgentSessionIds(state);
  const nativeSessionIds = new Set<string>();
  for (const message of candidates) {
    const content = record(message.content);
    const requestRef = cleanText(message.parentMessageId)
      || cleanText(content.requestId)
      || cleanText(content.replyToMessageId);
    const request = byId.get(requestRef) ?? bySourceEventId.get(requestRef);
    // Without its request the reply cannot be classified; a later page may load it.
    if (!request || request.senderRole !== 'user') continue;
    if (answeredRequestIds.has(request.id)) {
      plan.rowIds.push(message.id);
      continue;
    }
    const route = record(request.content).agentRuntimeRoute as DesktopChatMessageRoute | undefined;
    const sentFromThisMac = localSessionIds.has(message.sessionId)
      && !request.sourceTransport?.startsWith('cloud-')
      && !routeRunsOnKordiCloud(route);
    if (sentFromThisMac) {
      if (request.createdAtMs >= loadedAtMs) continue;
      plan.rowIds.push(message.id);
      nativeSessionIds.add(message.sessionId);
      continue;
    }
    const requestId = cleanText(content.cloudRequestMessageId) || cleanText(request.sourceEventId);
    // Until the execution window closes this app may still run the request.
    if (
      !requestId
      || activeRequestIds.has(requestId)
      || nowMs - request.createdAtMs <= CLOUD_SELF_AGENT_LOCAL_EXECUTION_WINDOW_MS
    ) continue;
    plan.rowIds.push(message.id);
    plan.releaseRequests.push({ sessionId: message.sessionId, requestId });
  }
  plan.nativeSessionIds = [...nativeSessionIds];
  return plan;
}

/**
 * Ends the processing replies whose turn died with an earlier app process,
 * as their sessions load. The native runtime adds the interruption note to a
 * request this Mac ran, and the page reloads with it.
 */
export function useCloudSelfAgentInterruptedTurnRecovery({
  enabled,
  canonicalState,
  client,
  processedRequestIdsRef,
  hydrateSessionPage,
  syncMessages,
  reportWarning,
}: {
  enabled: boolean;
  canonicalState: CanonicalSessionState | null | undefined;
  client: Pick<CloudAuthClient, 'desktopAgentExecution'>;
  processedRequestIdsRef: MutableRefObject<Set<string>>;
  hydrateSessionPage?: (sessionId: string, options?: { force?: boolean }) => Promise<unknown>;
  syncMessages: () => Promise<void>;
  reportWarning: (message: string, error: unknown) => void;
}) {
  const attemptedRowIdsRef = useRef(new Set<string>());
  const latestRef = useRef({ client, hydrateSessionPage, syncMessages, reportWarning });
  useEffect(() => {
    latestRef.current = { client, hydrateSessionPage, syncMessages, reportWarning };
  }, [client, hydrateSessionPage, reportWarning, syncMessages]);

  useEffect(() => {
    if (!enabled || !canonicalState) return;
    const plan = planInterruptedCloudSelfAgentTurns({
      state: canonicalState,
      attemptedRowIds: attemptedRowIdsRef.current,
      activeRequestIds: processedRequestIdsRef.current,
    });
    if (plan.rowIds.length === 0) return;
    plan.rowIds.forEach((id) => attemptedRowIdsRef.current.add(id));
    const latest = latestRef.current;
    void (async () => {
      for (const sessionId of plan.nativeSessionIds) {
        await closeDesktopChatInterruptedRequest(sessionId).catch((error: unknown) => {
          latest.reportWarning('[cloud-self-agent] interrupted request close failed', error);
        });
        // A session load may have closed it already; the page reload shows the note.
        await latest.hydrateSessionPage?.(sessionId, { force: true });
      }
      if (plan.releaseRequests.length === 0) return;
      const { released, failures } = await releaseInterruptedCloudAgentRequests(
        latest.client,
        plan.releaseRequests,
      );
      failures.forEach((error) => latest.reportWarning(
        '[cloud-self-agent] interrupted turn release failed',
        error,
      ));
      if (released > 0) await latest.syncMessages();
    })().catch((error: unknown) => {
      latest.reportWarning('[cloud-self-agent] interrupted turn recovery failed', error);
    });
  }, [canonicalState, enabled, processedRequestIdsRef]);
}
