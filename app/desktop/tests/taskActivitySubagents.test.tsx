import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildTaskActivityDashboard } from '../src/features/chat/taskActivityDashboard';
import type { DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';
import { TaskActivityDashboardPanel } from '../src/pages/TaskActivityDashboardPanel';
import { assistantTurnMessage } from './helpers/taskActivityDashboardFixtures';

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

  assert.equal(dashboard.tasks.length, 1);
  assert.equal(dashboard.tasks[0].title, 'review the code and give me a report');
  assert.equal(dashboard.tasks[0].statusLabel, 'Needs input');
  assert.equal(dashboard.tasks[0].subtasks.length, 2);
  assert.equal(dashboard.tasks[0].subtasks[0].title, 'Inspect');
  assert.equal(dashboard.tasks[0].subtasks[0].statusLabel, 'Done');
  assert.equal(dashboard.tasks[0].subtasks[1].title, 'research_docs');
  assert.equal(dashboard.tasks[0].subtasks[1].statusLabel, 'Done');
  assert.equal(dashboard.tasks[0].subtasks[1].target, '/root/research_docs');
  assert.deepEqual(dashboard.tasks[0].subtasks[1].writeScope, ['docs']);
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
  assert.equal(dashboard.tasks[0].status, 'waiting');
  assert.equal(dashboard.tasks[0].statusLabel, 'Needs input');
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

test('task panel shows model-declared involved participant avatars on task rows', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-target-avatar',
    sessionId: 'session:group:target-avatar',
    prompt: '@Kordi create a task for Kordi User 2',
    status: 'complete',
    message: 'Complete',
    assistantText: 'Opened another test task: “Test Task For User 2”.',
    thinkingText: '',
    completed: true,
    succeeded: true,
    error: null,
    tools: [{
      id: 'task-target-avatar',
      name: 'task_operator',
      status: 'done',
      arguments: JSON.stringify({ taskTitle: 'Test Task For User 2', taskName: 'test_for_user_2', action: 'spawn', involvedParticipants: ['Kordi User 2'] }),
      liveOutput: '',
      resultText: 'Task agent running: /root/test_for_user_2',
      detail: null,
      artifactPath: null,
      toolLayer: 'operator',
      isError: false,
    }],
  };

  const markup = renderToStaticMarkup(createElement(TaskActivityDashboardPanel, {
    messages: [assistantTurnMessage(turn)],
    emptyMessage: 'No tasks',
    targetParticipants: [
      { id: 'human:user-2', name: 'Kordi User 2', kind: 'human', role: 'person', avatarKey: 'kordi-user-2' },
      { id: 'human:user-3', name: 'Kordi User 3', kind: 'human', role: 'person', avatarKey: 'kordi-user-3' },
    ],
  }));

  assert.match(markup, /Kordi User 2 avatar/);
  assert.doesNotMatch(markup, /Kordi User 3 avatar/);
});

test('task panel shows fallback involved participant avatars when canonical participants have not synced yet', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-target-avatar-fallback',
    sessionId: 'session:group:target-avatar',
    prompt: '@Kordi create a task for Kordi User 6',
    status: 'complete',
    message: 'Complete',
    assistantText: 'Created a test task for Kordi User 6.',
    thinkingText: '',
    completed: true,
    succeeded: true,
    error: null,
    tools: [{
      id: 'task-target-avatar-fallback',
      name: 'task_operator',
      status: 'done',
      arguments: JSON.stringify({ action: 'create', taskTitle: 'Test Task For Kordi User 6', involvedParticipants: ['Kordi User 6'] }),
      liveOutput: '',
      resultText: 'Task created: Test Task For Kordi User 6',
      detail: null,
      artifactPath: null,
      toolLayer: 'operator',
      isError: false,
    }],
  };

  const markup = renderToStaticMarkup(createElement(TaskActivityDashboardPanel, {
    messages: [assistantTurnMessage(turn)],
    emptyMessage: 'No tasks',
    targetParticipants: [],
  }));

  assert.match(markup, /Kordi User 6 avatar/);
});

test('task panel uses canonical avatar keys for participant tasks across self and remote views', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-self-avatar',
    sessionId: 'session:group:self-avatar',
    prompt: '@Kordi create a task for me',
    status: 'complete',
    message: 'Complete',
    assistantText: 'Created a test task.',
    thinkingText: '',
    completed: true,
    succeeded: true,
    error: null,
    tools: [{
      id: 'task-self-avatar',
      name: 'task_operator',
      status: 'done',
      arguments: JSON.stringify({ action: 'create', taskTitle: 'New Test Task', involvedParticipants: ['Kordi User 6'] }),
      liveOutput: '',
      resultText: 'Task created: New Test Task',
      detail: null,
      artifactPath: null,
      toolLayer: 'operator',
      isError: false,
    }],
  };

  const selfViewMarkup = renderToStaticMarkup(createElement(TaskActivityDashboardPanel, {
    messages: [assistantTurnMessage(turn)],
    emptyMessage: 'No tasks',
    targetParticipants: [{ id: 'human:self', name: 'Kordi User 6', kind: 'human', role: 'self', avatarKey: 'kh_663f447f166a', avatarSeed: 'local-human-profile:user6' }],
  }));
  const remoteViewMarkup = renderToStaticMarkup(createElement(TaskActivityDashboardPanel, {
    messages: [assistantTurnMessage(turn)],
    emptyMessage: 'No tasks',
    targetParticipants: [{ id: 'human:remote', name: 'Kordi User 6', kind: 'human', role: 'person', avatarKey: 'kh_663f447f166a' }],
  }));

  assert.equal(selfViewMarkup, remoteViewMarkup);
});

test('task panel uses the matched canonical participant avatar instead of a fallback avatar', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-target-avatar-deterministic',
    sessionId: 'session:group:target-avatar',
    prompt: '@Kordi create a task for Kordi User 2',
    status: 'complete',
    message: 'Complete',
    assistantText: 'Created a test task for Kordi User 2.',
    thinkingText: '',
    completed: true,
    succeeded: true,
    error: null,
    tools: [{
      id: 'task-target-avatar-deterministic',
      name: 'task_operator',
      status: 'done',
      arguments: JSON.stringify({ action: 'create', taskTitle: 'Pay The Bill Task 4', involvedParticipants: ['Kordi User 2'] }),
      liveOutput: '',
      resultText: 'Task created: Pay The Bill Task 4',
      detail: null,
      artifactPath: null,
      toolLayer: 'operator',
      isError: false,
    }],
  };

  const withMatchedParticipant = renderToStaticMarkup(createElement(TaskActivityDashboardPanel, {
    messages: [assistantTurnMessage(turn)],
    emptyMessage: 'No tasks',
    targetParticipants: [{
      id: 'human:user-2',
      name: 'Kordi User 2',
      kind: 'human',
      role: 'person',
      avatarKey: 'different-local-key',
      profileImageUrl: 'https://example.test/kordi-user-2.png',
    }],
  }));
  const withFallbackParticipant = renderToStaticMarkup(createElement(TaskActivityDashboardPanel, {
    messages: [assistantTurnMessage(turn)],
    emptyMessage: 'No tasks',
    targetParticipants: [],
  }));

  assert.match(withMatchedParticipant, /kordi-user-2\.png/);
  assert.doesNotMatch(withFallbackParticipant, /kordi-user-2\.png/);
});
