import { useCallback, useEffect, useState } from 'react';

import {
  deleteScheduledTask,
  listScheduledTasks,
  pauseScheduledTask,
  resumeScheduledTask,
  runScheduledTaskNow,
  type ScheduledTask,
} from './scheduledTasksClient';
import { cloudApiBaseUrl } from './authClient';
import { loadSession } from './session';

export type UseScheduledTasksResult = {
  tasks: ScheduledTask[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  refresh: () => Promise<void>;
  pause: (taskId: string) => Promise<void>;
  resume: (taskId: string) => Promise<void>;
  runNow: (taskId: string) => Promise<void>;
  remove: (taskId: string) => Promise<void>;
};

async function withCloudSession<T>(operation: (config: { apiBase: string; token: string }) => Promise<T>): Promise<T | null> {
  const session = await loadSession();
  if (!session?.token) return null;
  return operation({ apiBase: cloudApiBaseUrl(), token: session.token });
}

export function useScheduledTasks({ enabled = true, pollMs = 10_000 }: { enabled?: boolean; pollMs?: number } = {}): UseScheduledTasksResult {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [status, setStatus] = useState<UseScheduledTasksResult['status']>('idle');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setStatus((current) => (current === 'ready' ? 'ready' : 'loading'));
    setError(null);
    try {
      const next = await withCloudSession((config) => listScheduledTasks(config));
      setTasks(next ?? []);
      setStatus('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load scheduled tasks.');
      setStatus('error');
    }
  }, [enabled]);

  const mutateAndRefresh = useCallback(async (operation: () => Promise<unknown>) => {
    setError(null);
    try {
      await operation();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update scheduled task.');
      setStatus('error');
    }
  }, [refresh]);

  const pause = useCallback(async (taskId: string) => {
    await mutateAndRefresh(async () => withCloudSession((config) => pauseScheduledTask(config, taskId)));
  }, [mutateAndRefresh]);

  const resume = useCallback(async (taskId: string) => {
    await mutateAndRefresh(async () => withCloudSession((config) => resumeScheduledTask(config, taskId)));
  }, [mutateAndRefresh]);

  const runNow = useCallback(async (taskId: string) => {
    await mutateAndRefresh(async () => withCloudSession((config) => runScheduledTaskNow(config, taskId)));
  }, [mutateAndRefresh]);

  const remove = useCallback(async (taskId: string) => {
    await mutateAndRefresh(async () => withCloudSession((config) => deleteScheduledTask(config, taskId)));
  }, [mutateAndRefresh]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    if (pollMs <= 0) return;
    const timer = window.setInterval(() => { void refresh(); }, pollMs);
    return () => window.clearInterval(timer);
  }, [enabled, pollMs, refresh]);

  return { tasks, status, error, refresh, pause, resume, runNow, remove };
}
