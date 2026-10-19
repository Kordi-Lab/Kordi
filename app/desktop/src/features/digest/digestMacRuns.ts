import type { CloudAuthClient } from '@/features/cloud/authClient';
import { hasHostedOnlyPrefix } from '@/features/cloud/routeAccountChoice';
import { invokeDesktop, type DesktopChatMessageRoute } from '@/lib/desktop';

// Digest runs on this Mac. While this Mac can run digests, the server holds
// each new digest run for it and announces it with `digest.run_requested`.
// This Mac claims the run, runs one turn with its own provider and the
// digest's model choice, and submits the reply, which the server checks
// exactly like a cloud reply. A run this
// Mac cannot finish goes back to the cloud at once; a run it never claims is
// run by the cloud once the hold ends.

const RUN_PREFIX = 'digest_';
const RENEW_MS = 10_000;
const MAX_PENDING = 8;
/** The thinking level of a digest run when the claim names none. */
const DIGEST_THINKING = 'low';

export type DigestRunRequest = { runId: string; sessionId: string };

export type DigestTool = { name: string; description: string; parameters?: unknown };

/**
 * The model the server chose for the run (see the server's `model_choice`):
 * `model` and `thinking` for `provider`, how the owner chose it, and each
 * provider's fast model. `triage` marks the quick urgency check.
 */
export type DigestRunChoice = {
  model?: string | null;
  thinking?: string | null;
  provider?: string | null;
  modelChoice?: string | null;
  triage?: boolean;
  fastModels?: Record<string, string> | null;
};

type DigestClaim = {
  runId: string;
  acquired: boolean;
  digest?: DigestRunChoice & { systemPrompt: string; prompt: string; tools: DigestTool[] };
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

/**
 * Whether this Mac runs digests: whenever it has a model route, as for chat.
 * A hosted account's credentials are resolved for the claimed run.
 */
export function macCanRunDigest(route: DesktopChatMessageRoute | null | undefined): boolean {
  return Boolean(route?.model?.trim());
}

/**
 * The route a Mac sends with its claim: only a hosted account, which the
 * server then stores on the run so that account's credentials resolve for it.
 * A Mac-local route stays on this Mac and never replaces the cloud's route.
 */
export function claimRuntimeRoute(route: DesktopChatMessageRoute | null | undefined) {
  if (!route?.model?.trim() || !hasHostedOnlyPrefix(route.authChoice)) return undefined;
  return { defaultModel: route.model, defaultAuthProvider: route.authProvider, defaultAuthChoice: route.authChoice, thinking: route.thinking };
}

function providerOf(model: string | null | undefined, provider: string | null | undefined) {
  const prefix = model?.includes('/') ? model.slice(0, model.indexOf('/')) : '';
  return (prefix || provider || '').trim().toLowerCase();
}

function qualified(model: string, provider: string) {
  return model.includes('/') || !provider ? model : `${provider}/${model}`;
}

/**
 * The route this Mac runs a digest run with: its own provider and account,
 * with the digest's model and thinking instead of the chat's. A model chosen
 * for another provider becomes this provider's fast model; a named model of
 * this provider runs with that fast model as `fallbackModel` in case this Mac
 * cannot run it. The quick urgency check never thinks.
 */
export function digestRunRoute(
  route: DesktopChatMessageRoute,
  choice: DigestRunChoice,
): { route: DesktopChatMessageRoute; fallbackModel: string | null } {
  const triage = choice.triage === true;
  if (choice.modelChoice === 'chat') {
    return { route: triage ? { ...route, thinking: 'off' } : route, fallbackModel: null };
  }
  const provider = providerOf(route.model, route.authProvider);
  const fastId = provider ? choice.fastModels?.[provider]?.trim() : '';
  const fast = fastId ? qualified(fastId, provider) : null;
  const requested = choice.model?.trim();
  const model = requested && provider && providerOf(requested, choice.provider) === provider
    ? qualified(requested, provider)
    : fast ?? route.model;
  const thinking = triage ? 'off' : choice.thinking?.trim() || DIGEST_THINKING;
  return { route: { ...route, model, thinking }, fallbackModel: fast && fast !== model ? fast : null };
}

export function runDesktopDigest(input: {
  runId: string;
  claimId: string;
  ownerAccountId: string;
  systemPrompt: string;
  prompt: string;
  tools: DigestTool[];
  route: DesktopChatMessageRoute;
  fallbackModel: string | null;
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
    runtimeRoute: claimRuntimeRoute(route),
  });
  if (!claim.acquired || !claim.digest) return 'not-acquired';
  let lost = false;
  const timer = setInterval(() => {
    void client.desktopAgentExecution(token, `${encodeURIComponent(request.runId)}/renew`, { claimId })
      .catch(() => { lost = true; });
  }, RENEW_MS);
  const path = `digest/desktop/${encodeURIComponent(request.runId)}`;
  const chosen = digestRunRoute(route, claim.digest);
  try {
    const text = await (runtime.run ?? runDesktopDigest)({
      runId: request.runId, claimId, ownerAccountId: accountId,
      systemPrompt: claim.digest.systemPrompt, prompt: claim.digest.prompt, tools: claim.digest.tools,
      route: chosen.route, fallbackModel: chosen.fallbackModel,
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
