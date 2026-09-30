import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import CompanionOverview from '../src/pages/chatsPage.companionOverview';
import { digestClient } from '../src/features/digest/client';
import type { CalendarEvent, DigestResponse } from '../src/features/digest/types';

test('companion calendar and digest reuse event editing, confirmation, links, source sheets, and feedback', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true, url: 'http://localhost' });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const original = { ...digestClient };
  const today = new Date(); today.setHours(12, 0, 0, 0);
  let event: CalendarEvent = { id: 'test-event', title: 'Design meeting', startAt: today.toISOString(), endAt: new Date(today.getTime() + 1800000).toISOString(), allDay: false, sourceIds: [], description: 'Join the meeting: https://example.zoom.us/j/123\nLong invitation instructions.', revision: 1 };
  const response: DigestResponse = { accountId: 'companion-test', status: 'ready', revision: 1, updatedAt: today.toISOString(), partial: false, feedback: [], sources: [{ id: 'source', conversationId: 'chat', sessionId: 'session', sessionTitle: 'Design discussion', senderAccountId: 'maya', senderName: 'Maya', text: 'The **design** is ready.', createdAt: today.toISOString(), version: 1 }], snapshot: { claims: [{ id: 'claim', title: 'Design ready', text: 'Ready for review.', kind: 'claim', sourceIds: ['source'] }], commitments: [], suggestions: [], calendarCandidates: [] } };
  let writes = 0, removals = 0;
  digestClient.read = async () => structuredClone(response);
  digestClient.calendar = async () => ({ events: [event] });
  digestClient.saveEvent = async (account, next) => { assert.equal(account, response.accountId); writes++; event = { ...next, revision: 2 }; return event; };
  digestClient.removeEvent = async () => { removals++; };
  digestClient.feedback = async (account, id, dismissed) => {
    assert.equal(account, response.accountId);
    response.feedback = dismissed ? [{ id, status: 'dismissed' }] : [];
  };
  const root = createRoot(document.getElementById('root')!);
  const click = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label);
    assert.ok(button, label); await act(async () => button.click());
  };
  try {
    await act(async () => root.render(<CompanionOverview accountId={response.accountId} view="calendar" onClose={() => {}} />));
    assert.doesNotMatch(document.querySelector('.app-companion-agenda')!.textContent!, /Long invitation instructions/);
    assert.equal(document.querySelector('.app-companion-agenda a')?.getAttribute('href'), 'https://example.zoom.us/j/123');
    await click('Open event Design meeting');
    assert.equal(document.querySelector('dialog h2')?.textContent, 'Edit event');
    assert.match(document.querySelector('dialog')!.textContent!, /Long invitation instructions/);
    assert.equal(writes, 0);
    await click('Save event');
    assert.equal(writes, 1);
    assert.equal(document.querySelector('dialog'), null);
    await click('Open event Design meeting');
    await click('Remove event');
    assert.ok(document.querySelector('dialog[role="alertdialog"]'));
    assert.equal(removals, 0);
    await act(async () => document.querySelector('dialog[role="alertdialog"]')!.dispatchEvent(new dom.window.Event('cancel', { bubbles: true, cancelable: true })));
    assert.equal(document.querySelector('dialog[role="alertdialog"]'), null);
    assert.ok(document.querySelector('dialog'), 'Escape closes only the confirmation, leaving the editor open');
    await click('Cancel');
    await act(async () => root.render(<CompanionOverview accountId={response.accountId} view="digest" onClose={() => {}} />));
    await click('View source messages');
    assert.equal(document.querySelector('dialog strong')?.textContent, 'design');
    await click('Close');
    await click('Dismiss Design ready');
    assert.equal(document.querySelector('.app-companion-digest-section h4'), null);
    await click('Restore dismissed entries');
    assert.equal(document.querySelector('.app-companion-digest-section h4')?.textContent, 'Design ready');
  } finally {
    await act(async () => root.unmount());
    Object.assign(digestClient, original); Object.assign(globalThis, previous); dom.window.close();
  }
});
