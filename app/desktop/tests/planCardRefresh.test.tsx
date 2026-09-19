import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { CloudAuthClient, cloudMessageFromChatSync } from '../src/features/cloud/authClient';
import { buildCloudAuthError } from '../src/features/cloud/cloudAuthError';
import { planCardAction } from '../src/features/cloud/planCardClient';
import { cloudMessageRevision } from '../src/features/cloud/cloudMessageRevision';
import { mergeCloudMessageMonotonicState } from '../src/features/cloud/cloudMessageMerge';
import { PlanCardContent } from '../src/kordi-app/components/planCard';
import { saveSession } from '../src/features/cloud/session';
import type { MessagePlanCard } from '../src/kordi-app/types/message';
import { conversation, message } from './helpers/chatSyncCanonicalFixtures';
const card: MessagePlanCard = {
  eventId: 'plan-test', revision: 2, view: 'event', state: 'awaiting_confirmation',
  title: 'Dinner', unresolvedFields: [], options: [],
  participants: [{ participantId: 'acct_b', displayName: 'Member', organizer: true, rsvp: 'pending' }],
};
const refreshed: MessagePlanCard = { ...card, revision: 3, title: 'Updated dinner' };
const conflict = () => buildCloudAuthError(409, { errorCode: 'plan_card_revision_conflict', message: 'Stale revision' }, 'Failed');

test('plan-only changes survive equality checks; older messages cannot roll them back', () => {
  const original = { ...cloudMessageFromChatSync(message, conversation), planCard: card };
  const updated = mergeCloudMessageMonotonicState(original, { ...original, planCard: refreshed });
  assert.equal(updated.planCard?.revision, 3);
  assert.notEqual(cloudMessageRevision([original]), cloudMessageRevision([updated]));
  assert.equal(mergeCloudMessageMonotonicState({ ...updated, version: 3 }, original).planCard?.revision, 3);
});

test('in-place sync updates advance the plan without changing message identity', async () => {
  const incoming = { ...message, version: 3, content: { schema: 1, blocks: [{ type: 'plan_card', ...refreshed }] } };
  const client = new CloudAuthClient({ baseUrl: 'http://localhost', fetchImpl: async () => new Response(JSON.stringify({
    protocol_version: 2, events: [{ stream_seq: 45, event_id: 'event-update', protocol_version: 2,
      type: 'message.updated', conversation_id: conversation.id, entity_id: message.id,
      occurred_at: message.created_at, payload: { conversation, message: incoming } }],
    next_cursor: 'next', last_stream_seq: 45, has_more: false,
  })) });
  const result = await client.syncCloudEvents('test', 'cursor', 50);
  const updated = result.events.find((event) => event.eventType === 'message.upsert')?.payload.message;
  assert.ok(updated);
  assert.equal((updated as { planCard: MessagePlanCard }).planCard.revision, 3);
  assert.equal((updated as { messageId: string }).messageId, message.id);
});

test('conflicts fetch once without replaying confirmation', async (t) => {
  const calls: string[] = [];
  t.mock.method(CloudAuthClient.prototype, 'request', async (path: string, init: RequestInit) => {
    calls.push(`${init.method} ${path}`);
    if (init.method === 'POST') throw conflict();
    return refreshed;
  });
  assert.deepEqual(await planCardAction('test', { action: 'confirm', eventId: card.eventId, revision: 2, confirmedBy: 'acct_b' }), refreshed);
  assert.deepEqual(calls, ['POST /v1/cloud/plan_cards', 'GET /v1/cloud/plan_cards/plan-test']);
});

test('failed refresh and unrelated conflicts remain errors', async (t) => {
  let count = 0;
  t.mock.method(CloudAuthClient.prototype, 'request', async () => { if (++count === 1) throw conflict(); throw new Error('Offline'); });
  await assert.rejects(planCardAction('test', { action: 'confirm', eventId: card.eventId, revision: 2, confirmedBy: 'acct_b' }), /Offline/);
  assert.equal(count, 2);
  t.mock.restoreAll();
  t.mock.method(CloudAuthClient.prototype, 'request', async () => { throw buildCloudAuthError(409, { errorCode: 'plan_card_invalid_transition', message: 'Canceled' }, 'Failed'); });
  await assert.rejects(planCardAction('test', { action: 'confirm', eventId: card.eventId, revision: 2, confirmedBy: 'acct_b' }), /Canceled/);
});

test('pending actions freeze content, recover conflicts, and retain local state on failure', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const host = document.getElementById('root')!;
  const root = createRoot(host);
  let rejectRequest!: (reason: unknown) => void;
  t.mock.method(CloudAuthClient.prototype, 'request', async (_path: string, init: RequestInit) => {
    if (init.method === 'GET') return refreshed;
    return new Promise((_resolve, reject) => { rejectRequest = reject; });
  });
  try {
    await saveSession({ token: 'test', accountId: 'acct_b', expiresAt: '2099-01-01', deviceId: 'test' });
    await act(async () => root.render(<PlanCardContent card={card} ownAccountId="acct_b" />));
    const confirm = () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Confirm')!;
    await act(async () => confirm().click());
    const pendingMarkup = host.innerHTML;
    await act(async () => root.render(<PlanCardContent card={refreshed} ownAccountId="acct_b" />));
    assert.equal(host.innerHTML, pendingMarkup);
    assert.equal(host.querySelector('.app-plan-card-title')?.textContent, 'Dinner');
    assert.ok(confirm().disabled);
    await act(async () => rejectRequest(conflict()));
    assert.equal(host.querySelector('.app-plan-card-title')?.textContent, 'Updated dinner');
    assert.equal(host.querySelector('[role="status"]'), null);
    assert.equal(confirm().disabled, false);
    await act(async () => root.render(<PlanCardContent card={card} ownAccountId="acct_b" />));
    await act(async () => confirm().click());
    await act(async () => rejectRequest(new Error('Offline')));
    assert.equal(host.querySelector('.app-plan-card-title')?.textContent, 'Updated dinner');
    assert.equal(host.querySelector('[role="status"]')?.textContent, 'Offline');
  } finally {
    await act(async () => root.unmount());
    previous.forEach((descriptor, key) => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
    dom.window.close();
  }
});
