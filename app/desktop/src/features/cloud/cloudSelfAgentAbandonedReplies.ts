import type { CloudAuthClient, CloudMessage } from './authClient';
import type { CloudAgentRun } from './cloudAgentRuntimeTypes';
import { encodeCloudAgentResponse, parseCloudAgentResponse } from './cloudAgentMessages';
import type { CloudSelfAgentTerminalReply } from './cloudSelfAgentTerminalReply';

/** The reply that ends a request whose run is gone. */
export const CLOUD_SELF_AGENT_ABANDONED_REPLY_TEXT =
  'This reply was interrupted before it completed. Try again.';

/**
 * How long a processing reply must go without progress before this Mac ends
 * it. A live turn publishes progress at least every heartbeat, so this only
 * ends replies that nobody is still writing.
 */
export const CLOUD_SELF_AGENT_ABANDONED_REPLY_IDLE_MS = 30 * 60_000;

const LIVE_RUN_STATUSES = new Set(['queued', 'leased', 'running']);

export type AbandonedCloudSelfAgentRequest = {
  sessionId: string;
  requestId: string;
  /** The newest progress the processing reply shows. */
  lastProgressAtMs: number;
};

type Publisher = Pick<CloudAuthClient, 'sendMessage'>;

/** A run that a device or a Cloud runner may still execute. */
export function cloudAgentRunIsLive(run: Pick<CloudAgentRun, 'status'> | null | undefined): boolean {
  return Boolean(run && LIVE_RUN_STATUSES.has(run.status.trim().toLowerCase()));
}

/** The newest processing reply to `requestId` among the account's messages. */
export function latestCloudSelfAgentProgressAtMs(
  requestId: string,
  messages: readonly Pick<CloudMessage, 'body' | 'createdAt'>[],
): number | null {
  let latest: number | null = null;
  for (const message of messages) {
    const response = parseCloudAgentResponse(message.body);
    if (response?.requestId !== requestId) continue;
    const atMs = Math.max(Date.parse(message.createdAt) || 0, response.execution?.updatedAtMs ?? 0);
    if (latest === null || atMs > latest) latest = atMs;
  }
  return latest;
}

/**
 * Publishes the terminal reply of a request no run will answer. The stable
 * client message ID makes a repeat from this or another device a no-op.
 */
export function publishEndedCloudSelfAgentReply({
  client,
  token,
  accountId,
  sessionId,
  requestId,
  reply,
}: {
  client: Publisher;
  token: string;
  accountId: string;
  sessionId: string;
  requestId: string;
  reply: CloudSelfAgentTerminalReply;
}): Promise<CloudMessage> {
  return client.sendMessage(
    token,
    accountId,
    encodeCloudAgentResponse({
      requestId,
      text: reply.text,
      deliveryState: reply.deliveryState,
      ending: reply.ending,
    }),
    { sessionId, clientMessageId: `self-agent:${sessionId}:${requestId}:ended-without-run` },
  );
}

/**
 * Ends processing replies whose run is gone: the server has no run for the
 * request, or its run already ended without publishing a reply, such as a
 * run that ended before terminal replies were backfilled. A live run is left
 * alone, because the server ends it once its executor stops renewing.
 */
export async function settleAbandonedCloudSelfAgentRequests({
  client,
  token,
  accountId,
  requests,
  latestProgressAtMs = () => null,
  mergeMessage,
  reportWarning,
  nowMs = Date.now(),
}: {
  client: Publisher & Pick<CloudAuthClient, 'lookupCloudAgentRunForRequest'>;
  token: string;
  accountId: string;
  requests: readonly AbandonedCloudSelfAgentRequest[];
  /** Progress other devices published after the canonical row was written. */
  latestProgressAtMs?: (requestId: string) => number | null;
  mergeMessage: (message: CloudMessage) => void;
  reportWarning: (message: string, error: unknown) => void;
  nowMs?: number;
}): Promise<number> {
  let ended = 0;
  for (const request of requests) {
    const progressAtMs = Math.max(request.lastProgressAtMs, latestProgressAtMs(request.requestId) ?? 0);
    if (nowMs - progressAtMs <= CLOUD_SELF_AGENT_ABANDONED_REPLY_IDLE_MS) continue;
    try {
      const run = await client.lookupCloudAgentRunForRequest(token, request.requestId);
      if (cloudAgentRunIsLive(run)) continue;
      const message = await publishEndedCloudSelfAgentReply({
        client,
        token,
        accountId,
        sessionId: request.sessionId,
        requestId: request.requestId,
        reply: { deliveryState: 'failed', text: CLOUD_SELF_AGENT_ABANDONED_REPLY_TEXT },
      });
      mergeMessage(message);
      ended += 1;
    } catch (error) {
      reportWarning('[cloud-self-agent] abandoned reply could not be ended', error);
    }
  }
  return ended;
}
