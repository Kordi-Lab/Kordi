import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createScheduledTask,
  deleteScheduledTask,
  listScheduledTaskRuns,
  listScheduledTasks,
  pauseScheduledTask,
  resumeScheduledTask,
  runScheduledTaskNow,
} from '../src/features/cloud/scheduledTasksClient';

test('scheduled tasks client calls cloud tool endpoints with bearer auth', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const stringUrl = String(url);
    calls.push({ url: stringUrl, init: init ?? {} });
    if (stringUrl.endsWith('/run-now')) return new Response(JSON.stringify({ run: { runId: 'run1', taskId: 'task1', status: 'queued', targetRuntime: 'cloud', dueAt: '2026-06-08T09:00:00Z', resultMessage: null, errorCode: null, errorMessage: null, createdAt: '2026-06-08T09:00:00Z', updatedAt: '2026-06-08T09:00:00Z', completedAt: null } }), { status: 200 });
    if (stringUrl.endsWith('/runs')) return new Response(JSON.stringify({ runs: [{ runId: 'run1', taskId: 'task1', status: 'completed', targetRuntime: 'cloud', dueAt: '2026-06-08T09:00:00Z', resultMessage: 'cloudrunmsg_1', errorCode: null, errorMessage: null, createdAt: '2026-06-08T09:00:00Z', updatedAt: '2026-06-08T09:01:00Z', completedAt: '2026-06-08T09:01:00Z' }] }), { status: 200 });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    if (stringUrl.endsWith('/scheduled-tasks') && !init?.method) return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
    return new Response(JSON.stringify({ task: { taskId: 'task1', title: 'Daily', prompt: 'Do it', schedule: { kind: 'daily', time: '09:00', timezone: 'UTC' }, targetRuntime: 'cloud', enabled: true, status: 'active', nextRunAt: '2026-06-09T09:00:00Z', lastRunAt: null, lastRunStatus: null, lastRunError: null, createdAt: '2026-06-08T09:00:00Z', updatedAt: '2026-06-08T09:00:00Z' } }), { status: 200 });
  };

  await listScheduledTasks({ apiBase: 'https://cloud.example', token: 'tok', fetcher });
  await createScheduledTask({ apiBase: 'https://cloud.example', token: 'tok', fetcher }, { title: 'Daily', prompt: 'Do it', schedule: { kind: 'daily', time: '09:00', timezone: 'UTC' }, targetRuntime: 'cloud', toolPayload: {} });
  await pauseScheduledTask({ apiBase: 'https://cloud.example', token: 'tok', fetcher }, 'task1');
  await resumeScheduledTask({ apiBase: 'https://cloud.example', token: 'tok', fetcher }, 'task1');
  await runScheduledTaskNow({ apiBase: 'https://cloud.example', token: 'tok', fetcher }, 'task1');
  await listScheduledTaskRuns({ apiBase: 'https://cloud.example', token: 'tok', fetcher }, 'task1');
  await deleteScheduledTask({ apiBase: 'https://cloud.example', token: 'tok', fetcher }, 'task1');

  assert.deepEqual(calls.map((call) => call.url), [
    'https://cloud.example/v1/cloud/scheduled-tasks',
    'https://cloud.example/v1/cloud/scheduled-tasks',
    'https://cloud.example/v1/cloud/scheduled-tasks/task1/pause',
    'https://cloud.example/v1/cloud/scheduled-tasks/task1/resume',
    'https://cloud.example/v1/cloud/scheduled-tasks/task1/run-now',
    'https://cloud.example/v1/cloud/scheduled-tasks/task1/runs',
    'https://cloud.example/v1/cloud/scheduled-tasks/task1',
  ]);
  assert.ok(calls.every((call) => (call.init.headers as Record<string, string>).Authorization === 'Bearer tok'));
});
