import { cloudApiBaseUrl, type CloudAuthClient } from '@/features/cloud/authClient';
import { cloudGroupAgentRequestRuntimeSessionId, cloudGroupAgentRuntimeSessionId } from '@/features/cloud/cloudAgentRuntime';
import { waitForCloudAgentTurn } from '@/features/cloud/cloudAgentLocalExecution';
import { CloudAuthError } from '@/features/cloud/cloudAuthError';
import { acquireDesktopExecutionLease, DESKTOP_EXECUTION_WATCHDOG_MS } from '@/features/cloud/cloudDesktopExecutionLease';
import { handBackDesktopRun } from '@/features/cloud/cloudDesktopRunHandback';
import { cloudFetchImpl } from '@/features/cloud/cloudTransport';
import { claimRuntimeRoute, digestRunRoute, macCanRunDigest, runDesktopDigest, type DigestRunChoice, type DigestTool } from '@/features/digest/digestMacRuns';
import type { DesktopChatContextMessage, DesktopChatMessageRoute } from '@/lib/desktop';
import { startDesktopSharedChatMessage } from '@/lib/desktopBackgroundSessions';
import type { ProactiveRunRequest } from './proactiveRunHints';

// Proactive runs on this Mac. While this Mac is ready for them, the server
// holds an agent's evaluation of a group and an offer the owner allowed for
// this Mac, and announces each with an account hint. This Mac claims the run,
// runs it, and submits the reply, which the server handles exactly like a
// cloud reply. A run this Mac cannot finish goes back to the cloud at once; a
// run it never claims is run by the cloud once the hold ends.

const RENEW_MS = 10_000;

/** Added to an approved run's system context: the run's tools work in an empty folder. */
export const PROACTIVE_RUN_FOLDER_LINE = "This run works in an empty folder of its own. Do not search your owner's home folder or other personal folders. If you need code or files, get them from where your owner's memories say they live, or ask for them in your answer.";

export type ProactiveMacOutcome = 'skipped' | 'not-acquired' | 'completed' | 'released';

type EvaluationClaim = {
  runId?: string;
  acquired: boolean;
  proactive?: DigestRunChoice & { kind?: string; systemPrompt?: string; prompt?: string; tools?: unknown };
};

export type ProactiveMacRuntime = {
  accountId: string;
  token: string;
  route: DesktopChatMessageRoute | null | undefined;
  client: Pick<CloudAuthClient, 'desktopAgentExecution'>;
  /** POSTs to `/v1/cloud/<path>` as the signed-in account. */
  post?: (path: string, body: unknown) => Promise<unknown>;
  /** Reports why this Mac handed a run back. */
  report?: (message: string, error: unknown) => void;
  runTurn?: typeof runDesktopDigest;
  startTurn?: typeof startDesktopSharedChatMessage;
  waitForTurn?: typeof waitForCloudAgentTurn;
  acquireLease?: typeof acquireDesktopExecutionLease;
  /** Wait between hand-back attempts; tests shorten it. */
  handBackRetryMs?: number;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function postProactive(token: string, path: string, body: unknown) {
  const response = await cloudFetchImpl()(`${cloudApiBaseUrl()}/v1/cloud/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw Object.assign(new Error('The proactive run could not be completed.'), { status: response.status });
}

/** The claim's tools (the memory search) in the digest command's shape; anything else is dropped. */
function claimTools(value: unknown): DigestTool[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).filter((tool): tool is DigestTool => {
    const entry = tool as { name?: unknown; description?: unknown } | null;
    return typeof entry?.name === 'string' && typeof entry.description === 'string';
  });
}

function completePath(runId: string) {
  return `proactive/desktop/${encodeURIComponent(runId)}/complete`;
}

/** Only the server's refusal ends a renewal; a slow or failed request is retried. */
const renewalRefused = (error: unknown) => error instanceof CloudAuthError && [401, 403, 404, 409].includes(error.status);

/** Renews an evaluation lease until stopped; `lost` once refused or unrenewed too long. */
function renewEvaluation(client: ProactiveMacRuntime['client'], token: string, runId: string, claimId: string) {
  let refused = false;
  let renewedAt = Date.now();
  const timer = setInterval(() => {
    const sentAt = Date.now();
    void client.desktopAgentExecution(token, `${encodeURIComponent(runId)}/renew`, { claimId })
      .then(() => { renewedAt = sentAt; }, (error: unknown) => { if (renewalRefused(error)) refused = true; });
  }, RENEW_MS);
  return {
    get lost() { return refused || Date.now() - renewedAt >= DESKTOP_EXECUTION_WATCHDOG_MS; },
    stop() { clearInterval(timer); },
  };
}

/**
 * Claims and runs one evaluation: one turn through the digest's command, with
 * the claim's prompt, system prompt, model choice and tools. Its only tool is
 * the memory search, which the server answers through the digest observe route.
 */
export async function runProactiveEvaluationOnMac(
  request: Extract<ProactiveRunRequest, { kind: 'evaluation' }>,
  runtime: ProactiveMacRuntime,
): Promise<ProactiveMacOutcome> {
  const { accountId, token, client, route } = runtime;
  if (!route || !macCanRunDigest(route)) return 'skipped';
  const claimId = crypto.randomUUID();
  const claim = await client.desktopAgentExecution<EvaluationClaim>(token, 'claim', {
    claimId, requestMessageId: request.runId, sessionId: request.sessionId,
    ownerAccountId: accountId, requesterAccountId: accountId, prompt: 'proactive', idempotencyKey: request.runId,
    runtimeRoute: claimRuntimeRoute(route),
  });
  if (!claim?.acquired) return 'not-acquired';
  const runId = text(claim.runId) || request.runId;
  const renewal = renewEvaluation(client, token, runId, claimId);
  try {
    const evaluation = claim.proactive;
    const prompt = text(evaluation?.prompt);
    if (evaluation?.kind !== 'evaluation' || !prompt) throw new Error('The evaluation claim had no prompt.');
    const chosen = digestRunRoute(route, evaluation);
    const reply = await (runtime.runTurn ?? runDesktopDigest)({
      runId, claimId, ownerAccountId: accountId,
      systemPrompt: evaluation.systemPrompt ?? '', prompt, tools: claimTools(evaluation.tools),
      route: chosen.route, fallbackModel: chosen.fallbackModel,
    });
    if (renewal.lost) throw new Error('This Mac no longer holds the evaluation.');
    await (runtime.post ?? ((path, body) => postProactive(token, path, body)))(completePath(runId), { claimId, text: reply });
    return 'completed';
  } catch (error) {
    runtime.report?.('[proactive-mac] evaluation handed back to the cloud', error);
    await handBackDesktopRun(client, token, { runId, claimId, dispose: () => renewal.stop() }, { retryMs: runtime.handBackRetryMs });
    return 'released';
  } finally {
    renewal.stop();
  }
}

function approvedClaim(claim: Readonly<Record<string, unknown>>) {
  // `proactive.kind` names the run kind; a claim of another kind is refused.
  const kind = (claim.proactive as { kind?: unknown } | undefined)?.kind;
  const prompt = text(claim.prompt);
  if ((kind !== undefined && kind !== 'approved') || !prompt) return null;
  const identity = claim.turnIdentity as { agentId?: unknown } | undefined;
  return { prompt, systemPrompt: text(claim.systemPrompt), contextSessionId: text(claim.contextSessionId), agentId: text(identity?.agentId) };
}

/**
 * Claims and runs one approved offer: a full shared-chat turn with the
 * owner's tools, scoped to the group the offer was made in, with the run's
 * system prompt as context.
 */
export async function runProactiveApprovedOnMac(
  request: Extract<ProactiveRunRequest, { kind: 'approved' }>,
  runtime: ProactiveMacRuntime,
): Promise<ProactiveMacOutcome> {
  const { accountId, token, client, route } = runtime;
  if (!route || !macCanRunDigest(route)) return 'skipped';
  const lease = await (runtime.acquireLease ?? acquireDesktopExecutionLease)(client, token, {
    requestMessageId: request.runId, sessionId: request.sessionId, ownerAccountId: accountId,
    requesterAccountId: accountId, prompt: 'proactive', idempotencyKey: request.runId,
    targetCloudAgentId: request.agentId, runtimeRoute: claimRuntimeRoute(route),
  });
  if (!lease) return 'not-acquired';
  try {
    const claim = approvedClaim(lease.claim);
    if (!claim) throw new Error('The approved run claim had no prompt.');
    if (!await lease.admitted()) throw new Error('The approved run was not admitted.');
    const scope = claim.contextSessionId || request.sessionId;
    const base = cloudGroupAgentRuntimeSessionId(accountId, scope, claim.agentId || request.agentId)
      ?? `session:proactive:${accountId}`;
    const system: DesktopChatContextMessage[] = [{
      id: `proactive-system:${lease.runId}`, authorName: 'Proactive run', authorKind: 'agent',
      contextRole: 'system', text: [claim.systemPrompt, PROACTIVE_RUN_FOLDER_LINE].filter(Boolean).join('\n\n'),
    }];
    const turn = await (runtime.startTurn ?? startDesktopSharedChatMessage)(
      request.runId,
      cloudGroupAgentRequestRuntimeSessionId(base, request.runId),
      claim.prompt,
      [],
      route,
      lease.contextMessages(system),
      [],
      scope,
      lease.deadline,
      null,
      { kind: 'proactiveRun', runId: request.runId },
    );
    lease.attach(turn.id);
    const final = turn.completed ? turn : await (runtime.waitForTurn ?? waitForCloudAgentTurn)(turn.id);
    const reply = final.assistantText.trim();
    if (!final.succeeded || !reply) throw new Error(final.error || 'The run finished without an answer.');
    if (lease.lost) throw new Error('This Mac no longer holds the run.');
    await (runtime.post ?? ((path, body) => postProactive(token, path, body)))(completePath(lease.runId), { claimId: lease.claimId, text: reply });
    return 'completed';
  } catch (error) {
    runtime.report?.('[proactive-mac] approved run handed back to the cloud', error);
    await handBackDesktopRun(client, token, lease, { retryMs: runtime.handBackRetryMs });
    return 'released';
  } finally {
    lease.dispose();
  }
}

/** Runs one announced proactive run on this Mac. */
export function runProactiveOnMac(request: ProactiveRunRequest, runtime: ProactiveMacRuntime) {
  return request.kind === 'evaluation'
    ? runProactiveEvaluationOnMac(request, runtime)
    : runProactiveApprovedOnMac(request, runtime);
}
