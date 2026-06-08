import assert from 'node:assert/strict';
import test from 'node:test';

import { setMessageSelectionSource, toggleMessageSelectionSource, type MessageSelectionState } from '../src/features/chat/messageSelection';
import type { MessageActionSource } from '../src/features/chat/messageActionMetadata';

const source = (id: string): MessageActionSource => ({
  sourceSessionId: 'session:one',
  sourceMessageId: id,
  senderLabel: 'Alice',
  textPreview: id,
  attachmentCount: 0,
  createdAtMs: null,
  timeLabel: '10:42',
});

test('setMessageSelectionSource selects idempotently in the active conversation', () => {
  const first = source('msg:first');
  const selected = setMessageSelectionSource(null, 'conv:one', first, true);
  const selectedAgain = setMessageSelectionSource(selected, 'conv:one', first, true);

  assert.equal(selectedAgain?.conversationId, 'conv:one');
  assert.deepEqual([...selectedAgain!.sourcesByMessageId.keys()], ['msg:first']);
});

test('setMessageSelectionSource deselects and clears empty state', () => {
  const first = source('msg:first');
  const selected = setMessageSelectionSource(null, 'conv:one', first, true);
  const cleared = setMessageSelectionSource(selected, 'conv:one', first, false);

  assert.equal(cleared, null);
});

test('toggleMessageSelectionSource toggles without mutating previous state', () => {
  const first = source('msg:first');
  const previous = setMessageSelectionSource(null, 'conv:one', first, true) as MessageSelectionState;
  const toggled = toggleMessageSelectionSource(previous, 'conv:one', first);

  assert.equal(previous.sourcesByMessageId.has('msg:first'), true);
  assert.equal(toggled, null);
});
