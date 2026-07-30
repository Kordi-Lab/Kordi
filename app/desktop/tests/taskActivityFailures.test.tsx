import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildTaskActivityDashboard } from '../src/features/chat/taskActivityDashboard';
import { mapDesktopMessagesForTranscript } from '../src/features/chat/useDesktopTranscriptAdapter';
import type { DesktopChatMessage, DesktopChatTurnSnapshot } from '../src/kordi-app/types';
import { TaskActivityDashboardPanel } from '../src/pages/TaskActivityDashboardPanel';
import { assistantTurnMessage } from './helpers/taskActivityDashboardFixtures';

test('task dashboard does not fail the whole task when a completed response contains one failed tool', () => {
  const transcriptMessages = mapDesktopMessagesForTranscript('session-1', [{
    role: 'assistant',
    sender: 'Kordi',
    text: 'I recovered and completed the requested review.',
    timeLabel: '22:33',
    timestampMs: 88_800_000,
    failed: false,
    thinkingText: 'I will retry after the read failed.',
    tools: [
      {
        id: 'read-1',
        name: 'read',
        status: 'error',
        arguments: JSON.stringify({ path: 'missing.md' }),
        liveOutput: '',
        resultText: 'File not found',
        detail: null,
        artifactPath: null,
        toolLayer: 'observation',
        isError: true,
      },
      {
        id: 'plan-1',
        name: 'update_plan',
        status: 'done',
        arguments: JSON.stringify({ taskTitle: 'Review Project Files', plan: [] }),
        liveOutput: '',
        resultText: 'Plan updated',
        detail: null,
        artifactPath: null,
        toolLayer: 'planning',
        isError: false,
      },
    ],
  } satisfies DesktopChatMessage]);

  const dashboard = buildTaskActivityDashboard({ messages: transcriptMessages });

  assert.equal(dashboard.tasks[0].status, 'active');
  assert.equal(dashboard.tasks[0].timeLabel, '22:33');
  assert.equal(dashboard.tasks[0].subtasks.length, 1);
  assert.equal(dashboard.tasks[0].subtasks[0].status, 'failed');
  assert.equal(dashboard.completedCount, 0);

  const markup = renderToStaticMarkup(createElement(TaskActivityDashboardPanel, {
    messages: transcriptMessages,
    liveTurn: null,
    emptyMessage: 'No tasks',
  }));

  assert.match(markup, /22:33/);
  assert.doesNotMatch(markup, /Failed 22:33/);
});

test('task dashboard merges duplicate top-level rows for the same generated task title', () => {
  const completedTurn: DesktopChatTurnSnapshot = {
    id: 'turn-audit-complete',
    sessionId: 'session-1',
    prompt: '@Kordi run a full project audit',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'I started the audit and will continue checking files.',
    thinkingText: '',
    completed: true,
    succeeded: true,
    tools: [
      {
        id: 'plan-audit-complete',
        name: 'update_plan',
        status: 'done',
        arguments: JSON.stringify({ taskTitle: 'Kordi full project audit', plan: [] }),
        liveOutput: '',
        resultText: 'Plan updated',
        detail: null,
        artifactPath: null,
        toolLayer: 'planning',
        isError: false,
      },
    ],
  };
  const liveTurn: DesktopChatTurnSnapshot = {
    id: 'turn-audit-live',
    sessionId: 'session-1',
    prompt: '@Kordi run a full project audit',
    status: 'tooling',
    message: 'Running tool…',
    assistantText: '',
    thinkingText: '',
    completed: false,
    succeeded: false,
    startedAtMs: 1_000,
    tools: [
      {
        id: 'plan-audit-live',
        name: 'update_plan',
        status: 'done',
        arguments: JSON.stringify({ taskTitle: 'Kordi full project audit', plan: [] }),
        liveOutput: '',
        resultText: 'Plan updated',
        detail: null,
        artifactPath: null,
        toolLayer: 'planning',
        isError: false,
      },
      {
        id: 'bash-audit-live',
        name: 'bash',
        status: 'running',
        arguments: JSON.stringify({ command: 'pnpm test' }),
        liveOutput: 'running tests',
        resultText: null,
        detail: null,
        artifactPath: null,
        toolLayer: 'execution',
        isError: false,
      },
    ],
  };

  const dashboard = buildTaskActivityDashboard({
    messages: [assistantTurnMessage(completedTurn)],
    liveTurn,
  });

  assert.equal(dashboard.tasks.length, 1);
  assert.equal(dashboard.tasks[0].title, 'Kordi full project audit');
  assert.equal(dashboard.tasks[0].status, 'active');
  assert.equal(dashboard.tasks[0].responseMessageId, 'turn-audit-live');
  assert.equal(dashboard.activeCount, 1);

  const markup = renderToStaticMarkup(createElement(TaskActivityDashboardPanel, {
    messages: [assistantTurnMessage(completedTurn)],
    liveTurn,
    emptyMessage: 'No tasks',
  }));

  assert.equal(markup.match(/Kordi full project audit/g)?.length, 1);
});

test('task panel omits the repeated Tasks heading inside the Tasks tab', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-no-heading',
    sessionId: 'session-1',
    prompt: '@Kordi write a website options report',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'Created the requested report.',
    thinkingText: '',
    completed: true,
    succeeded: true,
    tools: [
      {
        id: 'plan-no-heading',
        name: 'update_plan',
        status: 'done',
        arguments: JSON.stringify({ taskTitle: 'Website Options Report', plan: [] }),
        liveOutput: '',
        resultText: 'Plan updated',
        detail: null,
        artifactPath: null,
        toolLayer: 'planning',
        isError: false,
      },
    ],
  };

  const markup = renderToStaticMarkup(createElement(TaskActivityDashboardPanel, {
    messages: [assistantTurnMessage(turn)],
    liveTurn: null,
    emptyMessage: 'No tasks',
  }));

  assert.doesNotMatch(markup, /app-detail-kicker[^>]*>Tasks</);
  assert.match(markup, /Website Options Report/);
});

test('task panel renders completed task time without status or duration clutter', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-duration',
    sessionId: 'session-1',
    prompt: '@Kordi write a website options report',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'Created the requested report.',
    thinkingText: '',
    completed: true,
    succeeded: true,
    startedAtMs: 1_000,
    completedAtMs: 76_500,
    tools: [
      {
        id: 'plan-duration',
        name: 'update_plan',
        status: 'done',
        arguments: JSON.stringify({ taskTitle: 'Website Options Report', plan: [] }),
        liveOutput: '',
        resultText: 'Plan updated',
        detail: null,
        artifactPath: null,
        toolLayer: 'planning',
        isError: false,
      },
    ],
  };

  const markup = renderToStaticMarkup(createElement(TaskActivityDashboardPanel, {
    messages: [assistantTurnMessage(turn)],
    liveTurn: null,
    emptyMessage: 'No tasks',
  }));

  assert.match(markup, /10:00/);
  assert.doesNotMatch(markup, /Completed 10:00/);
  assert.doesNotMatch(markup, /Response complete/);
  assert.doesNotMatch(markup, /1m 15s/);
});

test('task dashboard names completed artifact tasks when historical prompts are unavailable', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-report',
    sessionId: 'session-1',
    prompt: '',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'Created the requested report.',
    thinkingText: '',
    completed: true,
    succeeded: true,
    tools: [
      {
        id: 'write-report',
        name: 'write',
        status: 'done',
        arguments: JSON.stringify({ path: 'docs/reports/kordi-project-structure-report.md' }),
        liveOutput: '',
        resultText: 'wrote report',
        detail: null,
        artifactPath: null,
        toolLayer: 'execution',
        isError: false,
      },
    ],
  };

  const dashboard = buildTaskActivityDashboard({ messages: [assistantTurnMessage(turn)] });

  assert.equal(dashboard.tasks.length, 1);
  assert.equal(dashboard.tasks[0].title, 'Kordi Project Structure Report');
});

test('task dashboard derives a concise task title from plan steps when taskTitle is missing', () => {
  const liveTurn: DesktopChatTurnSnapshot = {
    id: 'turn-plan-title',
    sessionId: 'session-1',
    prompt: 'open a issue from here, in the chat you need show the new write and changed files as artifacts',
    status: 'tooling',
    message: 'Working…',
    assistantText: '',
    thinkingText: '',
    completed: false,
    succeeded: false,
    tools: [
      {
        id: 'plan-1',
        name: 'update_plan',
        status: 'done',
        arguments: JSON.stringify({
          plan: [
            { step: 'Open issue for artifact display', status: 'in_progress' },
            { step: 'Add artifact regression coverage', status: 'pending' },
          ],
        }),
        liveOutput: '',
        resultText: 'Plan updated',
        detail: null,
        artifactPath: null,
        toolLayer: 'planning',
        isError: false,
      },
    ],
  };

  const dashboard = buildTaskActivityDashboard({ messages: [], liveTurn });

  assert.equal(dashboard.tasks.length, 1);
  assert.equal(dashboard.tasks[0].title, 'Open issue for artifact display');
});

test('task dashboard does not create rows for failed non-task tool turns', () => {
  const completedTurn: DesktopChatTurnSnapshot = {
    id: 'turn-failed-worktree',
    sessionId: 'session-1',
    prompt: "let’s fix the prolem in a new worktree",
    status: 'failed',
    message: '1 tool failed',
    assistantText: "I'm using the using-git-worktrees skill to set up an isolated workspace.",
    thinkingText: '',
    completed: true,
    succeeded: false,
    tools: [
      {
        id: 'bash-1',
        name: 'bash',
        status: 'error',
        arguments: JSON.stringify({ command: 'git worktree add /tmp/example -b fix/example' }),
        liveOutput: '',
        resultText: 'fatal: invalid reference',
        detail: null,
        artifactPath: null,
        toolLayer: 'execution',
        isError: true,
      },
    ],
  };

  const dashboard = buildTaskActivityDashboard({ messages: [assistantTurnMessage(completedTurn)] });

  assert.equal(dashboard.tasks.length, 0);
  assert.equal(dashboard.hasActivity, false);
});
