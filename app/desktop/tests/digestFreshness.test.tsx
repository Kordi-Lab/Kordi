import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { digestClient } from '../src/features/digest/client';
import DigestPage from '../src/features/digest/DigestPage';
import { digestUpdatedLabel } from '../src/features/digest/freshness';
import type { DigestResponse } from '../src/features/digest/types';

test('the digest header says how long ago the digest was prepared', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  assert.equal(digestUpdatedLabel('2026-10-18T11:59:40Z', now), 'Updated just now');
  assert.equal(digestUpdatedLabel('2026-10-18T11:40:00Z', now), 'Updated 20 min ago');
  assert.equal(digestUpdatedLabel('2026-10-18T09:00:00Z', now), 'Updated 3 hr ago');
  assert.match(digestUpdatedLabel('2026-10-15T09:00:00Z', now), /^Updated \S+ \d+$|^Updated \d+ \S+$/);
  assert.equal(digestUpdatedLabel('not a date', now), 'Up to date');
});

test('opening the digest only reads it; the refresh button asks for one update', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const original = { ...digestClient };
  const response: DigestResponse = {
    accountId: 'viewer', status: 'ready', revision: 1, updatedAt: new Date(Date.now() - 20 * 60_000).toISOString(), partial: false, feedback: [],
    sources: [], snapshot: { claims: [], commitments: [], suggestions: [], calendarCandidates: [] },
  };
  let reads = 0, refreshes = 0;
  digestClient.read = async () => { reads++; return response; };
  digestClient.calendar = async () => ({ events: [] });
  digestClient.refresh = async () => { refreshes++; };
  const host = document.getElementById('root')!, root = createRoot(host);
  try {
    await act(async () => root.render(createElement(DigestPage, { accountId: 'freshness-viewer' })));
    assert.ok(reads >= 1);
    assert.equal(refreshes, 0, 'Opening the digest must not ask for an update');
    assert.match(host.querySelector('.digest-status')!.textContent!, /Updated 20 min ago/);
    assert.equal(host.querySelector('.digest-status [title]'), null, 'No helper text on the freshness line');
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Refresh digest"]')!;
    await act(async () => button.click());
    assert.equal(refreshes, 1);
  } finally {
    await act(async () => root.unmount());
    Object.assign(digestClient, original); Object.assign(globalThis, previous); dom.window.close();
  }
});
