import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildTaskActivityDashboard } from '../src/features/chat/taskActivityDashboard';
import type { DesktopChatTurnSnapshot } from '../src/kordi-app/types';
import { TaskActivityDashboardPanel } from '../src/pages/TaskActivityDashboardPanel';

test('right-panel task dashboard renders scheduled jobs as normal task rows', () => {
  const markup = renderToStaticMarkup(createElement(TaskActivityDashboardPanel, {
    messages: [],
    emptyMessage: 'No tasks',
    now: new Date('2026-06-09T08:00:00Z'),
    timeZone: 'UTC',
    scheduledTasks: [{
      taskId: 'scheduled_task_disk',
      title: 'Check disk usage',
      prompt: 'Check local disk usage and save the result.',
      schedule: { kind: 'once', at: '2026-06-09T12:00:00Z' },
      targetRuntime: 'local_required',
      enabled: true,
      status: 'active',
      nextRunAt: '2026-06-09T12:00:00Z',
      lastRunAt: null,
      lastRunStatus: 'waiting_for_desktop',
      lastRunError: null,
      createdAt: '2026-06-09T08:00:00Z',
      updatedAt: '2026-06-09T08:00:00Z',
    }],
  }));

  assert.match(markup, /Check disk usage/);
  assert.match(markup, /Today 12:00 · Requires Desktop/);
  assert.match(markup, /Waiting for Desktop/);
  assert.doesNotMatch(markup, /Scheduled tools/);
});

test('right-panel scheduled cloud task rows hide the Cloud runtime label', () => {
  const markup = renderToStaticMarkup(createElement(TaskActivityDashboardPanel, {
    messages: [],
    emptyMessage: 'No tasks',
    now: new Date('2026-06-09T08:00:00Z'),
    timeZone: 'UTC',
    scheduledTasks: [{
      taskId: 'scheduled_task_brief',
      title: 'Prepare morning brief',
      prompt: 'Summarize overnight updates.',
      schedule: { kind: 'once', at: '2026-06-09T09:00:00Z' },
      targetRuntime: 'cloud',
      enabled: true,
      status: 'active',
      nextRunAt: '2026-06-09T09:00:00Z',
      lastRunAt: null,
      lastRunStatus: null,
      lastRunError: null,
      createdAt: '2026-06-09T08:00:00Z',
      updatedAt: '2026-06-09T08:00:00Z',
    }],
  }));

  assert.match(markup, /Prepare morning brief/);
  assert.match(markup, /Today 09:00/);
  assert.doesNotMatch(markup, /Today 09:00 · Cloud/);
});

test('right-panel Cloud task rows show stable task id instead of repeating the title', () => {
  const markup = renderToStaticMarkup(createElement(TaskActivityDashboardPanel, {
    messages: [],
    emptyMessage: 'No tasks',
    taskActivities: [
      {
        id: 'cloud-task:session:group:one:another_test_task',
        sessionId: 'session:group:one',
        status: 'active',
        initiator: { id: 'cloud:acct_a', name: 'Research Agent', kind: 'human', role: 'person', avatarKey: 'acct_a' },
        target: { id: 'task:another_test_task', name: 'Another Test Task', kind: 'agent', role: 'external-agent', avatarKey: 'acct_a' },
        participants: [],
        createdAtMs: 1,
        updatedAtMs: 1,
        sourceRequestId: 'another_test_task',
        contextPolicy: 'cloud-session-activity',
        error: null,
      },
    ],
  }));

  assert.match(markup, /Another Test Task/);
  assert.match(markup, /ID:\s*another_test_task/);
  assert.equal((markup.match(/Another Test Task/g) ?? []).length, 1);
});

test('right-panel task dashboard does not create a task row for an ordinary live question', () => {
  const liveTurn: DesktopChatTurnSnapshot = {
    id: 'turn-1',
    sessionId: 'session-1',
    prompt: '@Kordi why did this happen?',
    status: 'tooling',
    message: 'Running tool…',
    assistantText: 'I will inspect the context.',
    thinkingText: '',
    completed: false,
    succeeded: false,
    tools: [
      {
        id: 'bash-1',
        name: 'bash',
        status: 'running',
        arguments: '{"command":"pwd && git status --short"}',
        liveOutput: 'running',
        resultText: null,
        detail: null,
        artifactPath: null,
        toolLayer: 'execution',
        isError: false,
      },
    ],
  };

  const dashboard = buildTaskActivityDashboard({ messages: [], liveTurn });

  assert.equal(dashboard.tasks.length, 0);
  assert.equal(dashboard.hasActivity, false);
});

test('right-panel task dashboard ignores Cloud context-wrapper task searches with object arguments', () => {
  const liveTurn: DesktopChatTurnSnapshot = {
    id: 'turn-cloud-search',
    sessionId: 'cloud-agent:acct_a:acct_b',
    prompt: 'Use the shared Cloud conversation below as the single context window for both the humans and their Kordi agents.\n\nCurrent request from Research Agent: which tasks are finished?',
    status: 'tooling',
    message: 'Processing…',
    assistantText: '',
    thinkingText: '',
    completed: false,
    succeeded: false,
    tools: [
      {
        id: 'tool-search',
        name: 'task_operator',
        status: 'running',
        arguments: { action: 'search', status: 'closed' } as never,
        liveOutput: '',
        resultText: null,
        detail: null,
        artifactPath: null,
        toolLayer: 'operator',
        isError: false,
      },
    ],
  };

  const dashboard = buildTaskActivityDashboard({ messages: [], liveTurn });

  assert.equal(dashboard.tasks.length, 0);
});
