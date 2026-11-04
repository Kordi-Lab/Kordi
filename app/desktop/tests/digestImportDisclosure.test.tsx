import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import DigestPage from '../src/features/digest/DigestPage';
import { digestClient } from '../src/features/digest/client';
import { installDom } from './helpers/transcriptAttachmentDom';

test('Calendar link import keeps native disclosure semantics and a small decorative chevron', async () => {
  const { dom, restore } = installDom();
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const original = { ...digestClient };
  digestClient.read = async () => ({ accountId: 'synthetic-import', status: 'ready', revision: 1,
    updatedAt: '2026-11-03T00:00:00Z', partial: false, feedback: [], sources: [],
    snapshot: { claims: [], commitments: [], suggestions: [], calendarCandidates: [] } });
  digestClient.calendar = async () => ({ events: [] });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<DigestPage accountId="synthetic-import" />));
    const importButton = [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Import ICS');
    assert.ok(importButton);
    await act(async () => importButton.click());
    const details = host.querySelector<HTMLDetailsElement>('dialog details')!;
    assert.ok(details);
    assert.equal(details.open, false);
    const summary = details.querySelector('summary')!;
    assert.equal(summary.textContent, 'Import from a calendar link');
    assert.equal(summary.querySelector('svg')?.getAttribute('width'), '14');
    assert.equal(summary.querySelector('svg')?.getAttribute('aria-hidden'), 'true');
    await act(async () => summary.click());
    assert.equal(details.open, true);
    assert.ok(details.querySelector('input[type="url"]'));
    await act(async () => summary.click());
    assert.equal(details.open, false);
  } finally {
    await act(async () => root.unmount()); Object.assign(digestClient, original); restore();
  }
});
