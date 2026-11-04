import assert from 'node:assert/strict';
import test from 'node:test';
import React, { Activity, act } from 'react';
import { createRoot } from 'react-dom/client';
import { Calendar, MessageCircle } from 'lucide-react';
import { CompanionDocumentTabs } from '../src/features/documents/CompanionDocumentTabs';
import DigestPage from '../src/features/digest/DigestPage';
import { digestClient } from '../src/features/digest/client';
import { installDom } from './helpers/transcriptAttachmentDom';

const tabs = [
  { id: 'chat', title: 'Chat', icon: MessageCircle },
  { id: 'calendar', title: 'Calendar', icon: Calendar },
];

test('companion shortcuts leave native dialogs, ARIA dialogs, and alert dialogs in control', async () => {
  const { dom, restore } = installDom();
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const activated: string[] = [];
  try {
    await act(async () => root.render(<>
      <CompanionDocumentTabs documents={[]} titles={{}} extraTabs={tabs} activeId="calendar"
        onActivate={id => activated.push(id)} onCloseTab={() => {}} onHide={() => {}} />
      <dialog open><button>Native dialog action</button></dialog>
      <div role="dialog"><button>Dialog action</button></div>
      <div role="alertdialog"><button>Confirmation action</button></div>
      <button data-outside>Outside action</button>
    </>));
    for (const selector of ['dialog button', '[role="dialog"] button', '[role="alertdialog"] button']) {
      const button = host.querySelector<HTMLButtonElement>(selector)!;
      button.focus();
      const event = new dom.window.KeyboardEvent('keydown', { code: 'Digit1', altKey: true, bubbles: true, cancelable: true });
      await act(async () => button.dispatchEvent(event));
      assert.deepEqual(activated, [], `${selector} must not switch the underlying tab`);
      assert.equal(event.defaultPrevented, false, 'The dialog retains ownership of the key');
      assert.equal(document.activeElement, button);
    }
    const event = new dom.window.KeyboardEvent('keydown', { code: 'Digit1', altKey: true, bubbles: true, cancelable: true });
    await act(async () => host.querySelector<HTMLButtonElement>('[data-outside]')!.dispatchEvent(event));
    assert.deepEqual(activated, ['chat'], 'The normal shortcut still selects a tab');
    assert.equal(event.defaultPrevented, true);
  } finally {
    await act(async () => root.unmount()); restore();
  }
});

test('Calendar import blocks tab shortcuts and closes its retained modal when Activity hides', async () => {
  const { dom, restore } = installDom();
  const closes: { connected: boolean; focusedInside: boolean }[] = [];
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () {
    closes.push({ connected: this.isConnected, focusedInside: this.contains(document.activeElement) });
    this.open = false;
  };
  const original = { ...digestClient };
  digestClient.read = async () => ({ accountId: 'synthetic-modal', status: 'ready', revision: 1,
    updatedAt: '2026-11-03T00:00:00Z', partial: false, feedback: [], sources: [],
    snapshot: { claims: [], commitments: [], suggestions: [], calendarCandidates: [] } });
  digestClient.calendar = async () => ({ events: [] });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const activated: string[] = [];
  const render = (mode: 'visible' | 'hidden') => <>
    <CompanionDocumentTabs documents={[]} titles={{}} extraTabs={tabs} activeId="calendar"
      onActivate={id => activated.push(id)} onCloseTab={() => {}} onHide={() => {}} />
    <Activity mode={mode}><DigestPage accountId="synthetic-modal" /></Activity>
  </>;
  try {
    await act(async () => root.render(render('visible')));
    const importButton = [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Import ICS')!;
    assert.ok(importButton);
    await act(async () => importButton.click());
    const dialog = host.querySelector<HTMLDialogElement>('dialog')!;
    assert.equal(dialog.open, true);
    const close = dialog.querySelector<HTMLButtonElement>('header button')!;
    close.focus();
    await act(async () => close.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      code: 'Digit1', altKey: true, bubbles: true, cancelable: true,
    })));
    assert.deepEqual(activated, [], 'A shortcut from the real Calendar sheet cannot activate Chat');
    const details = dialog.querySelector('details')!;
    await act(async () => details.querySelector('summary')!.click());
    assert.equal(details.open, true);
    await act(async () => root.render(render('hidden')));
    assert.equal(dialog.isConnected, true, 'Activity retains the Calendar DOM');
    assert.equal(dialog.open, false, 'A hidden Calendar cannot retain an open modal');
    assert.deepEqual(closes, [{ connected: true, focusedInside: false }], 'Cleanup blurs before closing the retained dialog');
    await act(async () => root.render(render('visible')));
    assert.equal(host.querySelector('dialog'), dialog);
    assert.equal(dialog.open, true, 'Returning to Calendar restores its sheet');
    assert.equal(details.open, true, 'The retained import disclosure keeps its state');
    close.focus();
    await act(async () => close.click());
    assert.equal(host.querySelector('dialog'), null);
    assert.equal(dialog.open, false, 'Closing the sheet also releases the native modal');
    assert.equal(closes.length, 2);
  } finally {
    await act(async () => root.unmount()); Object.assign(digestClient, original); restore();
  }
});
