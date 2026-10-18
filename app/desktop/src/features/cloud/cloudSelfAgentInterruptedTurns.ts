import { useEffect, useRef, type MutableRefObject } from 'react';
import type { CanonicalSessionMessage, CanonicalSessionState } from '@/kordi-app/types';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import { closeDesktopChatInterruptedRequest } from '@/lib/desktopInterruptedRequests';
import {
  cloudAgentTurnLifecycleState,
  isTerminalCloudAgentTurnState,
} from '@/features/canonical/cloudAgentTurnLifecycle';
import type { CloudAccount, CloudAuthClient, CloudMessage } from './authClient';
import type { CloudMessageIndex } from './cloudMessageIndex';
import { routeRunsOnKordiCloud } from './cloudAgentRuntimeRoute';
import {
  releaseInterruptedCloudAgentRequests,
  type InterruptedCloudAgentRequest,
} from './cloudInterruptedTurnRelease';
import {
  latestCloudSelfAgentProgressAtMs,
  settleAbandonedCloudSelfAgentRequests,
  type AbandonedCloudSelfAgentRequest,
} from './cloudSelfAgentAbandonedReplies';
import { CLOUD_SELF_AGENT_LOCAL_EXECUTION_WINDOW_MS } from './cloudSelfAgentExecutionState';
import { loadSession } from './session';
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
  /**
   * Released requests whose reply is ended here when the server holds no
   * run of this device for them, with the reply's newest progress.
   */
  abandonedRequests: AbandonedCloudSelfAgentRequest[];
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

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The newest progress a processing reply shows; its row update time is when it synced. */
function replyLastProgressAtMs(message: CanonicalSessionMessage): number {
  const content = record(message.content);
  return Math.max(
    message.createdAtMs,
    finiteNumber(content.executionUpdatedAtMs),
    finiteNumber(record(content.execution).updatedAtMs),
  );
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
    abandonedRequests: [],
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
    plan.abandonedRequests.push({
      sessionId: message.sessionId,
      requestId,
      lastProgressAtMs: replyLastProgressAtMs(message),
    });
  }
  plan.nativeSessionIds = [...nativeSessionIds];
  return plan;
}

type InterruptedTurnRecoveryDeps = {
  account: Pick<CloudAccount, 'accountId'> | null;
  client: Pick<CloudAuthClient, 'desktopAgentExecution' | 'lookupCloudAgentRunForRequest' | 'sendMessage'>;
  /** The account's own messages, for progress newer than the canonical rows. */
  selfMessages?: () => readonly CloudMessage[];
  hydrateSessionPage?: (sessionId: string, options?: { force?: boolean }) => Promise<unknown>;
  mergeMessage: (message: CloudMessage) => void;
  syncMessages: () => Promise<void>;
  reportWarning: (message: string, error: unknown) => void;
  loadToken?: () => Promise<string | null | undefined>;
};

/**
 * Carries out a recovery plan. A request the server cannot release, because
 * no run of this device exists or the run already ended without a reply, is
 * ended with a failed reply once nobody still writes it.
 */
export async function recoverInterruptedCloudSelfAgentTurns(
  plan: InterruptedCloudSelfAgentTurnPlan,
  deps: InterruptedTurnRecoveryDeps,
  nowMs = Date.now(),
): Promise<void> {
  const loadToken = deps.loadToken ?? (async () => (await loadSession())?.token);
  for (const sessionId of plan.nativeSessionIds) {
    await closeDesktopChatInterruptedRequest(sessionId).catch((error: unknown) => {
      deps.reportWarning('[cloud-self-agent] interrupted request close failed', error);
    });
    // A session load may have closed it already; the page reload shows the note.
    await deps.hydrateSessionPage?.(sessionId, { force: true });
  }
  if (plan.releaseRequests.length === 0) return;
  const { releasedRequests, failures } = await releaseInterruptedCloudAgentRequests(
    deps.client,
    plan.releaseRequests,
    loadToken,
  );
  failures.forEach((error) => deps.reportWarning(
    '[cloud-self-agent] interrupted turn release failed',
    error,
  ));
  const released = new Set(releasedRequests.map(({ sessionId, requestId }) => `${sessionId}\n${requestId}`));
  const abandoned = failures.length > 0 ? [] : plan.abandonedRequests.filter(
    ({ sessionId, requestId }) => !released.has(`${sessionId}\n${requestId}`),
  );
  let ended = 0;
  const token = abandoned.length > 0 && deps.account ? await loadToken() : null;
  if (token && deps.account) {
    const messages = deps.selfMessages?.() ?? [];
    ended = await settleAbandonedCloudSelfAgentRequests({
      client: deps.client,
      token,
      accountId: deps.account.accountId,
      requests: abandoned,
      latestProgressAtMs: (requestId) => latestCloudSelfAgentProgressAtMs(requestId, messages),
      mergeMessage: deps.mergeMessage,
      reportWarning: deps.reportWarning,
      nowMs,
    });
  }
  if (releasedRequests.length > 0 || ended > 0) await deps.syncMessages();
}

/**
 * Ends the processing replies whose turn died with an earlier app process,
 * as their sessions load. The native runtime adds the interruption note to a
 * request this Mac ran, and the page reloads with it.
 */
export function useCloudSelfAgentInterruptedTurnRecovery({
  enabled,
  account,
  canonicalState,
  client,
  messageIndex,
  processedRequestIdsRef,
  hydrateSessionPage,
  mergeMessage,
  syncMessages,
  reportWarning,
}: Omit<InterruptedTurnRecoveryDeps, 'selfMessages' | 'loadToken'> & {
  enabled: boolean;
  canonicalState: CanonicalSessionState | null | undefined;
  messageIndex?: CloudMessageIndex;
  processedRequestIdsRef: MutableRefObject<Set<string>>;
}) {
  const attemptedRowIdsRef = useRef(new Set<string>());
  const latestRef = useRef({ account, client, messageIndex, hydrateSessionPage, mergeMessage, syncMessages, reportWarning });
  useEffect(() => {
    latestRef.current = { account, client, messageIndex, hydrateSessionPage, mergeMessage, syncMessages, reportWarning };
  }, [account, client, hydrateSessionPage, mergeMessage, messageIndex, reportWarning, syncMessages]);

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
    void recoverInterruptedCloudSelfAgentTurns(plan, {
      ...latest,
      selfMessages: () => (latest.account
        ? latest.messageIndex?.byPeerId.get(latest.account.accountId) ?? []
        : []),
    }).catch((error: unknown) => {
      latest.reportWarning('[cloud-self-agent] interrupted turn recovery failed', error);
    });
  }, [canonicalState, enabled, processedRequestIdsRef]);
}
