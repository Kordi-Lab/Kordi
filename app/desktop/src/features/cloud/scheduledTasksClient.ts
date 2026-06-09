export type ScheduledTaskSchedule =
  | { kind: 'once'; at: string }
  | { kind: 'daily'; time: string; timezone?: string };

export type ScheduledTaskTargetRuntime = 'cloud' | 'localRequired';

export type ScheduledTask = {
  taskId: string;
  title: string;
  prompt: string;
  schedule: ScheduledTaskSchedule;
  targetRuntime: 'cloud' | 'local_required';
  enabled: boolean;
  status: 'active' | 'paused' | 'deleted' | string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ScheduledTaskRun = {
  runId: string;
  taskId: string;
  status: string;
  targetRuntime: string;
  dueAt: string;
  resultMessage: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type CreateScheduledTaskInput = {
  title: string;
  prompt: string;
  schedule: ScheduledTaskSchedule;
  targetRuntime: ScheduledTaskTargetRuntime;
  toolPayload?: unknown;
};

export type ScheduledTasksClientConfig = {
  apiBase: string;
  token: string;
  fetcher?: typeof fetch;
};

async function requestJson<T>(config: ScheduledTasksClientConfig, path: string, init: RequestInit = {}): Promise<T> {
  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(`${config.apiBase}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${config.token}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!response.ok) throw new Error(`Scheduled task request failed: ${response.status}`);
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export async function listScheduledTasks(config: ScheduledTasksClientConfig): Promise<ScheduledTask[]> {
  const result = await requestJson<{ tasks: ScheduledTask[] }>(config, '/v1/cloud/scheduled-tasks');
  return result.tasks;
}

export async function listScheduledTaskRuns(config: ScheduledTasksClientConfig, taskId: string): Promise<ScheduledTaskRun[]> {
  const result = await requestJson<{ runs: ScheduledTaskRun[] }>(config, `/v1/cloud/scheduled-tasks/${encodeURIComponent(taskId)}/runs`);
  return result.runs;
}

export async function createScheduledTask(config: ScheduledTasksClientConfig, input: CreateScheduledTaskInput): Promise<ScheduledTask> {
  const result = await requestJson<{ task: ScheduledTask }>(config, '/v1/cloud/scheduled-tasks', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return result.task;
}

export async function pauseScheduledTask(config: ScheduledTasksClientConfig, taskId: string): Promise<ScheduledTask> {
  const result = await requestJson<{ task: ScheduledTask }>(config, `/v1/cloud/scheduled-tasks/${encodeURIComponent(taskId)}/pause`, { method: 'POST' });
  return result.task;
}

export async function resumeScheduledTask(config: ScheduledTasksClientConfig, taskId: string): Promise<ScheduledTask> {
  const result = await requestJson<{ task: ScheduledTask }>(config, `/v1/cloud/scheduled-tasks/${encodeURIComponent(taskId)}/resume`, { method: 'POST' });
  return result.task;
}

export async function runScheduledTaskNow(config: ScheduledTasksClientConfig, taskId: string): Promise<ScheduledTaskRun> {
  const result = await requestJson<{ run: ScheduledTaskRun }>(config, `/v1/cloud/scheduled-tasks/${encodeURIComponent(taskId)}/run-now`, { method: 'POST' });
  return result.run;
}

export async function deleteScheduledTask(config: ScheduledTasksClientConfig, taskId: string): Promise<void> {
  await requestJson<void>(config, `/v1/cloud/scheduled-tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
}
