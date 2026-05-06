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

  assert.equal(dashboard.tasks[0].status, 'completed');
  assert.equal(dashboard.tasks[0].timeLabel, '22:33');
  assert.equal(dashboard.completedCount, 1);

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
  assert.equal(dashboard.tasks[0].status, 'completed');
  assert.equal(dashboard.tasks[0].statusLabel, 'Done');
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
  assert.doesNotMatch(markup, />Done</);
  assert.match(markup, /review code/);
  assert.equal(markup.match(/1 active subtask/g)?.length, 1);
  assert.match(markup, /research_docs/);
});

test('task panel shows running subtasks with a circle and elapsed time', () => {
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

  assert.match(markup, /data-subtask-status-icon="circle"/);
  assert.match(markup, /Running · 0s/);
  assert.doesNotMatch(markup, /Subagent active/);
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
    prompt: '@Kordi review the change log and related blog of open source release notes',
    status: 'tooling',
    message: 'Thinking…',
    assistantText: '',
    thinkingText: '',
    completed: false,
    succeeded: false,
    tools: [],
  };

  const markup = renderToStaticMarkup(createElement(TaskActivityDashboardPanel, {
    messages: [],
    liveTurn,
    emptyMessage: 'No tasks',
  }));

  assert.match(markup, /review the change log and related blog/);
  assert.doesNotMatch(markup, /app-inspector-heading truncate/);
});
