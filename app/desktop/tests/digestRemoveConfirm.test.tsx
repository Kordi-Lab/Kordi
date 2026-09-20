import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { digestClient } from '../src/features/digest/client';
import DigestPage from '../src/features/digest/DigestPage';
import type { CalendarEvent, DigestResponse } from '../src/features/digest/types';

test('removing an event asks in a separate pop-up, keeps the page still, and shows invitation notes as text', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const original = { ...digestClient };
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const event: CalendarEvent = { id: 'calendar-zoom', title: 'Weekly sync', startAt: today.toISOString(), endAt: new Date(today.getTime() + 1_800_000).toISOString(), allDay: false, sourceIds: [], description: '<p>Join Zoom<br/>Meeting ID: 929&nbsp;2747</p>', revision: 1 };
  const response: DigestResponse = { accountId: 'viewer', status: 'ready', revision: 1, updatedAt: '2026-09-07T00:00:00Z', partial: false, feedback: [], sources: [], snapshot: { claims: [], commitments: [], suggestions: [], calendarCandidates: [] } };
  let removals = 0;
  let finishRemoval!: () => void;
  digestClient.read = async () => structuredClone(response);
  digestClient.calendar = async () => ({ events: removals ? [] : [event] });
  digestClient.removeEvent = async (account, target) => {
    assert.equal(account, 'viewer'); assert.equal(target.id, event.id); removals++;
    await new Promise<void>(resolve => { finishRemoval = resolve; });
  };
  const host = dom.window.document.getElementById('root')!, root = createRoot(host);
  const buttons = (label: string) => [...host.querySelectorAll('button')].filter(button => button.textContent === label);
  async function click(label: string) { const [button] = buttons(label); assert.ok(button, label); await act(async () => button.click()); }
  try {
    await act(async () => root.render(createElement(DigestPage, { accountId: 'viewer' })));
    const open = host.querySelector<HTMLButtonElement>('.digest-agenda-event');
    assert.ok(open, 'today\'s event is listed');
    await act(async () => open.click());
    const editor = host.querySelector('dialog.digest-sheet')!;
    assert.match(editor.querySelector('.digest-event-context')!.textContent!, /^Join Zoom\nMeeting ID: 929 2747$/);
    assert.doesNotMatch(editor.textContent!, /<br|&nbsp;/);

    await click('Remove event');
    const confirm = host.querySelector('dialog.digest-confirm');
    assert.ok(confirm, 'a separate confirmation dialog opens');
    assert.equal(confirm.getAttribute('role'), 'alertdialog');
    assert.equal(removals, 0, 'nothing is removed before confirming');
    assert.equal(buttons('Cancel').length, 1, 'the editor keeps one footer; the confirmation has its own buttons');
    await click('Keep event');
    assert.equal(host.querySelector('dialog.digest-confirm'), null);
    assert.equal(removals, 0);

    await click('Remove event');
    await click('Remove');
    assert.equal(removals, 1);
    assert.equal(host.querySelector('dialog'), null, 'both dialogs close once the removal starts');
    assert.match(host.querySelector('.digest-status')!.textContent!, /Saving changes…/, 'progress shows in the existing status line');
    assert.doesNotMatch(host.querySelector('.digest-notices')!.textContent!, /Saving changes/, 'no extra line pushes the page down');
    await act(async () => { finishRemoval(); await new Promise(resolve => setTimeout(resolve, 0)); });
  } finally {
    await act(async () => root.unmount());
    Object.assign(digestClient, original);
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
