import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTaskActivityDashboard } from '../src/features/chat/taskActivityDashboard';
import type { DesktopChatToolSnapshot, DesktopChatTurnSnapshot } from '../src/kordi-app/types';
import { assistantTurnMessage, userMessage } from './helpers/taskActivityDashboardFixtures';

function tool(id: string, action: string, resultText: string, extra = {}): DesktopChatToolSnapshot {
  return { id, name: 'task_operator', status: 'done', arguments: JSON.stringify({ action, ...extra }), liveOutput: '', resultText, isError: false };
}
function turn(tools: DesktopChatToolSnapshot[], overrides = {}): DesktopChatTurnSnapshot {
  return { id: 'synthetic-parent', sessionId: 'synthetic-session', prompt: 'Calculate and verify the test sum',
    status: 'succeeded', message: 'Response complete', assistantText: 'Both calculations are complete.',
    thinkingText: '', completed: true, succeeded: true, tools, ...overrides };
}

test('both children finish and the successful parent is done after reload without another user message', () => {
  const completed = turn([
    tool('spawn-a', 'spawn', 'Task agent running: /root/calculate', { taskName: 'calculate' }),
    tool('spawn-b', 'spawn', 'Task agent running: /root/verify', { taskName: 'verify' }),
    tool('wait-a', 'wait', 'Task completed: /root/calculate'),
    tool('wait-b', 'wait', 'Task completed: /root/verify'),
  ]);
  const messages = JSON.parse(JSON.stringify([assistantTurnMessage(completed)]));
  const task = buildTaskActivityDashboard({ messages }).tasks[0];
  assert.equal(task.status, 'completed');
  assert.deepEqual(task.subtasks.map(child => child.status), ['completed', 'completed']);
  assert.doesNotMatch(task.summary, /input|confirm/i);
  const running = buildTaskActivityDashboard({ messages: [], liveTurn: { ...completed, completed: false, status: 'running' } }).tasks[0];
  assert.equal(running.status, 'active', 'finished children do not finish a still-running parent');
});

test('an explicit input wait shows its question and unrelated confirmation does not resolve it', () => {
  const waiting = turn([
    tool('input', 'create', 'Task ID: `synthetic-input`', { taskId: 'synthetic-input', taskTitle: 'Choose an output', status: 'waiting' }),
  ], { assistantText: 'Which output format should I use?' });
  const task = buildTaskActivityDashboard({ messages: [assistantTurnMessage(waiting), userMessage('done with my other task', 'unrelated')] }).tasks[0];
  assert.equal(task.status, 'waiting');
  assert.equal(task.summary, 'Which output format should I use?');
});
