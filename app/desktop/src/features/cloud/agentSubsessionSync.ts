import { CloudAuthClient, CloudAuthError } from './authClient';
import { loadSession } from './session';
import { fetchDesktopSubsessionSnapshot } from '@/lib/desktopBackgroundSessions';
import { cancelDesktopChatTurn, renewDesktopChatExecutionLease } from '@/lib/desktop';
import { relatedAgentSessionsFromTools, normalizedRelatedAgentSessionStatus } from '@/features/chat/relatedAgentSessions';
import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';

const jobs = new Map<string, Promise<void>>();
class SubsessionSyncStop extends Error {}
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
    // The cloud refused this snapshot: keep the task running on this Mac and
    // stop publishing it, instead of letting the task's watchdog stop it.
    let publishRefused = false;
    let runningTurnId: string | null = null;
    try {
      for (;;) {
        const current = await loadSession();
        if (!current || current.accountId !== account.accountId) throw new Error('Account changed.');
        let published = false;
        try {
          const snapshot = await fetchDesktopSubsessionSnapshot(id);
          if (!snapshot.parentRequestId) throw new SubsessionSyncStop('This task has no shared request identity.');
          snapshot.status = normalizedRelatedAgentSessionStatus(snapshot.status);
          runningTurnId = snapshot.turnId && snapshot.status === 'running' ? snapshot.turnId : null;
          const afterRead = await loadSession();
          if (afterRead?.accountId !== account.accountId) throw new Error('Account changed.');
          if (!publishRefused) {
            if (version == null) {
              const record = await client.getAgentSubsession(current.token, id).catch((error) => {
                if (error instanceof CloudAuthError && error.status === 404) return null;
                throw error;
              });
              if ((await loadSession())?.accountId !== account.accountId) throw new Error('Account changed.');
              if (record?.status === 'stopped' && runningTurnId) {
                await cancelDesktopChatTurn(runningTurnId);
                resolveFirst();
                return;
              }
              version = record?.version ?? 0;
            }
            const saved = await client.putAgentSubsession(current.token, snapshot, version);
            version = saved.version;
            resolveFirst();
            if (saved.status === 'stopped' && runningTurnId) {
              await cancelDesktopChatTurn(runningTurnId);
              return;
            }
            if (saved.hasFollowupExecution) return;
          }
          published = true;
          if (!runningTurnId) return;
        } catch (error) {
          if (error instanceof SubsessionSyncStop || (error instanceof Error && error.message === 'Account changed.')) throw error;
          if (error instanceof CloudAuthError && [400, 403].includes(error.status ?? 0)) {
            publishRefused = true;
            resolveFirst();
          }
          // Anything else (a native read that failed once, an access token
          // that was just refreshed, a lost response) is retried. A lost
          // response may already have committed, so the version is reloaded;
          // retries never create or restart a model runtime.
          version = null;
        }
        // The task keeps running while this Mac watches it. A failed attempt
        // skips one renewal and is retried well before the 30 s deadline;
        // only a stop, a sign-out or this page closing ends the task.
        if (runningTurnId && (published || publishRefused)) await renewDesktopChatExecutionLease(runningTurnId, Date.now() + 30_000).catch(() => undefined);
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
