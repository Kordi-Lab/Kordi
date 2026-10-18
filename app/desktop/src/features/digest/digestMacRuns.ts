import type { CloudAuthClient } from '@/features/cloud/authClient';
import { hasHostedOnlyPrefix } from '@/features/cloud/routeAccountChoice';
import { invokeDesktop, type DesktopChatMessageRoute } from '@/lib/desktop';

// Digest runs on this Mac. While this Mac can run digests, the server holds
// each new digest run for it and announces it with `digest.run_requested`.
// This Mac claims the run, runs one turn with its own provider, and submits
// the reply, which the server checks exactly like a cloud reply. A run this
// Mac cannot finish goes back to the cloud at once; a run it never claims is
// run by the cloud once the hold ends.

const RUN_PREFIX = 'digest_';
const RENEW_MS = 10_000;
const MAX_PENDING = 8;

export type DigestRunRequest = { runId: string; sessionId: string };

export type DigestTool = { name: string; description: string; parameters?: unknown };

type DigestClaim = {
  runId: string;
  acquired: boolean;
  digest?: { systemPrompt: string; prompt: string; tools: DigestTool[] };
};

export type DigestMacRuntime = {
  accountId: string;
  token: string;
  route: DesktopChatMessageRoute | null | undefined;
  client: Pick<CloudAuthClient, 'desktopAgentExecution'>;
  /** POSTs to `/v1/cloud/<path>` as the signed-in account. */
  post: (path: string, body: unknown) => Promise<unknown>;
  run?: typeof runDesktopDigest;
};

/** Whether this Mac runs digests itself: only with a provider on this Mac. */
export function macCanRunDigest(route: DesktopChatMessageRoute | null | undefined): boolean {
  return Boolean(route?.model?.trim()) && !hasHostedOnlyPrefix(route?.authChoice);
}

export function runDesktopDigest(input: {
  runId: string;
  claimId: string;
  ownerAccountId: string;
  systemPrompt: string;
  prompt: string;
  tools: DigestTool[];
  route: DesktopChatMessageRoute;
}) {
  return invokeDesktop<string>('desktop_digest_run', input);
}

export function parseDigestRunRequest(payload: unknown): DigestRunRequest | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const runId = typeof record.runId === 'string' ? record.runId.trim() : '';
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
  return runId.startsWith(RUN_PREFIX) && sessionId.startsWith('digest:') ? { runId, sessionId } : null;
}

type Handler = (request: DigestRunRequest) => void;
let handler: Handler | null = null;
let pending: DigestRunRequest[] = [];

/** Hands `digest.run_requested` events from the cloud sync stream to this Mac. */
export function notifyDigestRunRequests(events: ReadonlyArray<{ eventType?: string; payload?: unknown }>) {
  for (const event of events) {
    if (event.eventType !== 'digest.run_requested') continue;
    const request = parseDigestRunRequest(event.payload);
    if (!request) continue;
    if (handler) handler(request);
    else pending = [...pending, request].slice(-MAX_PENDING);
  }
}

/** Requests that arrive before the local runtime is ready wait for the handler. */
export function setDigestRunRequestHandler(next: Handler | null) {
  handler = next;
  if (!next) return;
  const waiting = pending;
  pending = [];
  for (const request of waiting) next(request);
}

/**
 * Claims and runs one digest run. Returns what happened: `skipped` when this
 * Mac cannot run digests or the request is for another account, `not-acquired`
 * when another runtime holds the run, `completed`, or `released` when this
 * Mac could not finish and handed the run to the cloud.
 */
export async function runDigestOnMac(
  request: DigestRunRequest,
  runtime: DigestMacRuntime,
): Promise<'skipped' | 'not-acquired' | 'completed' | 'released'> {
  const { accountId, token, client } = runtime;
  const route = runtime.route;
  if (!route || !macCanRunDigest(route) || request.sessionId !== `digest:${accountId}`) return 'skipped';
  const claimId = crypto.randomUUID();
  const claim = await client.desktopAgentExecution<DigestClaim>(token, 'claim', {
    claimId, requestMessageId: request.runId, sessionId: request.sessionId,
    ownerAccountId: accountId, requesterAccountId: accountId, prompt: 'digest', idempotencyKey: request.runId,
  });
  if (!claim.acquired || !claim.digest) return 'not-acquired';
  let lost = false;
  const timer = setInterval(() => {
    void client.desktopAgentExecution(token, `${encodeURIComponent(request.runId)}/renew`, { claimId })
      .catch(() => { lost = true; });
  }, RENEW_MS);
  const path = `digest/desktop/${encodeURIComponent(request.runId)}`;
  try {
    const text = await (runtime.run ?? runDesktopDigest)({
      runId: request.runId, claimId, ownerAccountId: accountId,
      systemPrompt: claim.digest.systemPrompt, prompt: claim.digest.prompt, tools: claim.digest.tools, route,
    });
    if (lost) return 'not-acquired';
    await runtime.post(`${path}/complete`, { claimId, text });
    return 'completed';
  } catch {
    // The cloud runs it now instead of waiting for this lease to lapse.
    await runtime.post(`${path}/release`, { claimId }).catch(() => undefined);
    return 'released';
  } finally {
    clearInterval(timer);
  }
}
