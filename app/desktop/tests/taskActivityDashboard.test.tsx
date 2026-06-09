import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildTaskActivityDashboard } from '../src/features/chat/taskActivityDashboard';
import { mapDesktopMessagesForTranscript } from '../src/features/chat/useDesktopTranscriptAdapter';
import type { DesktopChatMessage, DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';
import { TaskActivityDashboardPanel } from '../src/pages/TaskActivityDashboardPanel';

function assistantTurnMessage(turn: DesktopChatTurnSnapshot): Message {
  return {
    id: `message:${turn.id}`,
    role: 'owned-agent',
    sender: 'My Kordi',
    text: turn.assistantText,
    time: '10:00',
    turn,
  };
}

function userMessage(text: string, id = `user:${text.slice(0, 16)}`): Message {
  return {
    id,
    role: 'user',
    sender: 'Me',
    text,
    time: '10:01',
  };
}

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

test('right-panel Cloud task rows show stable task id instead of repeating the title', () => {
  const markup = renderToStaticMarkup(createElement(TaskActivityDashboardPanel, {
    messages: [],
    emptyMessage: 'No tasks',
    taskActivities: [
      {
        id: 'cloud-task:session:group:one:another_test_task',
        sessionId: 'session:group:one',
        status: 'active',
        initiator: { id: 'cloud:acct_a', name: 'C UFishAI', kind: 'human', role: 'person', avatarKey: 'acct_a' },
        target: { id: 'task:another_test_task', name: 'Another Test Task', kind: 'agent', role: 'external-agent', avatarKey: 'acct_a' },
        participants: [],
        createdAtMs: 1,
        updatedAtMs: 1,
        bridgeRequestId: 'another_test_task',
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
    prompt: 'Use the shared Cloud conversation below as the single context window for both the humans and their Kordi agents.\n\nCurrent request from C UFishAI: which tasks are finished?',
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

test('task dashboard creates and closes durable task_operator task events by task id', () => {
  const createTurn: DesktopChatTurnSnapshot = {
    id: 'turn-create',
    sessionId: 'session-1',
    prompt: '@KordiUser2sKordi create a task for your owner',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'Created a test task for Kordi User 2.',
    thinkingText: '',
    completed: true,
    succeeded: true,
    tools: [{
      id: 'create-1',
      name: 'task_operator',
      status: 'done',
      arguments: '{"action":"create","taskId":"task_user_2","taskTitle":"Test Task For Kordi User 2","summary":"Verify task visibility across the group.","involvedParticipants":["Kordi User 2"]}',
      liveOutput: '',
      resultText: 'Task created: Test Task For Kordi User 2',
      detail: null,
      artifactPath: null,
      toolLayer: 'operator',
      isError: false,
    }],
  };
  const closeTurn: DesktopChatTurnSnapshot = {
    id: 'turn-close',
    sessionId: 'session-1',
    prompt: '@KordiUser2sKordi close the task',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'Closed the test task for Kordi User 2.',
    thinkingText: '',
    completed: true,
    succeeded: true,
    tools: [{
      id: 'close-1',
      name: 'task_operator',
      status: 'done',
      arguments: '{"action":"close","taskId":"task_user_2","taskTitle":"Test Task For Kordi User 2"}',
      liveOutput: '',
      resultText: 'Task closed: Test Task For Kordi User 2',
      detail: null,
      artifactPath: null,
      toolLayer: 'operator',
      isError: false,
    }],
  };

  const dashboard = buildTaskActivityDashboard({
    messages: [assistantTurnMessage(createTurn), assistantTurnMessage(closeTurn)],
  });

  assert.equal(dashboard.tasks.length, 1);
  assert.equal(dashboard.tasks[0].title, 'Test Task For Kordi User 2');
  assert.equal(dashboard.tasks[0].status, 'closed');
  assert.equal(dashboard.tasks[0].statusLabel, 'Closed');
  assert.deepEqual(dashboard.tasks[0].involvedParticipantNames, ['Kordi User 2']);
});

test('task dashboard nests durable task creates with parentTaskId under the existing task', () => {
  const parentTurn: DesktopChatTurnSnapshot = {
    id: 'turn-create-parent-task',
    sessionId: 'session-group-1',
    prompt: '@Kordi create a task',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'Created a new task: **New Test Task**',
    thinkingText: '',
    completed: true,
    succeeded: true,
    tools: [{
      id: 'create-parent-task',
      name: 'task_operator',
      status: 'done',
      arguments: JSON.stringify({
        action: 'create',
        taskId: '',
        taskTitle: 'New Test Task',
        status: 'open',
        involvedParticipants: ['Kordi User 3', 'Kordi User 2'],
      }),
      liveOutput: '',
      resultText: 'Task created: New Test Task\n\nTasks:\n- ID: `task_parent_123`; title: New Test Task; status: open; summary: New test task.',
      detail: null,
      artifactPath: null,
      toolLayer: 'operator',
      isError: false,
    }],
  };
  const subtaskTurn: DesktopChatTurnSnapshot = {
    id: 'turn-create-child-task',
    sessionId: 'session-group-1',
    prompt: '@Kordi create a subtask for it',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'Created a subtask under **New Test Task**.',
    thinkingText: '',
    completed: true,
    succeeded: true,
    tools: [{
      id: 'create-child-task',
      name: 'task_operator',
      status: 'done',
      arguments: JSON.stringify({
        action: 'create',
        taskId: '',
        parentTaskId: 'task_parent_123',
        taskTitle: 'New Test Task Subtask',
        status: 'open',
        summary: 'Subtask under New Test Task.',
        involvedParticipants: ['Kordi User 3', 'Kordi User 2'],
      }),
      liveOutput: '',
      resultText: 'Task created: New Test Task Subtask\n\nTasks:\n- ID: `task_child_456`; title: New Test Task Subtask; status: open; parent: `task_parent_123`; summary: Subtask under New Test Task.',
      detail: null,
      artifactPath: null,
      toolLayer: 'operator',
      isError: false,
    }],
  };

  const dashboard = buildTaskActivityDashboard({
    messages: [assistantTurnMessage(parentTurn), assistantTurnMessage(subtaskTurn)],
  });

  assert.equal(dashboard.tasks.length, 1);
  assert.equal(dashboard.tasks[0].taskId, 'task_parent_123');
  assert.equal(dashboard.tasks[0].title, 'New Test Task');
  assert.equal(dashboard.tasks[0].subtasks.length, 1);
  assert.equal(dashboard.tasks[0].subtasks[0].id, 'task:task_child_456');
  assert.equal(dashboard.tasks[0].subtasks[0].title, 'New Test Task Subtask');
  assert.equal(dashboard.tasks[0].subtasks[0].summary, 'Subtask under New Test Task.');
});

test('task dashboard merges title-only close events into the existing durable task row', () => {
  const createTurn: DesktopChatTurnSnapshot = {
    id: 'turn-create-title-close',
    sessionId: 'session-1',
    prompt: '@KordiUser3sKordi create a task for issue 317',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'Created the task.',
    thinkingText: '',
    completed: true,
    succeeded: true,
    tools: [{
      id: 'create-title-close',
      name: 'task_operator',
      status: 'done',
      arguments: '{"action":"create","taskId":"finish_kordi_issue_317_review","taskTitle":"Finish Kordi Issue 317 Review","involvedParticipants":["Kordi User 2","Kordi User 3\'s Kordi"]}',
      liveOutput: '',
      resultText: 'Task created: Finish Kordi Issue 317 Review',
      detail: null,
      artifactPath: null,
      toolLayer: 'operator',
      isError: false,
    }],
  };
  const closeTurn: DesktopChatTurnSnapshot = {
    id: 'turn-close-title-only',
    sessionId: 'session-1',
    prompt: '@KordiUser3sKordi close the task',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'Closed the task.',
    thinkingText: '',
    completed: true,
    succeeded: true,
    tools: [{
      id: 'close-title-only',
      name: 'task_operator',
      status: 'done',
      arguments: '{"action":"close","taskTitle":"Finish Kordi Issue 317 Review","query":"Finish Kordi Issue 317 Review","involvedParticipants":["Kordi User 2","Kordi User 3\'s Kordi"]}',
      liveOutput: '',
      resultText: 'Task closed: Finish Kordi Issue 317 Review',
      detail: null,
      artifactPath: null,
      toolLayer: 'operator',
      isError: false,
    }],
  };

  const dashboard = buildTaskActivityDashboard({
    messages: [assistantTurnMessage(createTurn), assistantTurnMessage(closeTurn)],
  });

  assert.equal(dashboard.tasks.length, 1);
  assert.equal(dashboard.tasks[0].taskId, 'finish_kordi_issue_317_review');
  assert.equal(dashboard.tasks[0].title, 'Finish Kordi Issue 317 Review');
  assert.equal(dashboard.tasks[0].status, 'closed');
});

test('task dashboard does not close a durable task row when a title-only close tool fails', () => {
  const createTurn: DesktopChatTurnSnapshot = {
    id: 'turn-create-before-failed-close',
    sessionId: 'session-1',
    prompt: '@KordiUser3sKordi create a task for issue 317',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'Created the task.',
    thinkingText: '',
    completed: true,
    succeeded: true,
    tools: [{
      id: 'create-before-failed-close',
      name: 'task_operator',
      status: 'done',
      arguments: '{"action":"create","taskId":"finish_kordi_issue_317_review","taskTitle":"Finish Kordi Issue 317 Review"}',
      liveOutput: '',
      resultText: 'Task created: Finish Kordi Issue 317 Review',
      detail: null,
      artifactPath: null,
      toolLayer: 'operator',
      isError: false,
    }],
  };
  const failedCloseTurn: DesktopChatTurnSnapshot = {
    id: 'turn-failed-close-title-only',
    sessionId: 'session-1',
    prompt: '@KordiUser3sKordi close the task',
    status: 'failed',
    message: '2 tools failed',
    assistantText: 'I could not close the task.',
    thinkingText: '',
    completed: true,
    succeeded: false,
    tools: [{
      id: 'failed-close-title-only',
      name: 'task_operator',
      status: 'error',
      arguments: '{"action":"close","taskTitle":"Finish Kordi Issue 317 Review","query":"Finish Kordi Issue 317 Review"}',
      liveOutput: '',
      resultText: 'Error: close requires taskId or child-agent target',
      detail: null,
      artifactPath: null,
      toolLayer: 'operator',
      isError: true,
    }],
  };

  const dashboard = buildTaskActivityDashboard({
    messages: [assistantTurnMessage(createTurn), assistantTurnMessage(failedCloseTurn)],
  });

  assert.equal(dashboard.tasks.length, 1);
  assert.equal(dashboard.tasks[0].title, 'Finish Kordi Issue 317 Review');
  assert.notEqual(dashboard.tasks[0].status, 'closed');
});

test('task dashboard uses group-scoped stable task ids from model task id', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'local-turn-id-a',
    sessionId: 'session:group:stable-task-id',
    prompt: '@Kordi create task',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'Created the task.',
    thinkingText: '',
    completed: true,
    succeeded: true,
    tools: [{
      id: 'create-stable-id',
      name: 'task_operator',
      status: 'done',
      arguments: '{"action":"create","taskId":"new_test_task_for_kordi_user_6_2","taskTitle":"New Test Task"}',
      liveOutput: '',
      resultText: 'Task created: New Test Task',
      detail: null,
      artifactPath: null,
      toolLayer: 'operator',
      isError: false,
    }],
  };

  const dashboard = buildTaskActivityDashboard({ messages: [assistantTurnMessage(turn)] });

  assert.equal(dashboard.tasks[0].id, 'task:session:group:stable-task-id:new_test_task_for_kordi_user_6_2');
  assert.equal(dashboard.tasks[0].taskId, 'new_test_task_for_kordi_user_6_2');
});

test('task dashboard merges task events by task id when title text differs', () => {
  const firstTurn: DesktopChatTurnSnapshot = {
    id: 'turn-task-id-a',
    sessionId: 'session-1',
    prompt: '@Kordi create task',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'Created the task.',
    thinkingText: '',
    completed: true,
    succeeded: true,
    tools: [{
      id: 'create-a',
      name: 'task_operator',
      status: 'done',
      arguments: '{"action":"create","taskId":"shared_task_1","taskTitle":"First Visible Title","involvedParticipants":["Kordi User 2"]}',
      liveOutput: '',
      resultText: 'Task created: First Visible Title',
      detail: null,
      artifactPath: null,
      toolLayer: 'operator',
      isError: false,
    }],
  };
  const secondTurn: DesktopChatTurnSnapshot = {
    ...firstTurn,
    id: 'turn-task-id-b',
    assistantText: 'Created the task for you.',
    tools: [{ ...firstTurn.tools[0], id: 'create-b', arguments: '{"action":"create","taskId":"shared_task_1","taskTitle":"Second Visible Title","involvedParticipants":["Kordi User 2"]}' }],
  };

  const dashboard = buildTaskActivityDashboard({ messages: [assistantTurnMessage(firstTurn), assistantTurnMessage(secondTurn)] });

  assert.equal(dashboard.tasks.length, 1);
  assert.equal(dashboard.tasks[0].taskId, 'shared_task_1');
});

test('task dashboard prefers model-generated task titles from tool arguments', () => {
  const liveTurn: DesktopChatTurnSnapshot = {
    id: 'turn-1',
    sessionId: 'session-1',
    prompt: '@Kordi please do a detailed review of the open claw code and give me a report when done',
    status: 'tooling',
    message: 'Running tool…',
    assistantText: '',
    thinkingText: '',
    completed: false,
    succeeded: false,
    tools: [
      {
        id: 'plan-1',
        name: 'update_plan',
        status: 'done',
        arguments: '{"taskTitle":"Review Open Claw Code","plan":[{"step":"Inspect code","status":"in_progress"}]}',
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
  assert.equal(dashboard.tasks[0].title, 'Review Open Claw Code');
});

test('task dashboard records task time and duration metadata', () => {
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

  const dashboard = buildTaskActivityDashboard({ messages: [assistantTurnMessage(turn)] });

  assert.equal(dashboard.tasks[0].timeLabel, '10:00');
  assert.equal(dashboard.tasks[0].durationLabel, '1m 15s');
});

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

test('task panel renders the whole task as an expandable row with a checkbox-style status icon', () => {
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
  assert.match(markup, /data-task-status-icon="checkbox"/);
  assert.doesNotMatch(markup, />▸</);
  assert.match(markup, /data-subtask-status-label="true"[^>]*>Done</);
  assert.match(markup, /review code/);
  assert.equal(markup.match(/1 subtask/g)?.length, 1);
  assert.match(markup, /research_docs/);
});

test('task panel renders nested durable subtasks with a circle status and status text', () => {
  const parentTurn: DesktopChatTurnSnapshot = {
    id: 'turn-create-parent-task',
    sessionId: 'session-group-1',
    prompt: '@Kordi create a task',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'Created a new task: **New Test Task**',
    thinkingText: '',
    completed: true,
    succeeded: true,
    tools: [{
      id: 'create-parent-task',
      name: 'task_operator',
      status: 'done',
      arguments: JSON.stringify({ action: 'create', taskId: '', taskTitle: 'New Test Task', status: 'open' }),
      liveOutput: '',
      resultText: 'Task created: New Test Task\n\nTasks:\n- ID: `task_parent_123`; title: New Test Task; status: open; summary: New test task.',
      detail: null,
      artifactPath: null,
      toolLayer: 'operator',
      isError: false,
    }],
  };
  const subtaskTurn: DesktopChatTurnSnapshot = {
    id: 'turn-create-child-task',
    sessionId: 'session-group-1',
    prompt: '@Kordi create a subtask for it',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'Created a subtask under **New Test Task**.',
    thinkingText: '',
    completed: true,
    succeeded: true,
    tools: [{
      id: 'create-child-task',
      name: 'task_operator',
      status: 'done',
      arguments: JSON.stringify({ action: 'create', taskId: '', parentTaskId: 'task_parent_123', taskTitle: 'New Test Task Subtask', status: 'open' }),
      liveOutput: '',
      resultText: 'Task created: New Test Task Subtask\n\nTasks:\n- ID: `task_child_456`; title: New Test Task Subtask; status: open; parent: `task_parent_123`;',
      detail: null,
      artifactPath: null,
      toolLayer: 'operator',
      isError: false,
    }],
  };

  const markup = renderToStaticMarkup(createElement(TaskActivityDashboardPanel, {
    messages: [assistantTurnMessage(parentTurn), assistantTurnMessage(subtaskTurn)],
    liveTurn: null,
    emptyMessage: 'No tasks',
  }));

  assert.match(markup, /data-subtask-status-icon="checkbox"/);
  assert.match(markup, /data-subtask-status-label="true"[^>]*>Planned</);
  assert.match(markup, /New Test Task Subtask/);
});

test('task panel shows running subtasks with a circle and elapsed time only for live tool work', () => {
  const liveTurn: DesktopChatTurnSnapshot = {
    id: 'turn-1',
    sessionId: 'session-1',
    prompt: '@Kordi review code',
    status: 'tooling',
    message: 'Running tool…',
    assistantText: '',
    thinkingText: '',
    completed: false,
    succeeded: false,
    tools: [
      {
        id: 'spawn-1',
        name: 'task_operator',
        status: 'running',
        arguments: '{"action":"spawn","taskName":"research_docs","message":"Inspect docs"}',
        liveOutput: '',
        resultText: 'Task agent running: /root/research_docs',
        detail: null,
        artifactPath: null,
        toolLayer: 'operator',
        isError: false,
      },
    ],
  };

  const markup = renderToStaticMarkup(createElement(TaskActivityDashboardPanel, {
    messages: [],
    liveTurn,
    emptyMessage: 'No tasks',
  }));

  assert.match(markup, /data-subtask-status-icon="checkbox"/);
  assert.match(markup, /Subagent active · Running · 0s/);
});

test('task dashboard exposes response and generated artifact links for task rows', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-report',
    sessionId: 'session-1',
    prompt: '@Kordi create a project structure report',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'Created the report.',
    thinkingText: '',
    completed: true,
    succeeded: true,
    tools: [
      {
        id: 'report-artifact',
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
      {
        id: 'package-related',
        name: 'edit',
        status: 'done',
        arguments: JSON.stringify({ path: 'package.json' }),
        liveOutput: '',
        resultText: 'updated package metadata',
        detail: null,
        artifactPath: null,
        toolLayer: 'execution',
        isError: false,
      },
    ],
  };

  const dashboard = buildTaskActivityDashboard({ messages: [assistantTurnMessage(turn)] });

  assert.equal(dashboard.tasks.length, 1);
  assert.equal(dashboard.tasks[0].responseMessageId, 'message:turn-report');
  assert.deepEqual(dashboard.tasks[0].artifactIds, ['docs/reports/kordi-project-structure-report.md']);
});

test('task panel renders response and artifact navigation buttons for linked tasks', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-report',
    sessionId: 'session-1',
    prompt: '@Kordi create a project structure report',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'Created the report.',
    thinkingText: '',
    completed: true,
    succeeded: true,
    tools: [
      {
        id: 'report-artifact',
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

  const markup = renderToStaticMarkup(createElement(TaskActivityDashboardPanel, {
    messages: [assistantTurnMessage(turn)],
    liveTurn: null,
    emptyMessage: 'No tasks',
    artifacts: [{
      id: 'docs/reports/kordi-project-structure-report.md',
      path: 'docs/reports/kordi-project-structure-report.md',
      name: 'kordi-project-structure-report.md',
      kind: 'document',
      summary: 'Generated report',
      category: 'artifact',
    }],
    onOpenArtifact: () => undefined,
  }));

  assert.match(markup, /data-task-action="jump-response"/);
  assert.match(markup, /aria-label="Jump to related response"/);
  assert.match(markup, /data-task-action="open-artifact"/);
  assert.match(markup, /aria-label="Open related artifact"/);
});

test('task panel renders artifact navigation as soon as the task has a generated artifact id', () => {
  const turn: DesktopChatTurnSnapshot = {
    id: 'turn-report',
    sessionId: 'session-1',
    prompt: '@Kordi create a project structure report',
    status: 'succeeded',
    message: 'Response complete',
    assistantText: 'Created the report.',
    thinkingText: '',
    completed: true,
    succeeded: true,
    tools: [
      {
        id: 'report-artifact',
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

  const markup = renderToStaticMarkup(createElement(TaskActivityDashboardPanel, {
    messages: [assistantTurnMessage(turn)],
    liveTurn: null,
    emptyMessage: 'No tasks',
    onOpenArtifact: () => undefined,
  }));

  assert.match(markup, /data-task-action="open-artifact"/);
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
