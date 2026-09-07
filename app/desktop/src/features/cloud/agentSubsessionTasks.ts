import { useEffect, useState } from 'react';
import { CloudAuthClient, CloudAuthError } from './authClient';
import { CLOUD_SESSION_CHANGED_EVENT, loadSession } from './session';
import type { AgentSubsessionTask, CloudAgentSubsession } from './agentSubsessionTypes';

export function agentSubsessionStatusNotice(task: Pick<CloudAgentSubsession, 'status' | 'live' | 'queued' | 'startedAtMs'>) {
  if (task.queued && !(task.status === 'running' && task.startedAtMs != null)) return 'Queued next';
  return task.status === 'running' && task.live === false ? 'Status unavailable' : null;
}

export function agentThreadStatus(task: AgentSubsessionTask) {
  if (task.status === 'running' && task.startedAtMs != null) return task.live ? 'Running' : 'Status unavailable';
  if (task.queued) return 'Queued next';
  if (task.status === 'done') return 'Done';
  if (task.status === 'failed') return 'Failed';
  if (task.status === 'stopped') return 'Stopped';
  return 'Status unavailable';
}

export function agentThreadElapsed(task: AgentSubsessionTask, now = Date.now()) {
  const start = task.startedAtMs;
  const end = task.status === 'running' && task.live ? now : task.finishedAtMs;
  if (task.queued && !task.live || start == null || end == null || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
}

export function useAgentSubsessionTasks(parentSessionId: string | null) {
  const [snapshot, setSnapshot] = useState<{parent: string; tasks: AgentSubsessionTask[]; error: string | null} | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const reset = () => { setSnapshot(null); setRevision(value => value + 1); };
    window.addEventListener(CLOUD_SESSION_CHANGED_EVENT, reset);
    return () => window.removeEventListener(CLOUD_SESSION_CHANGED_EVENT, reset);
  }, []);
  useEffect(() => {
    if (!parentSessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const account = await loadSession();
        if (cancelled) return;
        if (!account) { setSnapshot({ parent: parentSessionId, tasks: [], error: null }); return; }
        const client = new CloudAuthClient();
        const tasks: AgentSubsessionTask[] = [];
        let after: string | undefined;
        const cursors = new Set<string>();
        do {
          const page = await client.listAgentSubsessionTasks(account.token, parentSessionId, after);
          if (cancelled || (await loadSession())?.accountId !== account.accountId) return;
          tasks.push(...page.sessions);
          after = page.nextCursor ?? undefined;
          if (after && cursors.has(after)) throw Error('Repeated page cursor');
          if (after) cursors.add(after);
        } while (after);
        setSnapshot({ parent: parentSessionId, tasks, error: null });
      } catch (error) {
        if (cancelled) return;
        const denied = error instanceof CloudAuthError && [401, 403, 404].includes(error.status ?? 0);
        setSnapshot(current => ({ parent: parentSessionId,
          tasks: !denied && current?.parent === parentSessionId ? current.tasks.map(task => ({ ...task, live: false })) : [],
          error: 'Could not refresh Agent threads. Check access or try again.',
        }));
      }
      if (!cancelled) timer = setTimeout(() => { void refresh(); }, 3000);
    };
    void refresh();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [parentSessionId, revision]);
  return snapshot?.parent === parentSessionId ? { ...snapshot, loading: false } : { tasks: [], error: null, loading: Boolean(parentSessionId) };
}
