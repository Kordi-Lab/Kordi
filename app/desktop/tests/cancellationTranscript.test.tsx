import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { selfAgentMirrorDuplicateIds } from '../src/features/canonical/readModel/selfAgentMirrorDedup';
import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';
import { mapDesktopMessagesForTranscript } from '../src/features/chat/useDesktopTranscriptAdapter';
import { LiveChatTurnCard } from '../src/kordi-app/components/transcriptLiveTurns';
import type { CanonicalSessionMessage, CanonicalSessionState } from '../src/kordi-app/types';

const sessionId = 'session:cancellation-test';
const identities = [
  { id: 'human:test', kind: 'human', displayName: 'Test user', source: 'local', createdAtMs: 1, updatedAtMs: 1 },
  { id: 'agent:test', kind: 'agent', displayName: 'Test agent', source: 'local', ownerIdentityId: 'human:test', createdAtMs: 1, updatedAtMs: 1 },
] as CanonicalSessionState['identities'];
const identityById = new Map(identities.map((identity) => [identity.id, identity]));
const tools = [{ id: 'tool:read', name: 'read_session', status: 'complete', arguments: '{}', liveOutput: '', resultText: 'Done', detail: null, isError: false }];
function row(overrides: Partial<CanonicalSessionMessage> = {}): CanonicalSessionMessage {
  return {
    id: 'canonical:local', sessionId, senderIdentityId: 'agent:test', senderRole: 'owned-agent',
    messageKind: 'agent-turn', contentText: '', content: { deliveryState: 'cancelled', desktopEntryId: 'entry:cancelled', tools },
    parentMessageId: 'request:test', status: 'cancelled', sequenceNum: 2, createdAtMs: 9_000, updatedAtMs: 9_000,
    contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'event:local', ...overrides,
  };
}
function cloudRow(overrides: Partial<CanonicalSessionMessage> = {}) {
  return row({ id: 'canonical:cloud', contentText: 'Request canceled.', content: { deliveryState: 'cancelled', tools },
    sourceTransport: 'cloud-self-agent', sourceEventId: 'event:cloud', createdAtMs: 1_001, sequenceNum: 3, ...overrides });
}
function markup(message: CanonicalSessionMessage) {
  const mapped = mapCanonicalMessage(message, identityById, 'human:test')!;
  return renderToStaticMarkup(createElement(LiveChatTurnCard, { showReasoning: true, turn: mapped.turn!, historical: true }));
}
for (const text of ['Request canceled.', 'Request cancelled.', 'Request stopped.', 'Response stopped', 'Request canceled by sender.']) {
  test(`canonical cancellation renders one status for ${text}`, () => {
    const mapped = mapCanonicalMessage(cloudRow({ contentText: text }), identityById, 'human:test')!;
    assert.equal(mapped.turn!.assistantText, '');
    const html = markup(cloudRow({ contentText: text }));
    assert.equal(html.split(text).length - 1, 1);
    assert.ok(!html.includes('app-live-assistant-answer-cancelled'));
  });
}
test('a partial answer survives cancellation and is distinct from its status', () => {
  const text = 'Request canceled. Here is the work completed so far.';
  const mapped = mapCanonicalMessage(row({ contentText: text }), identityById, 'human:test')!;
  assert.equal(mapped.turn!.assistantText, text);
  assert.notEqual(mapped.turn!.message, text);
  const html = markup(row({ contentText: text }));
  assert.equal(html.split(text).length - 1, 1);
});

test('cloud cancellation and empty local cancellation become one runtime card with tools and duration', () => {
  const request = row({ id: 'request:test', senderIdentityId: 'human:test', senderRole: 'user', messageKind: 'text',
    contentText: 'Summarize recent work', content: {}, parentMessageId: null, status: 'sent', sequenceNum: 1, createdAtMs: 1_000 });
  const state = { storagePath: '', profile: { id: 'profile:test', humanIdentityId: 'human:test', activeAgentIdentityId: 'agent:test' },
    identities, sessions: [{ id: sessionId, kind: 'self-agent', title: 'Cancellation test', status: 'active', primaryIdentityId: 'agent:test', metadata: {}, createdAtMs: 1_000, updatedAtMs: 9_000 }],
    participants: [], messages: [request, row(), cloudRow()], delegatedExchanges: [], presence: [], contextSnapshots: [],
  } as unknown as CanonicalSessionState;
  const runtime = mapDesktopMessagesForTranscript(sessionId, [
    { role: 'user', entryId: request.id, text: request.contentText, timeLabel: '00:00', timestampMs: 1_000 },
    { role: 'assistant', entryId: 'entry:cancelled', text: '', cancelled: true, tools, thinkingText: '', timeLabel: '00:00', timestampMs: 9_000, turnStartedAtMs: 1_000, turnCompletedAtMs: 9_000 },
  ]);
  const readModel = createCanonicalSessionReadModel(state);
  const result = readModel.applyConversation({ id: sessionId, canonicalSessionId: sessionId, desktopRuntimeBacked: true,
    desktopRuntimeTranscriptLoaded: true, messages: runtime } as never, () => '');
  assert.equal(result.messages.length, 2);
  const turn = result.messages[1].turn!;
  assert.deepEqual(turn.tools, tools);
  const html = renderToStaticMarkup(createElement(LiveChatTurnCard, { showReasoning: true, turn, historical: true }));
  assert.match(html, /Worked for 8s/);
  assert.equal(html.split('Response stopped').length - 1, 1);
});

test('cancellation mirrors use the request relation and preserve real partial content', () => {
  for (const localText of ['', 'Partial answer']) {
    const duplicates = selfAgentMirrorDuplicateIds([row({ contentText: localText }), cloudRow()], identityById, 'human:test', true);
    assert.deepEqual([...duplicates], ['canonical:cloud']);
  }
  for (const cloud of [cloudRow({ parentMessageId: 'request:other' }), cloudRow({ parentMessageId: null }),
    cloudRow({ sessionId: 'session:other' }), cloudRow({ senderIdentityId: 'agent:peer' }),
    cloudRow({ contentText: 'Additional actual answer' }), cloudRow({ status: 'complete', content: { deliveryState: 'complete' } })]) {
    const peerIdentities = new Map([...identityById, ['agent:peer', { ...identities[1], id: 'agent:peer', ownerIdentityId: 'human:peer' }]]);
    assert.equal(selfAgentMirrorDuplicateIds([row(), cloud], peerIdentities, 'human:test', true).size, 0);
  }
  assert.equal(selfAgentMirrorDuplicateIds([row(), cloudRow()], identityById, 'human:test', false).size, 0);
});

for (const message of ['Stopped', 'Request canceled by sender.', 'Response stopped']) {
  test(`legacy canceled turns render only the descriptive notice with status ${message}`, () => {
    const mapped = mapCanonicalMessage(row(), identityById, 'human:test')!;
    const turn = { ...mapped.turn!, message, assistantText: 'Request canceled by sender.' };
    const html = renderToStaticMarkup(createElement(LiveChatTurnCard, { showReasoning: true, turn, historical: true }));
    assert.equal(html.split('Request canceled by sender.').length - 1, 1);
    assert.ok(!html.includes('app-live-assistant-answer-cancelled'));
  });
}

test('successful answer text that mentions cancellation remains an answer', () => {
  const mapped = mapCanonicalMessage(row({ status: 'complete', content: {}, contentText: 'Request canceled.' }), identityById, 'human:test')!;
  assert.equal(mapped.turn!.assistantText, 'Request canceled.');
  const html = renderToStaticMarkup(createElement(LiveChatTurnCard, { showReasoning: true, turn: mapped.turn!, historical: true }));
  assert.equal(html.split('Request canceled.').length - 1, 1);
  assert.ok(!html.includes('app-live-turn-cancelled'));
});

test('cancellation mirror aliases resolve cloud request IDs to local request rows', () => {
  const request = row({ id: 'request:test', sourceEventId: 'cloud:request', senderRole: 'user', senderIdentityId: 'human:test',
    messageKind: 'text', contentText: 'Summarize', parentMessageId: null, createdAtMs: 1_000, status: 'sent', content: {} });
  const cloud = cloudRow({ parentMessageId: null, content: { cloudRequestMessageId: 'cloud:request', deliveryState: 'cancelled' } });
  assert.deepEqual([...selfAgentMirrorDuplicateIds([request, row(), cloud], identityById, 'human:test', true)], ['canonical:cloud']);
});

for (const error of ['Request stopped', 'Request canceled.']) {
  test(`legacy delegation cancellation does not render ${error} as a second error`, () => {
    const turn = { ...mapCanonicalMessage(row(), identityById, 'human:test')!.turn!, message: 'Stopped', error };
    const html = renderToStaticMarkup(createElement(LiveChatTurnCard, { showReasoning: true, turn, historical: true }));
    assert.equal(html.split(error).length - 1, 1);
    assert.ok(!html.includes('app-live-turn-error-text'));
  });
}

test('a real error accompanying cancellation remains visible', () => {
  const turn = { ...mapCanonicalMessage(row(), identityById, 'human:test')!.turn!, error: 'Could not save the partial result.' };
  const html = renderToStaticMarkup(createElement(LiveChatTurnCard, { showReasoning: true, turn, historical: true }));
  assert.match(html, /Could not save the partial result/);
  assert.match(html, /app-live-turn-error-text/);
});

for (const role of ['sender', 'agent owner', 'participant']) {
  test(`an attributed cancellation status survives a generic legacy answer for ${role}`, () => {
    const turn = { ...mapCanonicalMessage(row(), identityById, 'human:test')!.turn!,
      message: `Request canceled by ${role}.`, assistantText: 'Request canceled.' };
    const html = renderToStaticMarkup(createElement(LiveChatTurnCard, { showReasoning: true, turn, historical: true }));
    assert.equal(html.split(`Request canceled by ${role}.`).length - 1, 1);
    assert.ok(!html.includes('app-live-assistant-answer-cancelled'));
  });
}
