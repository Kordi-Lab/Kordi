import assert from 'node:assert/strict';
import test from 'node:test';
import { messageBubblePropsEqual } from '../src/kordi-app/components/messageBubbleMemo';
import type { MessageBubbleProps } from '../src/kordi-app/components/transcript';

const previous: MessageBubbleProps = { msg: { id: 'one', role: 'user', text: 'Hello', time: '12:00' }, selectionMode: true, selectedMessageIds: new Set(), pinnedMessageIds: [] };

test('pinning or selecting another message does not rerender an unchanged bubble', () => {
  assert.equal(messageBubblePropsEqual(previous, { ...previous, selectedMessageIds: new Set(['two']), pinnedMessageIds: ['two'] }), true);
  assert.equal(messageBubblePropsEqual(previous, { ...previous, selectedMessageIds: new Set(['one']) }), false);
  assert.equal(messageBubblePropsEqual(previous, { ...previous, pinnedMessageIds: ['one'] }), false);
});

test('receipt, source, and thread callback changes must remain visible', () => {
  assert.equal(messageBubblePropsEqual(previous, { ...previous, msg: { ...previous.msg, statusChips: ['read'] } }), false);
  assert.equal(messageBubblePropsEqual(previous, { ...previous, onOpenSource: () => {} }), false);
  assert.equal(messageBubblePropsEqual(previous, { ...previous, onOpenMessageThread: () => {} }), false);
});
