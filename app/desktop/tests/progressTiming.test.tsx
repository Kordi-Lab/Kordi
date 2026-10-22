import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { cloudAgentExecutionCanonicalContent, cloudAgentExecutionSnapshotFromTurn } from '../src/features/cloud/cloudAgentExecutionTrace';
import { TurnProgress } from '../src/kordi-app/components/TurnProgress';
import { turnProgressLabel } from '../src/kordi-app/components/turnProgressLabels';
import type { CanonicalSessionMessage, DesktopChatTurnSnapshot } from '../src/kordi-app/types';

const turn: DesktopChatTurnSnapshot = {
  id: 'turn', sessionId: 'session', prompt: '', message: '', status: 'complete',
  assistantText: 'Done.', thinkingText: 'Checking the example.', completed: true, succeeded: true,
  startedAtMs: 1000, completedAtMs: 196000,
  segments: [{ id: 'tool:one', kind: 'tool', toolId: 'one' }, { id: 'text:1', kind: 'text', text: 'Done.' }],
  tools: [{ id: 'one', name: 'read', arguments: '{}', liveOutput: '', status: 'done', isError: false }],
};

test('completed turns never display an unfinished duration phrase without valid timing', () => {
  for (const timing of [{ startedAtMs: null }, { completedAtMs: null }, { startedAtMs: NaN }, { completedAtMs: 500 }]) {
    for (const segments of [turn.segments, undefined]) {
      const missing = { ...turn, ...timing, segments };
      assert.equal(turnProgressLabel(missing), 'Finished');
      const html = renderToStaticMarkup(createElement(TurnProgress, { turn: missing, renderTool: () => null }));
      assert.match(html, /aria-label="Finished"/);
      assert.doesNotMatch(html, /Worked for|app-turn-progress-bird/);
      assert.equal(turnProgressLabel({ ...missing, status: 'cancelled' }), 'Stopped');
      assert.equal(turnProgressLabel({ ...missing, status: 'failed', succeeded: false }), 'Needs attention');
    }
  }
});

test('saved execution timing survives canonical hydration, including older nested snapshots', () => {
  const execution = cloudAgentExecutionSnapshotFromTurn(turn, turn.completedAtMs!);
  const content = cloudAgentExecutionCanonicalContent(execution);
  assert.equal(content.startedAtMs, 1000);
  assert.equal(content.completedAtMs, 196000);
  for (const stored of [content, { execution }]) {
    const message: CanonicalSessionMessage = {
      id: 'message', sessionId: 'session', senderIdentityId: 'agent:test', senderRole: 'owned-agent',
      messageKind: 'agent-turn', contentText: 'Done.', content: { ...stored, deliveryState: 'complete' },
      parentMessageId: null, status: 'complete', sequenceNum: 1, createdAtMs: 200000, updatedAtMs: 300000,
      contentHash: null, sourceTransport: 'cloud-self-agent', sourceEventId: 'event',
    };
    const restored = mapCanonicalMessage(message, new Map())!.turn!;
    assert.equal(restored.startedAtMs, 1000);
    assert.equal(restored.completedAtMs, 196000);
    assert.equal(turnProgressLabel(restored), 'Worked for');
  }
  const activeContent = cloudAgentExecutionCanonicalContent({ ...execution, completed: false });
  assert.equal(activeContent.completedAtMs, undefined);
});
