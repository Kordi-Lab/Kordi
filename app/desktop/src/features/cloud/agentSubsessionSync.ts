import { CloudAuthClient, CloudAuthError } from './authClient';
import { loadSession } from './session';
import { fetchDesktopSubsessionSnapshot } from '@/lib/desktopBackgroundSessions';
import { renewDesktopChatExecutionLease } from '@/lib/desktop';
import { relatedAgentSessionsFromTools, normalizedRelatedAgentSessionStatus } from '@/features/chat/relatedAgentSessions';
import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';

const jobs = new Map<string, Promise<void>>();
const pause = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

export async function publishModelSubsession(id: string): Promise<void> {
  const account = await loadSession();
  if (!account) throw new Error('Sign in to synchronize this task.');
  const key = `${account.accountId}:${id}`;
  const existing = jobs.get(key);
  if (existing) return existing;
  let resolveFirst!: () => void;
  let rejectFirst!: (error: unknown) => void;
  const first = new Promise<void>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
  jobs.set(key, first);
  const client = new CloudAuthClient();
  void (async () => {
    let version: number | null = null;
    try {
      for (;;) {
        const current = await loadSession();
        if (!current || current.accountId !== account.accountId) throw new Error('Account changed.');
        const snapshot = await fetchDesktopSubsessionSnapshot(id);
        if (!snapshot.parentRequestId) throw new Error('This task has no shared request identity.');
        snapshot.status = normalizedRelatedAgentSessionStatus(snapshot.status);
        const afterRead = await loadSession();
        if (afterRead?.accountId !== account.accountId) throw new Error('Account changed.');
        try {
          if (version == null) {
            version = await client.getAgentSubsession(current.token, id).then((record) => record.version).catch((error) => {
              if (error instanceof CloudAuthError && error.status === 404) return 0;
              throw error;
            });
          }
          const sentAt=Date.now();
          const saved = await client.putAgentSubsession(current.token, snapshot, version);
          version = saved.version;
          resolveFirst();
          if (saved.hasFollowupExecution) return;
          if (snapshot.turnId && snapshot.status==='running') await renewDesktopChatExecutionLease(snapshot.turnId,sentAt+30_000);
          if (snapshot.status !== 'running') return;
        } catch (error) {
          if (error instanceof CloudAuthError && [400, 401, 403].includes(error.status ?? 0)) throw error;
          // A lost response may already have committed. Reload the version;
          // synchronization retries never create or restart a model runtime.
          version = null;
        }
        await pause(1500);
      }
    } catch (error) { rejectFirst(error); }
    finally { jobs.delete(key); }
  })();
  return first;
}

export async function publishModelSubsessions(turn: Pick<DesktopChatTurnSnapshot, 'tools'>): Promise<void> {
  await Promise.all(relatedAgentSessionsFromTools(turn.tools).map((session) => publishModelSubsession(session.sessionId)));
}
