import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildTaskActivityDashboard } from '../src/features/chat/taskActivityDashboard';
import type { DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';
import { TaskActivityDashboardPanel } from '../src/pages/TaskActivityDashboardPanel';
import { assistantTurnMessage } from './helpers/taskActivityDashboardFixtures';

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
