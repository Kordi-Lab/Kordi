import { cloudApiBaseUrl, type CloudAuthClient } from './authClient';
import { cloudGroupAgentRequestRuntimeSessionId, cloudAgentRuntimeSessionId } from './cloudAgentRuntime';
import { acquireDesktopExecutionLease } from './cloudDesktopExecutionLease';
import { cloudFetchImpl } from './cloudTransport';
import { waitForCloudAgentTurn } from './cloudAgentLocalExecution';
import { startDesktopSharedChatMessage } from '@/lib/desktopBackgroundSessions';
import { claimRuntimeRoute } from '@/features/digest/digestMacRuns';
import type { DesktopChatMessageRoute } from '@/lib/desktop';

// Durable requests and continuations use the same Mac execution lease as chat.

export type AgentExchangeMacRun = {
  runId: string;
  requestMessageId: string;
  sessionId: string;
  requesterAccountId: string;
  prompt: string;
  systemPrompt: string;
  runtimeRoute?: { defaultModel?: string; defaultAuthProvider?: string; defaultAuthChoice?: string; thinking?: string };
};

export type AgentExchangeMacRuntime = {
  accountId: string;
  token: string;
  route: DesktopChatMessageRoute | null | undefined;
  client: Pick<CloudAuthClient, 'desktopAgentExecution'>;
  /** Calls `/v1/cloud/agent-exchanges/desktop/<path>` as the signed-in account. */
  request?: (path: string, method: 'GET' | 'POST', body?: unknown) => Promise<unknown>;
  startTurn?: typeof startDesktopSharedChatMessage;
  waitForTurn?: typeof waitForCloudAgentTurn;
  acquireLease?: typeof acquireDesktopExecutionLease;
};

async function desktopRequest(token: string, path: string, method: 'GET' | 'POST', body?: unknown) {
  const response = await cloudFetchImpl()(`${cloudApiBaseUrl()}/v1/cloud/agent-exchanges/desktop/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error('The agent-exchange run could not be updated.'), { status: response.status });
  return text ? JSON.parse(text) as unknown : undefined;
}

function agentExchangeRun(value: unknown): AgentExchangeMacRun | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const field = (key: keyof AgentExchangeMacRun) => (typeof record[key] === 'string' ? record[key] : '');
  const run: AgentExchangeMacRun = {
    runId: field('runId'), requestMessageId: field('requestMessageId'), sessionId: field('sessionId'),
    requesterAccountId: field('requesterAccountId'), prompt: field('prompt'), systemPrompt: field('systemPrompt'),
    runtimeRoute: record.runtimeRoute as AgentExchangeMacRun['runtimeRoute'],
  };
  return run.requestMessageId.startsWith('agent-exchange:') && [run.runId,run.sessionId,run.requesterAccountId,run.prompt].every(Boolean) ? run : null;
}

function agentExchangeRuns(value: unknown): AgentExchangeMacRun[] {
  return Array.isArray(value) ? value.map(agentExchangeRun).filter((run): run is AgentExchangeMacRun => run !== null) : [];
}

/** Runs a leased request or continuation and durably acknowledges its result. */
export async function runAgentExchangeOnMac(
  run: AgentExchangeMacRun,
  runtime: AgentExchangeMacRuntime,
): Promise<'not-acquired' | 'completed' | 'failed'> {
  const { accountId, token, client } = runtime;
  const selected = run.runtimeRoute;
  const route = selected?.defaultModel ? { model: selected.defaultModel, authProvider: selected.defaultAuthProvider,
    authChoice: selected.defaultAuthChoice, thinking: selected.thinking } : runtime.route;
  const request = runtime.request ?? ((path, method, body) => desktopRequest(token, path, method, body));
  const lease = await (runtime.acquireLease ?? acquireDesktopExecutionLease)(client, token, {
    requestMessageId: run.requestMessageId, sessionId: run.sessionId, ownerAccountId: accountId,
    requesterAccountId: run.requesterAccountId, prompt: run.prompt, idempotencyKey: `agent-exchange:${run.requestMessageId}`,
    runtimeRoute: claimRuntimeRoute(route),
  });
  if (!lease) return 'not-acquired';
  const path = encodeURIComponent(lease.runId);
  try {
    if (!await lease.admitted()) return 'not-acquired';
    const base = cloudAgentRuntimeSessionId(accountId, run.sessionId) ?? `session:agent-exchange:${accountId}`;
    const turn = await (runtime.startTurn ?? startDesktopSharedChatMessage)(
      `${run.requestMessageId}:${lease.claimId}`,
      cloudGroupAgentRequestRuntimeSessionId(base, `${run.requestMessageId}:${lease.claimId}`),
      run.prompt,
      [],
      route,
      lease.contextMessages(run.systemPrompt ? [{ id: `agent-exchange-policy:${run.runId}`, authorName: 'Kordi runtime', authorKind: 'agent', contextRole: 'system', text: run.systemPrompt }] : []),
      [],
      run.sessionId,
      lease.deadline,
    );
    lease.attach(turn.id);
    const final = turn.completed ? turn : await (runtime.waitForTurn ?? waitForCloudAgentTurn)(turn.id);
    const text = final.assistantText.trim();
    if (!final.succeeded || !text) throw new Error(final.error || 'The task finished without an answer.');
    // Retry the same result if the HTTP acknowledgement was lost.
    let confirmed = false;
    for (let attempt = 0; attempt < 3 && !lease.lost; attempt++) {
      try {
        await request(`${path}/complete`, 'POST', { claimId: lease.claimId, text });
        confirmed = true;
        break;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
    if (!confirmed) return 'failed';
    return 'completed';
  } catch {
    if (!lease.lost) await request(`${path}/fail`, 'POST', { claimId: lease.claimId }).catch(() => undefined);
    return 'failed';
  } finally {
    lease.dispose();
  }
}

/** Runs every agent-exchange run the server holds for this Mac, once each. */
export async function discoverAgentExchangeMacRuns(runtime: AgentExchangeMacRuntime, started: Set<string>) {
  const request = runtime.request ?? ((path, method, body) => desktopRequest(runtime.token, path, method, body));
  const runs = agentExchangeRuns(await request('pending', 'GET'));
  for (const run of runs) {
    if (started.has(run.requestMessageId)) continue;
    started.add(run.requestMessageId);
    void runAgentExchangeOnMac(run, runtime).catch(() => 'failed').finally(() => started.delete(run.requestMessageId));
  }
}
