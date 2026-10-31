import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transcriptMessageRenderKeys } from '../src/features/chat/transcriptRenderKeys';
import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import type { DesktopCollaborationConversationMessage } from '../src/kordi-app/types';
import { conversation } from './helpers/collaborationTranscriptFixtures';

const now = Date.parse('2026-10-30T12:00:00Z');
const request: DesktopCollaborationConversationMessage = {
  id: 'canonical-request', clientMessageId: 'client-request', requestId: 'canonical-request',
  direction: 'outbound', text: '@Agent hello', timeLabel: '12:00', timestampMs: now,
  deliveryState: 'delivered',
  mentions: [{ label: 'Agent', targetKind: 'agent', nodeId: 'node-peer', agentId: 'agent-peer' }],
};
function response(id: string, deliveryState: string, local = false, requestId = request.id): DesktopCollaborationConversationMessage {
  return {
    id, requestId, direction: local ? 'outbound-response' : 'inbound-response',
    sender: 'Agent', text: deliveryState === 'processing' ? '' : 'Hello',
    timeLabel: '12:00', timestampMs: now + 1, deliveryState,
  };
}
function view(messages: DesktopCollaborationConversationMessage[], local = false, awaitingReply = true) {
  return mapCollaborationConversationToViewModel(conversation({
    messages, awaitingReply, updatedAtMs: now,
    identity: { localAgentId: local ? 'agent-peer' : 'agent-local', localAgentNodeId: local ? 'node-peer' : 'node-me' },
  }), undefined, 'Local agent', now + 2).messages;
}

for (const local of [false, true]) {
  test(`${local ? 'owner' : 'peer'} reply stays mounted from optimistic send through stored completion`, () => {
    const sending = { ...request, id: 'client-request', requestId: 'client-request', deliveryState: 'sending' };
    const phases = [
      view([sending], local),
      view([request], local),
      view([request, response('cloud-agent-processing:canonical-request', 'processing', local)], local),
      view([request, response('cloud-agent-local-response:canonical-request', 'complete', local)], local, false),
      view([request, response('stored-response', 'complete', local)], local, false),
    ];
    const replies = phases.map(messages => {
      const rows = messages.filter(message => message.turn);
      assert.equal(rows.length, 1, 'the reply must never disappear or duplicate during handoff');
      return rows[0];
    });
    const keys = phases.map((messages, index) => transcriptMessageRenderKeys(messages).get(replies[index]));
    assert.equal(new Set(keys).size, 1, 'one mounted virtual row must survive every handoff');
    assert.deepEqual(replies.map(row => row.senderAvatarSeed), Array(5).fill(replies[0].senderAvatarSeed));
    assert.deepEqual(replies.map(row => row.role), Array(5).fill(local ? 'owned-agent' : 'external-agent'));
    assert.equal(replies[2].turn?.completed, false);
    assert.equal(replies[4].turn?.assistantText, 'Hello');
    assert.equal(replies[4].turn?.completed, true);
  });
}

test('concurrent requests and exchange phases retain independent reply slots', () => {
  const second = { ...request, id: 'request-two', clientMessageId: 'client-two', requestId: 'request-two' };
  const waiting = view([request, response('pending-one', 'processing'), second, response('pending-two', 'processing', true, second.id)]);
  const finished = view([request, second, response('stored-two', 'complete', true, second.id), response('stored-one', 'complete')], false, false);
  const firstKeys = transcriptMessageRenderKeys(waiting);
  const lastKeys = transcriptMessageRenderKeys(finished);
  for (const role of ['owned-agent', 'external-agent']) {
    assert.equal(firstKeys.get(waiting.find(row => row.role === role)!), lastKeys.get(finished.find(row => row.role === role)!));
  }
  const exchange = view([
    response('question', 'complete', true, 'agent-exchange:synthetic:sent'),
    response('answer', 'complete', false, 'agent-exchange:synthetic:reply'),
    response('continuation', 'complete', true, 'agent-exchange:synthetic:continued'),
  ], false, false);
  assert.equal(new Set(transcriptMessageRenderKeys(exchange).values()).size, 3);
});

test('multiple published responses to a legacy request are never merged by render identity', () => {
  const messages = view([request, response('answer-one', 'complete'), response('answer-two', 'complete')], false, false);
  assert.equal(new Set(transcriptMessageRenderKeys(messages).values()).size, messages.length);
});

test('a mounted reply DOM node survives pending-to-stored replacement', async () => {
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { MessageBubble } = await import('../src/kordi-app/components/transcript');
  const { installDom } = await import('./helpers/transcriptAttachmentDom');
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = async (messages: ReturnType<typeof view>) => {
    const keys = transcriptMessageRenderKeys(messages);
    await act(async () => root.render(createElement('div', null, messages.filter(row => row.turn).map(msg =>
      createElement(MessageBubble, { key: keys.get(msg), msg }),
    ))));
  };
  try {
    await render(view([request, response('pending', 'processing')]));
    const before = host.querySelector('[data-transcript-message-root]');
    assert.ok(before);
    assert.match(host.textContent ?? '', /Waiting for agent/);
    await render(view([request, response('stored', 'complete')], false, false));
    assert.equal(host.querySelector('[data-transcript-message-root]'), before);
    assert.match(host.textContent ?? '', /Hello/);
    assert.doesNotMatch(host.textContent ?? '', /Waiting for agent/);
    assert.equal(host.querySelectorAll('[data-transcript-message-root]').length, 1);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});
