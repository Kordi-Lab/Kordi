import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildTaskActivityDashboard } from '../src/features/chat/taskActivityDashboard';
import type { DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';

function assistantTurnMessage(turn: DesktopChatTurnSnapshot): Message {
  return {
    role: 'owned-agent',
    sender: 'My Kordi',
    text: turn.assistantText,
    time: '10:00',
    turn,
  };
}

test('groups planning coordination and execution activity for the right-panel task dashboard', () => {
  const historicalTurn: DesktopChatTurnSnapshot = {
    id: 'turn-1',
    sessionId: 'session-1',
    prompt: 'implement the task',
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

  assert.equal(dashboard.planningCoordination.length, 2);
  assert.equal(dashboard.execution.length, 1);
  assert.equal(dashboard.planningCoordination[0].groupLabel, 'Planning & coordination');
  assert.equal(dashboard.execution[0].groupLabel, 'Execution');
  assert.equal(dashboard.execution[0].title, 'Run tests');
  assert.equal(dashboard.execution[0].statusLabel, 'Running');
  assert.equal(dashboard.activeSubagents.length, 1);
  assert.deepEqual(dashboard.activeSubagents[0], {
    target: '/root/research_docs',
    name: 'research_docs',
    status: 'active',
    statusLabel: 'Subagent active',
    writeScope: ['docs'],
  });
});

test('updates subagent activation when a later task operator result completes the task', () => {
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

  assert.equal(dashboard.activeSubagents.length, 0);
  assert.equal(dashboard.subagents.length, 1);
  assert.equal(dashboard.subagents[0].status, 'completed');
  assert.equal(dashboard.subagents[0].statusLabel, 'Subagent completed');
});
