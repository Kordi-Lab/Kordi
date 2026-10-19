import { cloudApiBaseUrl, type CloudAuthClient } from './authClient';
import { cloudGroupAgentRequestRuntimeSessionId, cloudAgentRuntimeSessionId } from './cloudAgentRuntime';
import { acquireDesktopExecutionLease } from './cloudDesktopExecutionLease';
import { cloudFetchImpl } from './cloudTransport';
import { waitForCloudAgentTurn } from './cloudAgentLocalExecution';
import { startDesktopSharedChatMessage } from '@/lib/desktopBackgroundSessions';
import { claimRuntimeRoute } from '@/features/digest/digestMacRuns';
import type { DesktopChatMessageRoute } from '@/lib/desktop';

// Scheduled tasks on this Mac. While this Mac is ready, the server holds each
// occurrence for it: a cloud task for one presence timeout, a task that needs
// the Mac until a Mac runs it or its wait ends. This Mac picks held runs up,
// runs them with its normal agent turn, and submits the answer, which the
// server delivers exactly like a cloud answer.

export type ScheduledMacRun = {
  runId: string;
  requestMessageId: string;
  sessionId: string;
  requesterAccountId: string;
  prompt: string;
};

export type ScheduledMacRuntime = {
  accountId: string;
  token: string;
  route: DesktopChatMessageRoute | null | undefined;
  client: Pick<CloudAuthClient, 'desktopAgentExecution'>;
  /** Calls `/v1/cloud/scheduled-task-runs/desktop/<path>` as the signed-in account. */
  request?: (path: string, method: 'GET' | 'POST', body?: unknown) => Promise<unknown>;
  startTurn?: typeof startDesktopSharedChatMessage;
  waitForTurn?: typeof waitForCloudAgentTurn;
  acquireLease?: typeof acquireDesktopExecutionLease;
};

async function desktopRequest(token: string, path: string, method: 'GET' | 'POST', body?: unknown) {
  const response = await cloudFetchImpl()(`${cloudApiBaseUrl()}/v1/cloud/scheduled-task-runs/desktop/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error('The scheduled run could not be updated.'), { status: response.status });
  return text ? JSON.parse(text) as unknown : undefined;
}

function scheduledRun(value: unknown): ScheduledMacRun | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const field = (key: keyof ScheduledMacRun) => (typeof record[key] === 'string' ? record[key] : '');
  const run: ScheduledMacRun = {
    runId: field('runId'), requestMessageId: field('requestMessageId'), sessionId: field('sessionId'),
    requesterAccountId: field('requesterAccountId'), prompt: field('prompt'),
  };
  return run.requestMessageId.startsWith('scheduled_run_') && Object.values(run).every(Boolean) ? run : null;
}

function scheduledRuns(value: unknown): ScheduledMacRun[] {
  return Array.isArray(value) ? value.map(scheduledRun).filter((run): run is ScheduledMacRun => run !== null) : [];
}

/**
 * Claims and runs one held scheduled run. Returns `not-acquired` when another
 * runtime holds it, `completed`, or `failed` when this Mac could not finish;
 * the server then hands a cloud task to the cloud and ends a Mac-only task
 * with a reply that says so.
 */
export async function runScheduledOnMac(
  run: ScheduledMacRun,
  runtime: ScheduledMacRuntime,
): Promise<'not-acquired' | 'completed' | 'failed'> {
  const { accountId, token, client, route } = runtime;
  const request = runtime.request ?? ((path, method, body) => desktopRequest(token, path, method, body));
  const lease = await (runtime.acquireLease ?? acquireDesktopExecutionLease)(client, token, {
    requestMessageId: run.requestMessageId, sessionId: run.sessionId, ownerAccountId: accountId,
    requesterAccountId: run.requesterAccountId, prompt: run.prompt, idempotencyKey: `scheduled:${run.requestMessageId}`,
    runtimeRoute: claimRuntimeRoute(route),
  });
  if (!lease) return 'not-acquired';
  const path = encodeURIComponent(lease.runId);
  try {
    if (!await lease.admitted()) return 'not-acquired';
    const base = cloudAgentRuntimeSessionId(accountId, run.sessionId) ?? `session:scheduled:${accountId}`;
    const turn = await (runtime.startTurn ?? startDesktopSharedChatMessage)(
      run.requestMessageId,
      cloudGroupAgentRequestRuntimeSessionId(base, run.requestMessageId),
      run.prompt,
      [],
      route,
      lease.contextMessages([]),
      [],
      run.sessionId,
      lease.deadline,
    );
    lease.attach(turn.id);
    const final = turn.completed ? turn : await (runtime.waitForTurn ?? waitForCloudAgentTurn)(turn.id);
    const text = final.assistantText.trim();
    if (!final.succeeded || !text) throw new Error(final.error || 'The task finished without an answer.');
    await request(`${path}/complete`, 'POST', { claimId: lease.claimId, text });
    return 'completed';
  } catch {
    if (!lease.lost) await request(`${path}/fail`, 'POST', { claimId: lease.claimId }).catch(() => undefined);
    return 'failed';
  } finally {
    lease.dispose();
  }
}

/** Runs every scheduled run the server holds for this Mac, once each. */
export async function discoverScheduledMacRuns(runtime: ScheduledMacRuntime, started: Set<string>) {
  const request = runtime.request ?? ((path, method, body) => desktopRequest(runtime.token, path, method, body));
  const runs = scheduledRuns(await request('pending', 'GET'));
  for (const run of runs) {
    if (started.has(run.requestMessageId)) continue;
    started.add(run.requestMessageId);
    void runScheduledOnMac(run, runtime).catch(() => 'failed');
  }
}
