import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  relatedAgentSessionsFromTools,
  relatedAgentSessionStatusById,
  relatedAgentSessionStatusMapsEqual,
} from '../src/features/chat/relatedAgentSessions';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { cloudAgentPublicBackgroundToolsFromTurn } from '../src/features/cloud/cloudAgentBackgroundSessions';
import type { CanonicalSessionMessage, Conversation, DesktopChatToolSnapshot } from '../src/kordi-app/types';

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

test('derives live and terminal background session states from child conversations', () => {
  const conversation = (
    id: string,
    turn: NonNullable<Conversation['previewLiveTurn']>,
    live = false,
  ): Conversation => ({
    id,
    name: id,
    type: 'owned-agent',
    subtitle: '',
    unread: 0,
    collaborationSources: ['Local'],
    trust: 'Owned',
    directness: 'Agent chat',
    participants: ['Me', 'My Kordi'],
    messages: live ? [] : [{ id: `message-${id}`, role: 'owned-agent', text: '', time: '', turn }],
    previewLiveTurn: live ? turn : null,
  });
  const turn = (status: string, completed: boolean, succeeded: boolean) => ({
    id: `turn-${status}`,
    sessionId: `session-${status}`,
    prompt: '',
    status,
    message: '',
    assistantText: '',
    thinkingText: '',
    tools: [],
    completed,
    succeeded,
    error: succeeded ? null : 'Turn failed',
  });
  const statuses = relatedAgentSessionStatusById([
    conversation('running', turn('processing', false, false), true),
    conversation('done', turn('complete', true, true)),
    conversation('failed', turn('failed', true, false)),
    conversation('stopped', turn('cancelled', true, false)),
    {
      ...conversation('interrupted', turn('complete', true, true)),
      statusIndicator: { label: 'Failed', tone: 'error' },
    },
  ]);

  assert.deepEqual(Object.fromEntries(statuses), {
    running: 'running',
    done: 'done',
    failed: 'failed',
    stopped: 'stopped',
    interrupted: 'failed',
  });
  assert.equal(relatedAgentSessionStatusMapsEqual(statuses, new Map(statuses)), true);
  assert.equal(
    relatedAgentSessionStatusMapsEqual(statuses, new Map([...statuses, ['running', 'done']])),
    false,
  );
});

test('group mention replies carry the spawned agent thread card for executor and members', () => {
  const groupReply = (senderRole: 'owned-agent' | 'external-agent', tools: DesktopChatToolSnapshot[]): CanonicalSessionMessage => ({
    id: `msg:cloud-agent-processing:msg:ui:request:${senderRole}`,
    sessionId: 'session:group:weekend-trip',
    senderIdentityId: 'agent:owner',
    senderRole,
    messageKind: 'agent-turn',
    contentText: 'Started the background task.',
    content: {
      sender: 'Kordi',
      deliveryState: 'complete',
      requestId: 'msg:ui:request',
      replyToMessageId: 'msg:ui:request',
      sourceConversationId: 'cloud-group-agent:session:group:weekend-trip',
      tools,
    },
    parentMessageId: 'msg:ui:request',
    status: 'received',
    sequenceNum: 2,
    createdAtMs: 2,
    updatedAtMs: 2,
    sourceTransport: 'cloud-group-agent',
  });
  const executorTools = [spawnTool('subsession-group', { id: 'call_1|fc_1' })];
  const memberTools = cloudAgentPublicBackgroundToolsFromTurn({ tools: executorTools });

  for (const reply of [groupReply('owned-agent', executorTools), groupReply('external-agent', memberTools)]) {
    const message = mapCanonicalMessage(reply, new Map());
    assert.deepEqual(
      relatedAgentSessionsFromTools(message?.turn?.tools).map(({ sessionId, title }) => ({ sessionId, title })),
      [{ sessionId: 'subsession-group', title: 'Research orchestration' }],
    );
  }
});
