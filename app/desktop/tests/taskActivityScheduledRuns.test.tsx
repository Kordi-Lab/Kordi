import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DesktopChatTurnSnapshot } from '../src/kordi-app/types';
import { TaskActivityDashboardPanel } from '../src/pages/TaskActivityDashboardPanel';

test('scheduled task rows only include tasks for the active session', () => {
  const markup = renderToStaticMarkup(createElement(TaskActivityDashboardPanel, {
    messages: [],
    liveTurn: null,
    emptyMessage: 'No tasks',
    currentSessionId: 'session-weather',
    scheduledTasks: [{
      taskId: 'scheduled_task_openai',
      sessionId: 'session-openai',
      title: 'Summarize latest OpenAI news',
      prompt: 'Search the web for OpenAI news.',
      schedule: { kind: 'daily', time: '20:16', timezone: 'UTC+8' },
      targetRuntime: 'cloud',
      enabled: true,
      status: 'active',
      nextRunAt: '2026-06-10T12:16:00Z',
      lastRunAt: '2026-06-09T12:16:00Z',
      lastRunStatus: 'completed',
      lastRunError: null,
      createdAt: '2026-06-09T12:15:00Z',
      updatedAt: '2026-06-09T12:17:08Z',
    }, {
      taskId: 'scheduled_task_weather',
      sessionId: 'session-weather',
      title: 'Tell me Xuzhou weather every 5 min',
      prompt: 'Tell me Xuzhou weather.',
      schedule: { kind: 'daily', time: '20:20', timezone: 'UTC+8' },
      targetRuntime: 'cloud',
      enabled: true,
      status: 'active',
      nextRunAt: '2026-06-10T12:20:00Z',
      lastRunAt: null,
      lastRunStatus: null,
      lastRunError: null,
      createdAt: '2026-06-09T12:19:00Z',
      updatedAt: '2026-06-09T12:19:00Z',
    }],
    now: new Date('2026-06-09T12:20:00Z'),
  }));

  assert.match(markup, /Tell me Xuzhou weather every 5 min/);
  assert.doesNotMatch(markup, /Summarize latest OpenAI news/);
});

test('scheduled task rows keep distinct tasks that share the same title', () => {
  const sharedTask = {
    sessionId: 'session-dinner',
    title: 'Dinner reminder',
    prompt: 'Remind us about dinner.',
    schedule: { kind: 'once' as const, at: '2026-06-09T12:20:00Z' },
    targetRuntime: 'cloud' as const,
    enabled: true,
    status: 'active',
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    createdAt: '2026-06-09T12:19:00Z',
  };
  const markup = renderToStaticMarkup(createElement(TaskActivityDashboardPanel, {
    messages: [],
    liveTurn: null,
    emptyMessage: 'No tasks',
    currentSessionId: 'session-dinner',
    scheduledTasks: [{
      ...sharedTask,
      taskId: 'scheduled_task_first',
      updatedAt: '2026-06-09T12:19:00Z',
    }, {
      ...sharedTask,
      taskId: 'scheduled_task_second',
      updatedAt: '2026-06-09T12:21:00Z',
    }],
    now: new Date('2026-06-09T12:22:00Z'),
  }));

  assert.equal((markup.match(/Dinner reminder/g) ?? []).length, 2);
});

test('scheduled task rows expand one row per run with status and response previews', () => {
  const markup = renderToStaticMarkup(createElement(TaskActivityDashboardPanel, {
    messages: [{
      id: 'msg:cloud:self:cloudrunmsg_news',
      role: 'owned-agent',
      sender: 'My Kordi',
      senderType: 'agent',
      isOwnMessage: false,
      showSenderMeta: true,
      text: '',
      time: '20:17',
      turn: {
        id: 'turn-news',
        sessionId: 'session-news',
        prompt: '',
        status: 'complete',
        message: 'Complete',
        assistantText: 'As of Tuesday, June 9, 2026, the latest notable OpenAI updates include IPO paperwork and research exchange news.',
        thinkingText: '',
        tools: [],
        completed: true,
        succeeded: true,
        error: null,
      },
    }],
    liveTurn: null,
    emptyMessage: 'No tasks',
    scheduledTasks: [{
      taskId: 'scheduled_task_news',
      title: 'Search latest OpenAI news',
      prompt: 'Search the web for OpenAI news.',
      schedule: { kind: 'daily', time: '20:16', timezone: 'UTC+8' },
      targetRuntime: 'cloud',
      enabled: true,
      status: 'active',
      nextRunAt: '2026-06-10T12:16:00Z',
      lastRunAt: '2026-06-09T12:16:00Z',
      lastRunStatus: 'completed',
      lastRunError: null,
      createdAt: '2026-06-09T12:15:00Z',
      updatedAt: '2026-06-09T12:17:08Z',
    }],
    scheduledRunsByTaskId: {
      scheduled_task_news: [{
        runId: 'scheduled_run_news',
        taskId: 'scheduled_task_news',
        status: 'completed',
        targetRuntime: 'cloud',
        dueAt: '2026-06-09T12:16:00Z',
        resultMessage: 'cloudrunmsg_news',
        errorCode: null,
        errorMessage: null,
        createdAt: '2026-06-09T12:16:02Z',
        updatedAt: '2026-06-09T12:17:08Z',
        completedAt: '2026-06-09T12:17:08Z',
      }],
    },
    now: new Date('2026-06-09T12:18:00Z'),
  }));

  assert.match(markup, /Search latest OpenAI news/);
  assert.match(markup, /1 run/);
  assert.doesNotMatch(markup, /2 subtasks/);
  assert.doesNotMatch(markup, /Latest run status/);
  assert.match(markup, /completed · 1m 06s/);
  assert.doesNotMatch(markup, /completed · 1m 06s · completed/);
  assert.match(markup, /As of Tuesday, June 9, 2026, the latest notable OpenAI updates/);
  assert.equal((markup.match(/data-scheduled-run-output="true"/g) ?? []).length, 1);
});

test('task panel lets long task titles wrap instead of truncating them', () => {
  const liveTurn: DesktopChatTurnSnapshot = {
    id: 'turn-1',
    sessionId: 'session-1',
    prompt: '@Kordi create a task to review the change log and related blog of open source release notes',
    status: 'tooling',
    message: 'Creating task…',
    assistantText: '',
    thinkingText: '',
    completed: false,
    succeeded: false,
    tools: [{
      id: 'task-create-long-title',
      name: 'task_operator',
      status: 'running',
      arguments: '{"action":"create","taskId":"task_long_title","taskTitle":"review the change log and related blog of open source release notes"}',
      liveOutput: '',
      resultText: null,
      detail: null,
      artifactPath: null,
      toolLayer: 'operator',
      isError: false,
    }],
  };

  const markup = renderToStaticMarkup(createElement(TaskActivityDashboardPanel, {
    messages: [],
    liveTurn,
    emptyMessage: 'No tasks',
  }));

  assert.match(markup, /review the change log and related blog/);
  assert.doesNotMatch(markup, /app-inspector-heading truncate/);
});
