import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildTaskActivityDashboard } from '../src/features/chat/taskActivityDashboard';
import type { DesktopChatTurnSnapshot } from '../src/kordi-app/types';
import { assistantTurnMessage } from './helpers/taskActivityDashboardFixtures';

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
