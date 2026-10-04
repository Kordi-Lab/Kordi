import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Conversation, Message } from '../src/kordi-app/types';
import type { CloudSessionPin } from '../src/features/cloud/cloudSessionPinTypes';
import { applyCloudSyncEventsToSessionPins } from '../src/features/cloud/cloudDiffSync';
import { mergePinSyncSnapshot } from '../src/features/cloud/cloudPinHistory';
import { installVirtualTranscriptHarness } from './support/virtualTranscriptHarness';

const sessionId = 'session:group:pin-stack';
const messages: Message[] = Array.from({ length: 6 }, (_, index) => ({ id: `message-${index}`, role: 'person', sender: 'Peer', text: `Message ${index}`, time: '12:00' }));
const empty: CloudSessionPin = { sessionId, sharedMessageId: null, privateMessageId: null, effectiveMessageId: null, updatedAt: null };

test('pin arrays survive targeted unpin sync and a concurrent snapshot with an unchanged latest ID', () => {
  const original = { ...empty, sharedMessageId: 'last', effectiveMessageId: 'last', sharedMessageIds: ['first', 'middle', 'last'], updatedAt: '2026-09-15T10:00:00Z' };
  const event = { eventId: 'unpin-middle', eventType: 'session.pin.updated', messageId: 'last', peerAccountId: null, occurredAt: '2026-09-15T10:01:00Z',
    payload: { sessionId, scope: 'shared', messageId: 'last', messageIds: ['first', 'last'], targetMessageId: 'middle', kind: 'unpinned', updatedByAccountId: 'owner', updatedAt: '2026-09-15T10:01:00Z' } };
  const baseline = { [sessionId]: original };
  const updated = applyCloudSyncEventsToSessionPins(baseline, [event]);
  assert.deepEqual(updated[sessionId].sharedMessageIds, ['first', 'last']);
  assert.equal(updated[sessionId].lastAction?.kind, 'unpinned');
  assert.equal(updated[sessionId].lastAction?.messageId, 'middle');
  assert.deepEqual(mergePinSyncSnapshot(updated, baseline, baseline)[sessionId].sharedMessageIds, ['first', 'last']);
  const cleared = applyCloudSyncEventsToSessionPins(updated, [{ ...event, eventId: `bootstrap:session-pin:${sessionId}:shared`, payload: { ...event.payload, messageIds: [], messageId: null } }]);
  assert.deepEqual(cleared[sessionId].sharedMessageIds, []);
  assert.equal(cleared[sessionId].effectiveMessageId, null);
});

test('local chat retains five ordered pins, rejects a sixth, and removes only the selected message', async () => {
  await installVirtualTranscriptHarness();
  const { useChatPins } = await import('../src/pages/useChatPins');
  let state!: ReturnType<typeof useChatPins>;
  function Harness() {
    state = useChatPins({ conversation: { id: 'local', collaborationSources: [] } as unknown as Conversation, messages, sessionId: 'local', isGroupSession: false, onNavigateToMessage() {} });
    return null;
  }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness />));
    for (const message of messages) {
      await act(async () => state.requestPin(message));
      await act(async () => state.dialog.confirm());
    }
    assert.deepEqual(state.pinnedMessageIds, messages.slice(0, 5).map(message => message.id));
    assert.match(state.dialog.error!, /At most five/);
    assert.equal(state.pinActivities.length, 5);
    await act(async () => state.requestUnpin(messages[2], 'private'));
    await act(async () => state.dialog.confirm());
    assert.deepEqual(state.pinnedMessageIds, ['message-0', 'message-1', 'message-3', 'message-4']);
    await act(async () => state.requestPin(messages[5]));
    await act(async () => state.dialog.confirm());
    assert.deepEqual(state.pinnedMessageIds, ['message-0', 'message-1', 'message-3', 'message-4', 'message-5']);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test('cloud pinning adds to the scope and targeted unpin preserves other pins, with visible rollback errors', async () => {
  await installVirtualTranscriptHarness();
  const { useChatPins } = await import('../src/pages/useChatPins');
  let state!: ReturnType<typeof useChatPins>;
  const requests: unknown[] = [];
  let fail = false;
  function Harness() {
    const [cloudPin, setPin] = React.useState<CloudSessionPin>({ ...empty, sharedMessageIds: ['message-0', 'message-1'], sharedMessageId: 'message-1', privateMessageIds: ['message-2'], privateMessageId: 'message-2' });
    state = useChatPins({ conversation: { id: sessionId, collaborationSources: [] } as unknown as Conversation, sessionId, messages, isGroupSession: true, cloudPin, currentAccountId: 'owner', onNavigateToMessage() {},
      onUpdateCloudPin: async input => {
        requests.push(input);
        if (fail) throw new Error('Synthetic pin failure');
        const field = input.scope === 'shared' ? 'sharedMessageIds' : 'privateMessageIds';
        const ids = cloudPin[field] ?? [];
        const next = input.action === 'unpin' ? ids.filter(id => id !== input.messageId) : [...ids, input.messageId!];
        const updated = { ...cloudPin, [field]: next, [input.scope === 'shared' ? 'sharedMessageId' : 'privateMessageId']: next[next.length - 1] ?? null };
        setPin(updated);
        return updated;
      },
    });
    return null;
  }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => state.requestUnpin(messages[0], 'shared'));
    await act(async () => state.dialog.confirm());
    assert.deepEqual(requests[0], { sessionId, messageId: 'message-0', scope: 'shared', action: 'unpin' });
    assert.deepEqual(state.pinnedMessageIds, ['message-1', 'message-2']);
    await act(async () => state.requestPin(messages[3]));
    await act(async () => state.dialog.confirm());
    assert.deepEqual(state.pinnedMessageIds, ['message-1', 'message-2', 'message-3']);
    fail = true;
    await act(async () => state.requestPin(messages[4]));
    await act(async () => state.dialog.confirm());
    assert.deepEqual(state.pinnedMessageIds, ['message-1', 'message-2', 'message-3']);
    assert.equal(state.dialog.error, 'Synthetic pin failure');
    assert.equal(state.dialog.value?.message.id, 'message-4');
  } finally { await act(async () => root.unmount()); host.remove(); }
});
