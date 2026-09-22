import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageForwardDialog } from '../src/pages/MessageForwardDialog';
import { installDom } from './helpers/transcriptAttachmentDom';
import type { ForwardDestination } from '../src/features/chat/messageForwarding';

const source = { sourceSessionId: 'source', sourceMessageId: 'message', senderLabel: 'Alice', textPreview: 'A useful message', attachmentCount: 0, attachments: [], attachmentOnly: false };
const destinations: ForwardDestination[] = [
  { id: 'group', conversationId: 'group', label: 'General', subtitle: 'Group chat', parentLabel: 'Product team', kind: 'group' },
  { id: 'person', conversationId: 'person', label: 'Maya Chen', subtitle: 'Direct message', kind: 'person' },
];

test('forward dialog requires explicit selection, contains focus, and waits for successful sending', async () => {
  const { dom, restore } = installDom();
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
  const opener = document.createElement('button'); document.body.append(opener); opener.focus();
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let calls = 0;
  let closes = 0;
  let complete!: () => void;
  const sent = new Promise<void>((resolve) => { complete = resolve; });
  const button = (text: string) => [...document.querySelectorAll('button')].find((item) => item.textContent === text)!;
  try {
    await act(async () => root.render(<MessageForwardDialog sources={[source]} destinations={destinations} sourceLabel="Design team › Review" onClose={() => { closes++; }} onForward={async () => { calls++; await sent; }} />));
    assert.equal(button('Forward').disabled, true);
    assert.equal(document.activeElement?.id, 'forward-search');
    assert.doesNotMatch(document.body.textContent!, /Choose where to send it|Most recent first/);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-message-forward-destination="group"]')!.click());
    assert.equal(button('Forward').disabled, false);
    assert.match(document.querySelector('.forward-selection-summary')!.textContent!, /Product team › General/);
    await act(async () => button('People').click());
    assert.equal(document.querySelectorAll('[data-message-forward-destination]').length, 1);
    assert.match(document.querySelector('.forward-selection-summary')!.textContent!, /Product team › General/);
    const input = document.querySelector<HTMLInputElement>('#forward-search')!;
    input.focus();
    await act(async () => input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    assert.equal(calls, 0);
    button('Forward').focus();
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    assert.equal(document.activeElement?.getAttribute('aria-label'), 'Close forward dialog');
    await act(async () => { button('Forward').click(); });
    assert.equal(calls, 1);
    assert.equal(button('Forwarding…').disabled, true);
    assert.equal(button('Done'), undefined);
    await act(async () => complete());
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /^Message forwarded$/);
    assert.equal(button('Done'), undefined);
    assert.equal(document.activeElement, document.querySelector('.forward-success'));
    assert.equal(closes, 0);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2250)); });
    assert.equal(closes, 1);
    await act(async () => root.unmount());
    assert.equal(document.activeElement, opener);
  } finally { await act(async () => root.unmount()); restore(); }
});

test('forward failure keeps selection and offers retry instead of reporting success', async () => {
  const { dom, restore } = installDom();
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let attempts = 0;
  const button = (text: string) => [...document.querySelectorAll('button')].find((item) => item.textContent === text)!;
  try {
    await act(async () => root.render(<MessageForwardDialog sources={[source]} destinations={destinations} onClose={() => {}} onForward={async () => { if (++attempts === 1) throw new Error('Connection lost. Try again.'); }} />));
    await act(async () => document.querySelector<HTMLButtonElement>('[data-message-forward-destination="person"]')!.click());
    await act(async () => button('Forward').click());
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /Connection lost/);
    assert.equal(document.querySelector('[data-message-forward-destination="person"]')!.getAttribute('aria-pressed'), 'true');
    assert.equal(button('Done'), undefined);
    await act(async () => button('Try again').click());
    assert.equal(attempts, 2);
    assert.ok(document.querySelector('.forward-success'));
    assert.equal(button('Done'), undefined);
  } finally { await act(async () => root.unmount()); restore(); }
});
