import assert from 'node:assert/strict';
import test from 'node:test';

import { formatSelectedMessagesForCopy, hasMessageSelectionDragExceededThreshold, selectAllMessageSources, setMessageSelectionSource, toggleMessageSelectionSource, type MessageSelectionState } from '../src/features/chat/messageSelection';
import type { ForwardMessageSource } from '../src/features/chat/messageActionMetadata';

const source = (id: string): ForwardMessageSource => ({
  sourceSessionId: 'session:one',
  sourceMessageId: id,
  senderLabel: 'Alice',
  textPreview: id,
  attachmentCount: 0,
  attachments: [],
  attachmentOnly: false,
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

test('formatSelectedMessagesForCopy copies sender-prefixed messages in order', () => {
  assert.equal(formatSelectedMessagesForCopy([
    { ...source('msg:first'), senderLabel: 'Alice', textPreview: 'hello' },
    { ...source('msg:second'), senderLabel: 'Bob', textPreview: 'two\nlines' },
    { ...source('msg:third'), senderLabel: 'Carol', textPreview: '', attachmentCount: 2 },
  ]), 'Alice: hello\nBob: two\nlines\nCarol: [2 attachments]');
});

test('hasMessageSelectionDragExceededThreshold ignores clicks and tiny pointer drift', () => {
  assert.equal(hasMessageSelectionDragExceededThreshold({ x: 10, y: 10 }, { x: 10, y: 10 }), false);
  assert.equal(hasMessageSelectionDragExceededThreshold({ x: 10, y: 10 }, { x: 13, y: 13 }), false);
  assert.equal(hasMessageSelectionDragExceededThreshold({ x: 10, y: 10 }, { x: 17, y: 10 }), true);
});

test('toggleMessageSelectionSource toggles without mutating previous state', () => {
  const first = source('msg:first');
  const previous = setMessageSelectionSource(null, 'conv:one', first, true) as MessageSelectionState;
  const toggled = toggleMessageSelectionSource(previous, 'conv:one', first);

  assert.equal(previous.sourcesByMessageId.has('msg:first'), true);
  assert.equal(toggled, null);
});

test('selectAllMessageSources selects every eligible message and de-duplicates ids', () => {
  const selected = selectAllMessageSources('conv:one', [
    source('msg:first'),
    source('msg:second'),
    { ...source('msg:first'), textPreview: 'latest source wins' },
  ]);

  assert.equal(selected?.conversationId, 'conv:one');
  assert.deepEqual([...selected!.sourcesByMessageId.keys()], ['msg:first', 'msg:second']);
  assert.equal(selected?.sourcesByMessageId.get('msg:first')?.textPreview, 'latest source wins');
  assert.equal(selectAllMessageSources('conv:one', []), null);
});
