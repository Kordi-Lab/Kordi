import assert from 'node:assert/strict';
import { test } from 'node:test';

import { relatedAgentSessionsFromTools } from '../src/features/chat/relatedAgentSessions';
import type { DesktopChatToolSnapshot } from '../src/kordi-app/types';

function spawnTool(
  sessionId: string,
  overrides: Partial<DesktopChatToolSnapshot> = {},
): DesktopChatToolSnapshot {
  return {
    id: `tool-${sessionId}`,
    name: 'task_operator',
    status: 'done',
    arguments: '{"action":"spawn"}',
    liveOutput: '',
    resultText: `Task agent running: /root/research\n\nBackground session: ${JSON.stringify({
      sessionId,
      turnId: `turn-${sessionId}`,
      title: 'Research orchestration',
      status: 'running',
    })}`,
    detail: null,
    artifactPath: null,
    toolLayer: 'planning_coordination',
    isError: false,
    ...overrides,
  };
}

test('extracts, validates, and deduplicates background agent sessions', () => {
  assert.deepEqual(
    relatedAgentSessionsFromTools([
      spawnTool('session-one'),
      spawnTool('session-one'),
      spawnTool('session-failed', { isError: true }),
      spawnTool('session-invalid', { resultText: 'Background session: nope' }),
    ]),
    [{
      sessionId: 'session-one',
      turnId: 'turn-session-one',
      title: 'Research orchestration',
      status: 'running',
    }],
  );
});

test('caps related sessions at the task operator concurrency limit', () => {
  const sessions = relatedAgentSessionsFromTools(
    Array.from({ length: 6 }, (_, index) => spawnTool(`session-${index}`)),
  );

  assert.equal(sessions.length, 4);
  assert.equal(sessions[3]?.sessionId, 'session-3');
});
