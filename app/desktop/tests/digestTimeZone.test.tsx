import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { digestClient } from '../src/features/digest/client';
import DigestPage from '../src/features/digest/DigestPage';
import { formatDesktopShortDateTime } from '../src/lib/time';
import type { DigestResponse } from '../src/features/digest/types';

// 04:45 UTC on Oct 17 is 9:45 PM on Oct 16 in Los Angeles and 12:45 AM on Oct 17 in New York.
const updatedAt = '2026-10-17T04:45:00Z';

test('digest freshness time formats the UTC instant in the given device timezone', () => {
  assert.match(formatDesktopShortDateTime(updatedAt, { timeZone: 'America/Los_Angeles' }), /^Oct 16, 9:45\sPM$/);
  assert.match(formatDesktopShortDateTime(updatedAt, { timeZone: 'America/New_York' }), /^Oct 17, 12:45\sAM$/);
  assert.match(formatDesktopShortDateTime(Date.parse(updatedAt), { timeZone: 'Asia/Riyadh' }), /^Oct 17, 7:45\sAM$/);
});

test('digest header follows the device timezone after it changes while the page stays open', async () => {
  const originalTimeZone = process.env.TZ;
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const original = { ...digestClient };
  const digest: DigestResponse = {
    accountId: 'timezone-viewer', status: 'ready', revision: 1, updatedAt, partial: false, feedback: [], sources: [],
    snapshot: { claims: [], commitments: [], suggestions: [], calendarCandidates: [] },
  };
  digestClient.read = async () => digest;
  digestClient.calendar = async () => ({ events: [] });
  digestClient.refresh = async () => {};
  const host = document.getElementById('root')!, root = createRoot(host);
  const status = () => host.querySelector('.digest-status')!.textContent!;
  try {
    process.env.TZ = 'America/New_York';
    await act(async () => root.render(createElement(DigestPage, { accountId: 'timezone-viewer' })));
    assert.match(status(), /Updated Oct 17, 12:45\sAM/);

    process.env.TZ = 'America/Los_Angeles';
    await act(async () => dom.window.dispatchEvent(new dom.window.Event('focus')));
    assert.match(status(), /Updated Oct 16, 9:45\sPM/);
  } finally {
    await act(async () => root.unmount());
    Object.assign(digestClient, original);
    Object.assign(globalThis, previous);
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
    dom.window.close();
  }
});
