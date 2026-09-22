import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { createPinActivity, insertPinActivities, type PinActivity } from '../src/pages/chatsPage.pinActivity';
import type { Message } from '../src/kordi-app/types';
import { installVirtualTranscriptHarness } from './support/virtualTranscriptHarness';

const activity = createPinActivity('pin-event', 'You pinned a message', '2026-09-14T12:30:00Z')!;
const earlier: Message = { id: 'earlier', role: 'person', sender: 'Peer', text: 'Earlier message', time: '12:00', timestampMs: Date.parse('2026-09-14T12:00:00Z') };
const later: Message = { ...earlier, id: 'later', text: 'Later message', time: '13:00', timestampMs: Date.parse('2026-09-14T13:00:00Z') };
const entries = (messages: Message[]) => messages.map((message, originalIndex) => ({ message, originalIndex }));

test('pin activity stays between earlier and later messages without changing their identities', () => {
  const before = entries([earlier]);
  assert.deepEqual(insertPinActivities(before, [activity]), [before[0], { pinActivity: activity }]);
  const after = entries([earlier, later]);
  const result = insertPinActivities(after, [activity]);
  assert.deepEqual(result, [after[0], { pinActivity: activity }, after[1]]);
  assert.equal(result[0], after[0]);
  assert.equal(result[2], after[1]);
  assert.deepEqual(insertPinActivities(entries([later]), [activity]), [{ pinActivity: activity }, entries([later])[0]]);
});

test('pin timestamps use the supplied event time and never invent a current time', () => {
  assert.equal(activity.timestampMs, Date.parse('2026-09-14T12:30:00Z'));
  assert.equal(createPinActivity('unknown', 'Someone pinned a message', null), null);
  assert.equal(createPinActivity('invalid', 'Someone pinned a message', 'invalid'), null);
  assert.deepEqual(insertPinActivities(entries([earlier]), []), entries([earlier]));
  assert.deepEqual(insertPinActivities([], [activity]), [{ pinActivity: activity }]);
});

test('older pin activity waits for its surrounding history page', () => {
  const latestPage = entries([later]);
  assert.deepEqual(insertPinActivities(latestPage, [activity], true), latestPage);
  const loadedHistory = entries([earlier, later]);
  assert.deepEqual(insertPinActivities(loadedHistory, [activity], true), [loadedHistory[0], { pinActivity: activity }, loadedHistory[1]]);
  assert.deepEqual(insertPinActivities(latestPage, [activity], false), [{ pinActivity: activity }, latestPage[0]]);
  assert.deepEqual(insertPinActivities([], [activity], true), []);
});

test('the mounted transcript renders the pin with a timestamp before subsequently received messages', async () => {
  await installVirtualTranscriptHarness();
  const { useChatTranscriptViewport } = await import('../src/pages/chatsPage.transcriptViewport');
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 1800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 80 });
  function Transcript({ messages, activities = [activity] }: { messages: Message[]; activities?: PinActivity[] }) {
    return useChatTranscriptViewport({
      viewport: { sessionKey: 'pin-fixture', scrollRef: useRef(null), messages, scrollClassName: '', emptyState: null, composer: null },
      presentation: { liveTurnSender: 'Agent', shouldRenderLiveTurn: false, pinActivities: activities },
      actions: { onOpenSource() {}, onOpenArtifact() {}, onOpenAuthSettings() {}, onStopCollaborationAgentRequest() {}, onStopActiveTurn() {} },
      selection: {}, transcriptMessages: messages, transcriptEntries: entries(messages), transcriptTailKey: messages.at(-1)?.id ?? '',
    });
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<Transcript messages={[earlier]} />); });
    const notice = host.querySelector('[data-pin-activity]');
    assert.ok(notice?.closest('[data-index]'), 'Activity must belong to a virtual timeline row, not the footer');
    assert.equal(notice.querySelector('time')?.getAttribute('datetime'), '2026-09-14T12:30:00.000Z');
    assert.ok(notice.querySelector('time')?.textContent);
    await act(async () => { root.render(<Transcript messages={[earlier, later]} />); });
    assert.equal(host.querySelector('[data-pin-activity]'), notice, 'New messages preserve the existing event row');
    const content = host.textContent!;
    assert.ok(content.indexOf('Earlier message') < content.indexOf('You pinned a message'));
    assert.ok(content.indexOf('You pinned a message') < content.indexOf('Later message'));
    assert.equal(host.querySelectorAll('[data-pin-activity]').length, 1);
    const unpin = { id: 'unpin-event', label: 'You unpinned a message', timestampMs: Date.parse('2026-09-14T13:30:00Z') };
    const newest = { ...later, id: 'newest', text: 'Newest message', timestampMs: Date.parse('2026-09-14T14:00:00Z') };
    await act(async () => { root.render(<Transcript messages={[earlier, later, newest]} activities={[activity, unpin, activity]} />); });
    assert.equal(host.querySelectorAll('[data-pin-activity]').length, 2);
    assert.equal(host.querySelector('[data-pin-activity]'), notice);
    const updated = host.textContent!;
    assert.ok(updated.indexOf('You pinned a message') < updated.indexOf('Later message'));
    assert.ok(updated.indexOf('Later message') < updated.indexOf('You unpinned a message'));
    assert.ok(updated.indexOf('You unpinned a message') < updated.indexOf('Newest message'));

  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('pin and unpin remain separate when events are replayed or snapshots arrive late', async () => {
  const { mergePinHistory, mergePinSnapshot } = await import('../src/features/cloud/cloudPinHistory');
  const pin = { id: 'event-pin', sequence: 10, sessionId: 'chat', kind: 'pinned' as const, scope: 'shared' as const, messageId: 'message', updatedByAccountId: 'owner', updatedAt: '2026-09-14T12:30:00Z' };
  const unpin = { ...pin, id: 'event-unpin', sequence: 11, kind: 'unpinned' as const, messageId: null, updatedAt: '2026-09-14T13:30:00Z' };
  assert.deepEqual(mergePinHistory([unpin, pin], [pin, unpin]), [pin, unpin]);
  const current = { sessionId: 'chat', sharedMessageId: null, privateMessageId: null, effectiveMessageId: null, updatedAt: unpin.updatedAt, history: [unpin] };
  const stale = { ...current, sharedMessageId: 'message', effectiveMessageId: 'message', updatedAt: pin.updatedAt, history: [pin] };
  const merged = mergePinSnapshot(current, stale);
  assert.equal(merged.effectiveMessageId, null);
  assert.deepEqual(merged.history, [pin, unpin]);
  const { insertPinActivities } = await import('../src/pages/chatsPage.pinActivity');
  const actions = [pin, unpin].map(event => ({ id: event.id, label: event.kind, timestampMs: Date.parse(event.updatedAt), sequence: event.sequence }));
  const last: Message = { ...later, id: 'last', timestampMs: Date.parse('2026-09-14T14:00:00Z') };
  assert.deepEqual(insertPinActivities(entries([earlier, later, last]), [...actions, actions[0]]).map(row => 'pinActivity' in row ? row.pinActivity.id : row.message.id), ['earlier', 'event-pin', 'later', 'event-unpin', 'last']);
});

test('fresh clients load every history page even after the current pin is cleared', async () => {
  const { CloudAuthClient } = await import('../src/features/cloud/authClient');
  const pin = { id: 'event-pin', sequence: 10, sessionId: 'chat', kind: 'pinned' as const, scope: 'private' as const, messageId: 'message', updatedByAccountId: 'owner', updatedAt: '2026-09-14T12:30:00Z' };
  const unpin = { ...pin, id: 'event-unpin', sequence: 11, kind: 'unpinned' as const, messageId: null, updatedAt: '2026-09-14T13:30:00Z' };
  const paths: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname + url.search);
    const response = url.pathname.endsWith('/pin')
      ? { pin: { sessionId: 'chat', sharedMessageId: null, privateMessageId: null, effectiveMessageId: null, updatedAt: unpin.updatedAt } }
      : url.searchParams.has('before') ? { events: [pin], nextBefore: null } : { events: [unpin], nextBefore: 11 };
    return new Response(JSON.stringify(response), { status: 200 });
  };
  for (let launch = 0; launch < 2; launch += 1) {
    const client = new CloudAuthClient({ baseUrl: 'http://test.local', fetchImpl });
    const state = await client.getCloudSessionPin('synthetic', 'chat');
    assert.equal(state.effectiveMessageId, null);
    assert.deepEqual(state.history, [pin, unpin]);
  }
  assert.equal(paths.filter(path => path.endsWith('before=11')).length, 2);
});

test('a completed local mutation cannot mask pin state arriving from another device', async () => {
  await installVirtualTranscriptHarness();
  const { useChatPins } = await import('../src/pages/useChatPins');
  type PinState = import('../src/features/cloud/authClient').CloudSessionPin;
  const sessionId = 'session:group:history-fixture';
  const pin = { id: 'first', sequence: 1, sessionId, kind: 'pinned' as const, scope: 'private' as const, messageId: earlier.id!, updatedByAccountId: 'owner', updatedAt: '2026-01-01T10:00:00Z' };
  const unpin = { ...pin, id: 'second', sequence: 2, kind: 'unpinned' as const, messageId: null, updatedAt: '2026-01-01T10:01:00Z' };
  const remote = { ...pin, id: 'third', sequence: 3, updatedAt: '2026-01-01T10:02:00Z' };
  let state: ReturnType<typeof useChatPins>;
  let setRemote: () => void = () => {};
  function Harness() {
    const [cloudPin, setPin] = React.useState<PinState>({ sessionId, sharedMessageId: null, privateMessageId: null, effectiveMessageId: null, updatedAt: null, history: [] });
    setRemote = () => setPin({ ...cloudPin, privateMessageId: earlier.id!, effectiveMessageId: earlier.id!, updatedAt: remote.updatedAt, history: [pin, unpin, remote] });
    state = useChatPins({
      conversation: { id: sessionId, collaborationSources: [], canonicalParticipants: [] } as unknown as import('../src/kordi-app/types').Conversation,
      sessionId, messages: [earlier], isGroupSession: true, currentAccountId: 'owner', cloudPin,
      onNavigateToMessage() {},
      onUpdateCloudPin: async ({ messageId }) => {
        const event = messageId ? pin : unpin;
        const updated: PinState = { ...cloudPin, privateMessageId: messageId, effectiveMessageId: messageId, updatedAt: event.updatedAt, history: messageId ? [pin] : [pin, unpin] };
        setPin(updated);
        return updated;
      },
    });
    return null;
  }
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<Harness />); });
    await act(async () => { state.requestPin(earlier); });
    await act(async () => { state.dialog.confirm(); });
    await act(async () => { state.requestUnpin(earlier, 'private'); });
    await act(async () => { state.dialog.confirm(); });
    assert.deepEqual(state!.pinActivities.map(event => event.label), ['You pinned a message', 'You unpinned a message']);
    await act(async () => { setRemote(); });
    assert.equal(state!.pinnedMessages.length, 1);
    assert.equal(state!.pinActivities.length, 3);
  } finally {
    await act(async () => root.unmount()); host.remove();
  }
});

test('local pin feedback appears before delayed sync, reconciles once, and rolls back failed actions', async () => {
  await installVirtualTranscriptHarness();
  const { useChatPins } = await import('../src/pages/useChatPins');
  const { PinActivityNotice } = await import('../src/pages/chatsPage.pins');
  type Pin = import('../src/features/cloud/authClient').CloudSessionPin;
  const sessionId = 'session:group:pending-pin';
  let state!: ReturnType<typeof useChatPins>;
  let resolve!: (pin: Pin) => void;
  let reject!: (error: Error) => void;
  let applyPin!: (pin: Pin) => void;
  const empty: Pin = { sessionId, sharedMessageId: null, privateMessageId: null, effectiveMessageId: null, updatedAt: null };
  function Harness() {
    const [cloudPin, setPin] = React.useState(empty);
    applyPin = setPin;
    state = useChatPins({ conversation: { id: sessionId, collaborationSources: [] } as unknown as import('../src/kordi-app/types').Conversation,
      messages: [earlier], sessionId, isGroupSession: true, currentAccountId: 'owner', cloudPin,
      onNavigateToMessage() {}, onUpdateCloudPin: () => new Promise<Pin>((yes, no) => { resolve = yes; reject = no; }),
    });
    return <>{state.pinActivities.map(activity => <PinActivityNotice key={activity.id} activity={activity} />)}</>;
  }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => state.requestPin(earlier));
    await act(async () => state.dialog.confirm());
    assert.equal(state.pinActivities.length, 1, 'Immediate feedback must not wait for a sync response');
    const localId = state.pinActivities[0].id;
    const localRow = host.querySelector('[data-pin-activity]');
    const pinned = { ...empty, privateMessageId: earlier.id!, effectiveMessageId: earlier.id!, updatedAt: new Date().toISOString() };
    await act(async () => { applyPin(pinned); resolve(pinned); });
    assert.equal(state.pinActivities.length, 1, 'Legacy mutation response must not remove its notice');
    await act(async () => applyPin({ ...pinned, history: [{ id: 'synced-event', sessionId, kind: 'pinned', scope: 'private', messageId: earlier.id!, updatedByAccountId: 'owner', updatedAt: pinned.updatedAt }] }));
    assert.deepEqual(state.pinActivities.map(item => item.id), [localId]);
    assert.equal(host.querySelector('[data-pin-activity]'), localRow, 'Server confirmation must update the same row without restarting its entrance');
    await act(async () => state.requestUnpin(earlier, 'private'));
    await act(async () => state.dialog.confirm());
    assert.equal(state.pinActivities.length, 2);
    await act(async () => reject(new Error('Synthetic offline failure')));
    assert.deepEqual(state.pinActivities.map(item => item.label), ['You pinned a message']);
    await act(async () => applyPin({ ...pinned, privateMessageId: 'older-unloaded-target', effectiveMessageId: 'older-unloaded-target' }));
    assert.equal(state.pinnedMessages.length, 1, 'A known pin must not wait for its target page before showing the shelf');
    assert.equal(state.pinnedMessages[0].message.id, 'older-unloaded-target');
    await act(async () => applyPin(empty));
    await act(async () => state.requestPin(earlier));
    await act(async () => state.dialog.confirm());
    assert.equal(state.pinActivities.length, 1);
    await act(async () => { applyPin({ ...pinned, history: [] }); resolve({ ...pinned, history: [] }); });
    assert.equal(state.pinActivities.length, 0, 'Authoritative no-op confirmation removes the temporary notice');
  } finally { await act(async () => root.unmount()); host.remove(); }
});
