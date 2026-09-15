import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { createPinActivity, insertPinActivity } from '../src/pages/chatsPage.pinActivity';
import type { Message } from '../src/kordi-app/types';
import { installVirtualTranscriptHarness } from './support/virtualTranscriptHarness';

const activity = createPinActivity('pin-event', 'You pinned a message', '2026-09-14T12:30:00Z')!;
const earlier: Message = { id: 'earlier', role: 'person', sender: 'Peer', text: 'Earlier message', time: '12:00', timestampMs: Date.parse('2026-09-14T12:00:00Z') };
const later: Message = { ...earlier, id: 'later', text: 'Later message', time: '13:00', timestampMs: Date.parse('2026-09-14T13:00:00Z') };
const entries = (messages: Message[]) => messages.map((message, originalIndex) => ({ message, originalIndex }));

test('pin activity stays between earlier and later messages without changing their identities', () => {
  const before = entries([earlier]);
  assert.deepEqual(insertPinActivity(before, activity), [before[0], { pinActivity: activity }]);
  const after = entries([earlier, later]);
  const result = insertPinActivity(after, activity);
  assert.deepEqual(result, [after[0], { pinActivity: activity }, after[1]]);
  assert.equal(result[0], after[0]);
  assert.equal(result[2], after[1]);
  assert.deepEqual(insertPinActivity(entries([later]), activity), [{ pinActivity: activity }, entries([later])[0]]);
});

test('pin timestamps use the supplied event time and never invent a current time', () => {
  assert.equal(activity.timestampMs, Date.parse('2026-09-14T12:30:00Z'));
  assert.equal(createPinActivity('unknown', 'Someone pinned a message', null), null);
  assert.equal(createPinActivity('invalid', 'Someone pinned a message', 'invalid'), null);
  assert.deepEqual(insertPinActivity(entries([earlier]), null), entries([earlier]));
  assert.deepEqual(insertPinActivity([], activity), [{ pinActivity: activity }]);
});

test('the mounted transcript renders the pin with a timestamp before subsequently received messages', async () => {
  await installVirtualTranscriptHarness();
  const { useChatTranscriptViewport } = await import('../src/pages/chatsPage.transcriptViewport');
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 1800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 80 });
  function Transcript({ messages }: { messages: Message[] }) {
    return useChatTranscriptViewport({
      viewport: { sessionKey: 'pin-fixture', scrollRef: useRef(null), messages, scrollClassName: '', emptyState: null, composer: null },
      presentation: { liveTurnSender: 'Agent', shouldRenderLiveTurn: false, pinActivity: activity },
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
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
