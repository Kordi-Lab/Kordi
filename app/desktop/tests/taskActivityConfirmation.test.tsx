import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildTaskActivityDashboard } from '../src/features/chat/taskActivityDashboard';
import type { DesktopChatTurnSnapshot } from '../src/kordi-app/types';
import { TaskActivityDashboardPanel } from '../src/pages/TaskActivityDashboardPanel';
import { assistantTurnMessage, userMessage } from './helpers/taskActivityDashboardFixtures';

test('task dashboard keeps completed plan tasks open until human confirmation', () => {
  const completedTurn: DesktopChatTurnSnapshot = {
    id: 'turn-waiting-confirmation',
    sessionId: 'session-1',
    prompt: '@Kordi implement the shortcut issue',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'The implementation is complete. Please review it.',
    thinkingText: '',
    completed: true,
    succeeded: true,
    tools: [
      {
        id: 'plan-1',
        name: 'update_plan',
        status: 'done',
        arguments: JSON.stringify({
          taskTitle: 'Review and implement shortcut',
          plan: [
            { step: 'Review issue requirements', status: 'completed' },
            { step: 'Implement shortcut', status: 'completed' },
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

  const dashboard = buildTaskActivityDashboard({ messages: [assistantTurnMessage(completedTurn)] });

  assert.equal(dashboard.tasks.length, 1);
  assert.equal(dashboard.tasks[0].status, 'waiting');
  assert.equal(dashboard.tasks[0].statusLabel, 'Needs input');
  assert.equal(dashboard.tasks[0].subtasks.length, 2);
  assert.equal(dashboard.tasks[0].subtasks[0].status, 'completed');
});

test('task dashboard marks the parent done only after human confirmation', () => {
  const completedTurn: DesktopChatTurnSnapshot = {
    id: 'turn-human-confirmed',
    sessionId: 'session-1',
    prompt: '@Kordi implement the shortcut issue',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'The implementation is complete. Please review it.',
    thinkingText: '',
    completed: true,
    succeeded: true,
    tools: [
      {
        id: 'plan-1',
        name: 'update_plan',
        status: 'done',
        arguments: JSON.stringify({
          taskTitle: 'Review and implement shortcut',
          plan: [
            { step: 'Review issue requirements', status: 'completed' },
            { step: 'Implement shortcut', status: 'completed' },
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

  const dashboard = buildTaskActivityDashboard({ messages: [
    assistantTurnMessage(completedTurn),
    userMessage('yes, this is finished', 'user-confirmed'),
  ] });

  assert.equal(dashboard.tasks.length, 1);
  assert.equal(dashboard.tasks[0].status, 'completed');
  assert.equal(dashboard.tasks[0].statusLabel, 'Done');
});

test('task dashboard shows failed tools as subtasks without failing the parent task', () => {
  const failedToolTurn: DesktopChatTurnSnapshot = {
    id: 'turn-failed-tool-subtask',
    sessionId: 'session-1',
    prompt: '@Kordi implement the shortcut issue',
    status: 'failed',
    message: '1 tool failed',
    assistantText: 'I hit a tool error while checking the issue.',
    thinkingText: '',
    completed: true,
    succeeded: false,
    tools: [
      {
        id: 'plan-1',
        name: 'update_plan',
        status: 'done',
        arguments: JSON.stringify({ taskTitle: 'Review and implement shortcut', plan: [] }),
        liveOutput: '',
        resultText: 'Plan updated',
        detail: null,
        artifactPath: null,
        toolLayer: 'planning',
        isError: false,
      },
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
    ],
  };

  const dashboard = buildTaskActivityDashboard({ messages: [assistantTurnMessage(failedToolTurn)] });

  assert.equal(dashboard.tasks.length, 1);
  assert.equal(dashboard.tasks[0].status, 'active');
  assert.equal(dashboard.tasks[0].statusLabel, 'Active');
  assert.equal(dashboard.tasks[0].subtasks.length, 1);
  assert.equal(dashboard.tasks[0].subtasks[0].status, 'failed');
  assert.match(dashboard.tasks[0].subtasks[0].title, /read/i);
});

test('task panel labels waiting failed-turn time as last activity instead of failed', () => {
  const waitingTurn: DesktopChatTurnSnapshot = {
    id: 'turn-waiting-after-recovered-failure',
    sessionId: 'session-1',
    prompt: '@Kordi implement the shortcut issue',
    status: 'failed',
    message: 'Response complete',
    assistantText: 'I need input before continuing.',
    thinkingText: '',
    completed: true,
    succeeded: false,
    tools: [
      {
        id: 'plan-1',
        name: 'update_plan',
        status: 'done',
        arguments: JSON.stringify({
          taskTitle: 'Review and implement shortcut',
          plan: [{ step: 'Fix shortcut', status: 'completed' }],
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

  const markup = renderToStaticMarkup(createElement(TaskActivityDashboardPanel, {
    messages: [assistantTurnMessage(waitingTurn)],
    liveTurn: null,
    emptyMessage: 'No tasks',
  }));

  assert.match(markup, /Awaiting human input/);
  assert.match(markup, /Last activity 10:00/);
  assert.doesNotMatch(markup, /Failed 10:00/);
});

test('task dashboard clears a failed tool issue after a later same-tool retry succeeds', () => {
  const retriedTurn: DesktopChatTurnSnapshot = {
    id: 'turn-retried-tool-subtask',
    sessionId: 'session-1',
    prompt: '@Kordi run the project tests',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'The correct test command passed after the first command failed.',
    thinkingText: '',
    completed: true,
    succeeded: true,
    tools: [
      {
        id: 'plan-1',
        name: 'update_plan',
        status: 'done',
        arguments: JSON.stringify({ taskTitle: 'Run project tests', plan: [] }),
        liveOutput: '',
        resultText: 'Plan updated',
        detail: null,
        artifactPath: null,
        toolLayer: 'planning',
        isError: false,
      },
      {
        id: 'bash-failed',
        name: 'bash',
        status: 'error',
        arguments: JSON.stringify({ command: 'npm test' }),
        liveOutput: '',
        resultText: 'npm error Missing script: "test"',
        detail: null,
        artifactPath: null,
        toolLayer: 'execution',
        isError: true,
      },
      {
        id: 'bash-retry',
        name: 'bash',
        status: 'done',
        arguments: JSON.stringify({ command: 'pnpm --dir app/desktop test:unit' }),
        liveOutput: '',
        resultText: '407 tests passed',
        detail: null,
        artifactPath: null,
        toolLayer: 'execution',
        isError: false,
      },
    ],
  };

  const dashboard = buildTaskActivityDashboard({ messages: [assistantTurnMessage(retriedTurn)] });

  assert.equal(dashboard.tasks.length, 1);
  assert.equal(dashboard.tasks[0].status, 'waiting');
  assert.equal(dashboard.tasks[0].subtasks.some((subtask) => subtask.status === 'failed'), false);
  assert.doesNotMatch(dashboard.tasks[0].summary, /failed/i);
});

test('task dashboard keeps completed titled tasks visible after the live turn finishes', () => {
  const completedTurn: DesktopChatTurnSnapshot = {
    id: 'turn-1',
    sessionId: 'session-1',
    prompt: '@Kordi please do a detailed review of the open claw code and give me a report when done',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'Done.',
    thinkingText: '',
    completed: true,
    succeeded: true,
    tools: [
      {
        id: 'plan-1',
        name: 'update_plan',
        status: 'done',
        arguments: '{"taskTitle":"Review Open Claw Code","plan":[{"step":"Inspect code","status":"completed"}]}',
        liveOutput: '',
        resultText: 'Plan updated',
        detail: null,
        artifactPath: null,
        toolLayer: 'planning',
        isError: false,
      },
    ],
  };

  const dashboard = buildTaskActivityDashboard({ messages: [assistantTurnMessage(completedTurn)] });

  assert.equal(dashboard.tasks.length, 1);
  assert.equal(dashboard.tasks[0].title, 'Review Open Claw Code');
  assert.equal(dashboard.tasks[0].status, 'waiting');
  assert.equal(dashboard.tasks[0].statusLabel, 'Needs input');
});
