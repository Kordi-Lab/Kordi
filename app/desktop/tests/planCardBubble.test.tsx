import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { MessageBubble } from '../src/kordi-app/components/transcript';
import type { Message, MessagePlanCard } from '../src/kordi-app/types';

const planCard: MessagePlanCard = {
  eventId: 'plan-bubble', revision: 1, view: 'event', state: 'awaiting_confirmation',
  title: 'Dinner', startAt: '2030-10-01T19:00:00-07:00', unresolvedFields: [], options: [],
  participants: [{ participantId: 'acct_a', displayName: 'Me', organizer: true, rsvp: 'pending' }],
};
const own: Message = { role: 'user', sender: 'Me', senderType: 'human', isOwnMessage: true, text: '', time: '10:00', planCard };
const peer: Message = { ...own, sender: 'Sam', isOwnMessage: false, role: 'person' };

async function render(msg: Message) {
  const dom = new JSDOM('<div class="kordi-app"><div id="root"></div></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  await act(async () => { root.render(createElement(MessageBubble, { msg })); });
  const result = {
    card: Boolean(host.querySelector('.app-plan-card')),
    user: Boolean(host.querySelector('.app-chat-bubble-user')),
    peer: Boolean(host.querySelector('.app-chat-bubble-peer')),
  };
  await act(async () => { root.unmount(); });
  return result;
}

test('plan-card-only messages render without a sent or received bubble', async () => {
  assert.deepEqual(await render(own), { card: true, user: false, peer: false });
  assert.deepEqual(await render(peer), { card: true, user: false, peer: false });
});

test('a plan card with text keeps the bubble', async () => {
  assert.deepEqual(await render({ ...own, text: 'See you there' }), { card: true, user: true, peer: false });
  assert.deepEqual(await render({ ...peer, text: 'See you there' }), { card: true, user: false, peer: true });
});
