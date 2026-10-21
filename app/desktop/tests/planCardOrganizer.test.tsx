import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { CloudAuthClient } from '../src/features/cloud/authClient';
import { saveSession } from '../src/features/cloud/session';
import { PlanCardContent } from '../src/kordi-app/components/planCard';
import type { MessagePlanCard } from '../src/kordi-app/types/message';

const card: MessagePlanCard = {
  eventId: 'plan-meet', revision: 4, view: 'event', state: 'awaiting_confirmation',
  title: 'Coffee', startAt: '2030-10-01T19:00:00-07:00', endAt: '2030-10-01T19:30:00-07:00', location: 'Cafe',
  unresolvedFields: [], options: [], managerIds: ['organizer'],
  participants: [
    { participantId: 'organizer', displayName: 'Ana', organizer: true, rsvp: 'yes' },
    { participantId: 'guest', displayName: 'Ben', organizer: false, rsvp: 'pending' },
  ],
};

function buttons(markup: string) {
  const dom = new JSDOM(markup);
  const found = [...dom.window.document.querySelectorAll('button')].map((button) => ({
    text: button.textContent?.trim() ?? '',
    pressed: button.getAttribute('aria-pressed'),
  }));
  dom.window.close();
  return found;
}

test('the organizer changes the time instead of answering', () => {
  const found = buttons(renderToStaticMarkup(<PlanCardContent card={card} ownAccountId="organizer" conversationId="conv-1" />));
  assert.ok(found.some((button) => button.text === 'Change time'));
  assert.ok(!found.some((button) => button.text === "I'm in" || button.text === "Can't make it"));
});

test('a participant who has not answered sees neither answer selected', () => {
  const found = buttons(renderToStaticMarkup(<PlanCardContent card={card} ownAccountId="guest" conversationId="conv-1" />));
  assert.deepEqual(found.filter((button) => button.pressed !== null).map((button) => [button.text, button.pressed]), [["Can't make it", 'false'], ["I'm in", 'false']]);
  assert.ok(!found.some((button) => button.text === 'Change time'));
});

test('a participant who answered yes sees I am in selected', () => {
  const answered = { ...card, participants: card.participants.map((participant) => ({ ...participant, rsvp: 'yes' as const })) };
  const found = buttons(renderToStaticMarkup(<PlanCardContent card={answered} ownAccountId="guest" conversationId="conv-1" />));
  assert.equal(found.find((button) => button.text === "I'm in")?.pressed, 'true');
  assert.equal(found.find((button) => button.text === "Can't make it")?.pressed, 'false');
});

test('change time revises the card with the new start and end', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const host = document.getElementById('root')!;
  const root = createRoot(host);
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(CloudAuthClient.prototype, 'request', async (_path: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return { ...card, revision: 5, startAt: '2030-10-02T02:15:00Z', endAt: '2030-10-02T02:45:00Z' };
  });
  const click = async (label: string) => {
    const button = [...document.body.querySelectorAll('button')].find((item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label);
    assert.ok(button, `missing ${label}`);
    await act(async () => button.click());
  };
  try {
    await saveSession({ token: 'test', accountId: 'organizer', expiresAt: '2099-01-01', deviceId: 'test' });
    await act(async () => root.render(<PlanCardContent card={card} ownAccountId="organizer" conversationId="conv-1" />));
    await click('Change time');
    assert.equal((document.body.querySelector('.cg-meet-input') as HTMLInputElement).value, 'Coffee');
    await click('Next time');
    await click('Save');
    assert.equal(bodies.length, 1);
    assert.deepEqual(bodies[0], {
      action: 'propose', conversationId: 'conv-1', existingEventId: 'plan-meet', existingRevision: 4, title: 'Coffee',
      startAt: '2030-10-02T02:15:00.000Z', endAt: '2030-10-02T02:45:00.000Z', location: 'Cafe', state: 'awaitingConfirmation',
      unresolvedFields: [],
      participants: [
        { participantId: 'organizer', displayName: 'Ana', organizer: true },
        { participantId: 'guest', displayName: 'Ben', organizer: false },
      ],
    });
    assert.equal(document.body.querySelector('.cg-meet'), null);
  } finally {
    await act(async () => root.unmount());
    previous.forEach((descriptor, key) => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
    dom.window.close();
  }
});
