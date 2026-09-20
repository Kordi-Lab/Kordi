import assert from 'node:assert/strict';
import test from 'node:test';
import { preserveOutgoingTranscriptOrder } from '../src/features/chat/transcriptOutgoingOrder';
import { createTranscriptReferenceStabilizer } from '../src/features/chat/transcriptReferenceStability';
import type { Conversation, Message } from '../src/kordi-app/types';

const message = (id: string, timestampMs: number, status = 'sending'): Message => ({
  id, clientMessageId: id, role: 'user', isOwnMessage: true, text: id,
  time: '11:30', timestampMs, statusChips: [status],
});
const conversation = (messages: Message[], id = 'chat'): Conversation => ({
  id, canonicalSessionId: id, name: 'Chat', type: 'person', subtitle: '', unread: 0,
  collaborationSources: ['Cloud'], trust: 'Contact', directness: 'Direct', participants: ['Me', 'Peer'], messages,
});

test('acknowledgements crossing pending timestamps cannot reorder the rendered send burst', () => {
  const stabilizer = createTranscriptReferenceStabilizer();
  const pending = ['first', 'second', 'third', 'fourth'].map((id, index) => message(id, 1000 + index * 100));
  let prepared = stabilizer.prepare([conversation(pending)]);
  stabilizer.commit(prepared);
  let rows = pending;
  for (let index = 0; index < pending.length; index++) {
    rows = rows.map((row) => row.clientMessageId === pending[index].id
      ? { ...row, id: `server-${row.clientMessageId}`, timestampMs: 2000 + index * 500,
          conversationSequence: index + 1, statusChips: ['delivered'] } : row)
      .sort((left, right) => left.timestampMs! - right.timestampMs!);
    prepared = stabilizer.prepare([conversation(rows)]);
    assert.deepEqual(prepared.conversations[0].messages.map((row) => row.clientMessageId), pending.map((row) => row.id));
    assert.equal(prepared.conversations[0].messages[index].statusChips?.[0], 'delivered');
    assert.equal(prepared.conversations[0].messages[index].timestampMs, 2000 + index * 500, 'server metadata stays authoritative');
    stabilizer.commit(prepared);
  }
  const settled = stabilizer.prepare([conversation(rows)]);
  assert.deepEqual(settled.conversations[0].messages.map((row) => row.clientMessageId), pending.map((row) => row.id));
});

test('history, incoming replies and deletions keep their supplied slots while only local sends are reordered', () => {
  const first = message('first', 1000);
  const second = message('second', 1100);
  const baseline = preserveOutgoingTranscriptOrder(undefined, [first, second]);
  const older = { ...message('history', 100, 'read'), role: 'person' as const, isOwnMessage: false };
  const reply = { ...older, id: 'reply', timestampMs: 1150 };
  const acknowledged = { ...first, timestampMs: 1500, statusChips: ['delivered'] };
  const next = preserveOutgoingTranscriptOrder(baseline.order, [older, second, reply, acknowledged]);
  assert.deepEqual(next.messages, [older, acknowledged, reply, second]);
  const pruned = preserveOutgoingTranscriptOrder(next.order, [older, acknowledged]);
  assert.equal(pruned.order.has('second'), false);
});

test('an abandoned render cannot consume the order of a later committed send', () => {
  const stabilizer = createTranscriptReferenceStabilizer();
  stabilizer.prepare([conversation([message('abandoned', 100)])]);
  const committed = stabilizer.prepare([conversation([message('first', 200)])]);
  stabilizer.commit(committed);
  const next = stabilizer.prepare([conversation([message('second', 300), message('first', 500, 'delivered')])]);
  assert.deepEqual(next.conversations[0].messages.map((row) => row.id), ['first', 'second']);
});

test('confirmed history is unchanged and removed conversations do not retain send anchors', () => {
  const stabilizer = createTranscriptReferenceStabilizer();
  const first = stabilizer.prepare([conversation([message('same', 100)])]);
  stabilizer.commit(first);
  stabilizer.commit(stabilizer.prepare([]));
  const history = [message('newer', 400, 'read'), message('same', 500, 'delivered')];
  const next = stabilizer.prepare([conversation(history)]);
  assert.equal(next.conversations[0].messages, history);
  assert.equal(next.outgoingOrderCache.get('chat')?.size, 0);
});
