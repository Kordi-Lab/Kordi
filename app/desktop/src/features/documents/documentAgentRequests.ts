import { cloudAgentContextMessagesFromDefinition } from '@/features/chat/chatCreateFlows';
import type { CloudAuthClient } from '@/features/cloud/authClient';
import { waitForCloudAgentTurn } from '@/features/cloud/cloudAgentLocalExecution';
import { encodeCloudAgentResponse } from '@/features/cloud/cloudAgentMessages';
import {
  cloudGroupAgentRequestRuntimeSessionId,
  cloudGroupAgentRuntimeSessionId,
} from '@/features/cloud/cloudAgentRuntime';
import { cloudAgentRuntimeRouteForTargetCloudAgent } from '@/features/cloud/cloudAgentTargetRuntimeRoute';
import type { CloudAgentDefinition } from '@/features/cloud/cloudAgents';
import { acquireDesktopExecutionLease } from '@/features/cloud/cloudDesktopExecutionLease';
import { loadSession } from '@/features/cloud/session';
import { cancelDesktopChatTurn, type DesktopChatMessageRoute } from '@/lib/desktop';
import {
  desktopSharedRequestAlreadyStarted,
  startDesktopSharedChatMessage,
} from '@/lib/desktopBackgroundSessions';

/** Payload of the `document.agent_request` user sync event. */
export type DocumentAgentRequest = {
  runRequestId: string;
  commentId: string;
  attachmentId: string;
  sessionId: string;
  requesterAccountId: string;
  agentId: string;
  prompt: string;
};

export type DocumentAgentRequestOutcome =
  | 'ignored'
  | 'duplicate'
  | 'not-acquired'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** What a request runs with: the signed-in account and its chat agent setup. */
export type DocumentAgentRuntime = {
  accountId: string;
  client: Pick<CloudAuthClient, 'desktopAgentExecution'>;
  agentDefinitionsById: Record<string, CloudAgentDefinition>;
  routesBySessionId?: Record<string, DesktopChatMessageRoute>;
  defaultRoute?: DesktopChatMessageRoute | null;
  reportWarning?: (message: string, error: unknown) => void;
  loadToken?: () => Promise<string | null>;
  startTurn?: typeof startDesktopSharedChatMessage;
  waitForTurn?: typeof waitForCloudAgentTurn;
  cancelTurn?: (turnId: string) => Promise<unknown>;
};

type Handler = (request: DocumentAgentRequest) => void;

const MAX_PENDING = 32;
const REQUEST_PREFIX = 'doccmt:';
let handler: Handler | null = null;
let pending: DocumentAgentRequest[] = [];
const startedRequestIds = new Set<string>();

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseDocumentAgentRequest(payload: unknown): DocumentAgentRequest | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const request = {
    runRequestId: text(record.runRequestId),
    commentId: text(record.commentId),
    attachmentId: text(record.attachmentId),
    sessionId: text(record.sessionId),
    requesterAccountId: text(record.requesterAccountId),
    agentId: text(record.agentId),
    prompt: text(record.prompt),
  };
  if (Object.values(request).some((value) => !value)) return null;
  return request.runRequestId === `${REQUEST_PREFIX}${request.commentId}` ? request : null;
}

/** Hands `document.agent_request` events from the cloud sync stream to this Mac's agent. */
export function notifyDocumentAgentRequests(events: ReadonlyArray<{ eventType?: string; payload?: unknown }>) {
  for (const event of events) {
    if (event.eventType !== 'document.agent_request') continue;
    const request = parseDocumentAgentRequest(event.payload);
    if (!request) continue;
    if (handler) handler(request);
    else pending = [...pending, request].slice(-MAX_PENDING);
  }
}

/** Requests that arrive before the local runtime is ready wait for the handler. */
export function setDocumentAgentRequestHandler(next: Handler | null) {
  handler = next;
  if (!next) return;
  const waiting = pending;
  pending = [];
  for (const request of waiting) next(request);
}

/** Whether the mentioned agent is the signed-in account's default or one of its named agents. */
export function documentAgentBelongsToAccount(
  request: Pick<DocumentAgentRequest, 'agentId'>,
  runtime: Pick<DocumentAgentRuntime, 'accountId' | 'agentDefinitionsById'>,
): boolean {
  if (request.agentId === `cloud-agent:${runtime.accountId}`) return true;
  return runtime.agentDefinitionsById[request.agentId]?.ownerAccountId === runtime.accountId;
}

function failureText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return text(error) || 'The agent could not answer.';
}

/**
 * Claims a comment run and executes it with the local runtime, the way a
 * chat mention runs: same agent definition, model route, and memory. The
 * answer goes back through the desktop execution routes and lands in the
 * comment thread; no chat message or transcript entry is written here.
 */
export async function runDocumentAgentRequest(
  request: DocumentAgentRequest,
  runtime: DocumentAgentRuntime,
  started: Set<string> = startedRequestIds,
): Promise<DocumentAgentRequestOutcome> {
  if (!documentAgentBelongsToAccount(request, runtime)) return 'ignored';
  if (started.has(request.runRequestId)) return 'duplicate';
  started.add(request.runRequestId);
  const { accountId, client } = runtime;
  const named = request.agentId !== `cloud-agent:${accountId}`;
  const runtimeSessionId = cloudGroupAgentRuntimeSessionId(accountId, request.sessionId, named ? request.agentId : null);
  if (!runtimeSessionId) return 'ignored';
  const route = cloudAgentRuntimeRouteForTargetCloudAgent({
    targetCloudAgentId: named ? request.agentId : null,
    cloudAgentDefinitionsById: runtime.agentDefinitionsById,
    routesByRuntimeSessionId: runtime.routesBySessionId,
    runtimeSessionId,
    fallbackRoute: runtime.defaultRoute,
  });
  let token: string | null;
  let lease: Awaited<ReturnType<typeof acquireDesktopExecutionLease>>;
  try {
    token = await (runtime.loadToken ?? (async () => (await loadSession())?.token ?? null))();
    if (!token) throw new Error('Not signed in.');
    lease = await acquireDesktopExecutionLease(client, token, {
      requestMessageId: request.runRequestId,
      sessionId: request.sessionId,
      ownerAccountId: accountId,
      requesterAccountId: request.requesterAccountId,
      prompt: request.prompt,
      idempotencyKey: `${request.runRequestId}:${request.agentId}`,
      runtimeRoute: route ? { defaultModel: route.model, defaultAuthProvider: route.authProvider, defaultAuthChoice: route.authChoice, thinking: route.thinking } : undefined,
    });
  } catch (error) {
    // Nothing ran: a redelivered event may try again, and the cloud takes over otherwise.
    started.delete(request.runRequestId);
    runtime.reportWarning?.('[document-agent] claim failed', error);
    return 'not-acquired';
  }
  // The cloud runner or another window already has the run.
  if (!lease) return 'not-acquired';
  const sessionToken = token;
  const publish = async (deliveryState: 'complete' | 'failed', responseText: string) => {
    const state = deliveryState === 'complete' ? 'completed' : 'failed';
    try {
      await lease.publisher.sendMessage(sessionToken, '', encodeCloudAgentResponse({
        requestId: request.runRequestId, text: responseText, deliveryState,
      }), { clientMessageId: `${request.runRequestId}:${deliveryState}` });
    } catch (error) {
      if (!lease.lost) throw error;
      // The lease lapsed mid-turn: release the run with what this Mac has.
      await client.desktopAgentExecution(sessionToken, 'interrupted', {
        sessionId: request.sessionId, requestMessageId: request.runRequestId, state,
        ...(state === 'completed' ? { text: responseText } : {}),
      });
    }
  };
  try {
    if (!await lease.admitted()) return 'not-acquired';
    let outcome: DocumentAgentRequestOutcome = 'failed';
    let responseText = '';
    try {
      const turn = await (runtime.startTurn ?? startDesktopSharedChatMessage)(
        request.runRequestId,
        cloudGroupAgentRequestRuntimeSessionId(runtimeSessionId, request.runRequestId),
        request.prompt,
        [],
        route,
        lease.contextMessages(cloudAgentContextMessagesFromDefinition(
          named ? runtime.agentDefinitionsById[request.agentId] ?? null : null,
        )),
        [],
        request.sessionId,
        lease.deadline,
      );
      lease.attach(turn.id);
      const cancel = runtime.cancelTurn ?? cancelDesktopChatTurn;
      lease.onStopRequested(() => { void cancel(turn.id).catch(() => undefined); });
      const final = turn.completed ? turn : await (runtime.waitForTurn ?? waitForCloudAgentTurn)(turn.id);
      if (final.status === 'cancelled') outcome = 'cancelled';
      else if (final.succeeded && final.assistantText.trim()) {
        outcome = 'completed';
        responseText = final.assistantText.trim();
      } else responseText = failureText(final.error || final.message);
    } catch (error) {
      // This window already runs the request; its first run reports the answer.
      if (desktopSharedRequestAlreadyStarted(error)) return 'duplicate';
      responseText = failureText(error);
    }
    if (outcome === 'cancelled' && !lease.lost) await lease.cancel();
    else if (outcome === 'completed') await publish('complete', responseText);
    else await publish('failed', responseText);
    return outcome;
  } catch (error) {
    runtime.reportWarning?.('[document-agent] reply failed', error);
    return 'failed';
  } finally {
    lease.dispose();
  }
}
