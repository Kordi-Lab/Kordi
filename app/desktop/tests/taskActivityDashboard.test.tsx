import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildTaskActivityDashboard } from '../src/features/chat/taskActivityDashboard';
import type { DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';
import { TaskActivityDashboardPanel } from '../src/pages/TaskActivityDashboardPanel';

function assistantTurnMessage(turn: DesktopChatTurnSnapshot): Message {
  return {
    role: 'owned-agent',
    sender: 'My Kordi',
    text: turn.assistantText,
    time: '10:00',
    turn,
  };
}

test('right-panel task dashboard shows the whole long-running request, not the current bash command', () => {
  const liveTurn: DesktopChatTurnSnapshot = {
    id: 'turn-1',
    sessionId: 'session-1',
    prompt: '@Kordi review the open claw code and give me a report',
    status: 'tooling',
    message: 'Running tool…',
    assistantText: 'I will inspect the code and produce a review report.',
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

  assert.equal(dashboard.tasks.length, 1);
  assert.equal(dashboard.tasks[0].title, 'review the open claw code and give me a report');
  assert.equal(dashboard.tasks[0].status, 'active');
  assert.equal(dashboard.tasks[0].statusLabel, 'Active');
  assert.equal(dashboard.tasks[0].subtasks.length, 0);
  assert.equal(dashboard.activeCount, 1);
});

test('right-panel task dashboard nests subagent tasks under the whole request', () => {
  const historicalTurn: DesktopChatTurnSnapshot = {
    id: 'turn-1',
    sessionId: 'session-1',
    prompt: '@Kordi review the code and give me a report',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'Working on it.',
    thinkingText: '',
    completed: true,
    succeeded: true,
    tools: [
      {
        id: 'plan-1',
        name: 'update_plan',
        status: 'done',
        arguments: '{"plan":[{"step":"Inspect","status":"completed"}]}',
        liveOutput: '',
        resultText: 'Plan updated',
        detail: null,
        artifactPath: null,
        toolLayer: 'planning',
        isError: false,
      },
      {
        id: 'spawn-1',
        name: 'task_operator',
        status: 'done',
        arguments: '{"action":"spawn","taskName":"research_docs","message":"Inspect docs","writeScope":["docs"]}',
        liveOutput: '',
        resultText: 'Task agent running: /root/research_docs',
        detail: null,
        artifactPath: null,
        toolLayer: 'operator',
        isError: false,
      },
    ],
  };

  const liveTurn: DesktopChatTurnSnapshot = {
    id: 'turn-2',
    sessionId: 'session-1',
    prompt: 'run tests',
    status: 'tooling',
    message: 'Running tool…',
    assistantText: '',
    thinkingText: '',
    completed: false,
    succeeded: false,
    tools: [
      {
        id: 'bash-1',
        name: 'bash',
        status: 'running',
        arguments: '{"command":"cargo test -p kordi-cli --lib"}',
        liveOutput: 'running 172 tests',
        resultText: null,
        detail: null,
        artifactPath: null,
        toolLayer: 'execution',
        isError: false,
      },
    ],
  };

  const dashboard = buildTaskActivityDashboard({
    messages: [assistantTurnMessage(historicalTurn)],
    liveTurn,
  });

  assert.equal(dashboard.tasks.length, 2);
  assert.equal(dashboard.tasks[0].title, 'review the code and give me a report');
  assert.equal(dashboard.tasks[0].statusLabel, 'Active');
  assert.equal(dashboard.tasks[0].subtasks.length, 1);
  assert.equal(dashboard.tasks[0].subtasks[0].title, 'research_docs');
  assert.equal(dashboard.tasks[0].subtasks[0].statusLabel, 'Subagent active');
  assert.equal(dashboard.tasks[0].subtasks[0].target, '/root/research_docs');
  assert.deepEqual(dashboard.tasks[0].subtasks[0].writeScope, ['docs']);
  assert.equal(dashboard.tasks[1].title, 'run tests');
  assert.equal(dashboard.tasks[1].subtasks.length, 0);
});

test('task dashboard updates nested subagent state when a later task operator result completes the task', () => {
  const messages: Message[] = [assistantTurnMessage({
    id: 'turn-1',
    sessionId: 'session-1',
    prompt: 'delegate and wait',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: '',
    thinkingText: '',
    completed: true,
    succeeded: true,
    tools: [
      {
        id: 'spawn-1',
        name: 'task_operator',
        status: 'done',
        arguments: '{"action":"spawn","taskName":"research_docs","message":"Inspect docs","writeScope":["docs"]}',
        liveOutput: '',
        resultText: 'Task agent running: /root/research_docs',
        detail: null,
        artifactPath: null,
        toolLayer: 'operator',
        isError: false,
      },
      {
        id: 'wait-1',
        name: 'task_operator',
        status: 'done',
        arguments: '{"action":"wait","timeoutMs":1000}',
        liveOutput: '',
        resultText: 'Task completed: /root/research_docs',
        detail: null,
        artifactPath: null,
        toolLayer: 'operator',
        isError: false,
      },
    ],
  })];

  const dashboard = buildTaskActivityDashboard({ messages });

  assert.equal(dashboard.tasks.length, 1);
  assert.equal(dashboard.tasks[0].status, 'completed');
  assert.equal(dashboard.tasks[0].statusLabel, 'Done');
  assert.equal(dashboard.tasks[0].subtasks.length, 1);
  assert.equal(dashboard.tasks[0].subtasks[0].status, 'completed');
  assert.equal(dashboard.tasks[0].subtasks[0].statusLabel, 'Done');
  assert.equal(dashboard.activeCount, 0);
});

test('task dashboard nests manifest tasks under the whole request before subagents are spawned', () => {
  const messages: Message[] = [assistantTurnMessage({
    id: 'turn-1',
    sessionId: 'session-1',
    prompt: 'plan tasks',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: '',
    thinkingText: '',
    completed: true,
    succeeded: true,
    tools: [
      {
        id: 'manifest-1',
        name: 'task_operator',
        status: 'done',
        arguments: JSON.stringify({
          action: 'manifest',
          tasks: [
            {
              taskId: 'inspect_ui',
              title: 'Inspect task UI',
              summary: 'Review the task panel layout and copy.',
              dependencies: [],
              writeScope: [],
              risk: 'read_only',
              estimatedInputTokens: 1000,
              estimatedOutputTokens: 300,
            },
          ],
        }),
        liveOutput: '',
        resultText: 'Task manifest accepted: task_manifest_123',
        detail: null,
        artifactPath: null,
        toolLayer: 'operator',
        isError: false,
      },
    ],
  })];

  const dashboard = buildTaskActivityDashboard({ messages });

  assert.equal(dashboard.tasks.length, 1);
  assert.equal(dashboard.tasks[0].title, 'plan tasks');
  assert.equal(dashboard.tasks[0].statusLabel, 'Planned');
  assert.equal(dashboard.tasks[0].subtasks.length, 1);
  assert.equal(dashboard.tasks[0].subtasks[0].title, 'Inspect task UI');
  assert.equal(dashboard.tasks[0].subtasks[0].summary, 'Review the task panel layout and copy.');
  assert.equal(dashboard.tasks[0].subtasks[0].statusLabel, 'Planned');
});

test('task panel renders the whole task as an expandable row for subtasks', () => {
  const messages: Message[] = [assistantTurnMessage({
    id: 'turn-1',
    sessionId: 'session-1',
    prompt: '@Kordi review code',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: '',
    thinkingText: '',
    completed: true,
    succeeded: true,
    tools: [
      {
        id: 'spawn-1',
        name: 'task_operator',
        status: 'done',
        arguments: '{"action":"spawn","taskName":"research_docs","message":"Inspect docs"}',
        liveOutput: '',
        resultText: 'Task agent running: /root/research_docs',
        detail: null,
        artifactPath: null,
        toolLayer: 'operator',
        isError: false,
      },
    ],
  })];

  const markup = renderToStaticMarkup(createElement(TaskActivityDashboardPanel, {
    messages,
    liveTurn: null,
    emptyMessage: 'No tasks',
  }));

  assert.match(markup, /<details/);
  assert.match(markup, /review code/);
  assert.match(markup, /1 active subtask/);
  assert.match(markup, /research_docs/);
});
