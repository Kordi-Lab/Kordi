import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { digestClient } from '../src/features/digest/client';
import { digestStoreFor } from '../src/features/digest/store';
import { scheduleDigestWarmup, useDigestWarmup } from '../src/features/digest/useDigestWarmup';
import { useDigest } from '../src/features/digest/useDigest';
import type { DigestResponse } from '../src/features/digest/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const result: DigestResponse = { accountId: 'viewer', revision: 1, status: 'ready', updatedAt: '2026-09-08T00:00:00Z', partial: false, feedback: [], sources: [], snapshot: { claims: [], suggestions: [], commitments: [], calendarCandidates: [] } };
function environment() {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  return { dom, cleanup: () => { Object.assign(globalThis, previous); dom.window.close(); } };
}

test('authenticated shell warms Digest before entry without blocking interactions or duplicating the route read', async () => {
  const { dom, cleanup } = environment(), original = { ...digestClient };
  const report = deferred<DigestResponse>(), started = deferred<void>();
  let reads = 0, calendars = 0;
  digestClient.read = () => { reads++; started.resolve(); return report.promise; };
  digestClient.calendar = async () => { calendars++; return { events: [] }; };
  function Route() { const { digest } = useDigest('viewer'); return createElement('p', null, digest ? 'Digest cached' : 'Loading'); }
  function Shell({ open = false }: { open?: boolean }) {
    useDigestWarmup('viewer');
    const [clicks, setClicks] = useState(0);
    return createElement('div', null, createElement('button', { onClick: () => setClicks(value => value + 1) }, `Clicks ${clicks}`), open ? createElement(Route) : null);
  }
  const host = document.getElementById('root')!, root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(Shell)); });
    await act(async () => { await started.promise; });
    assert.equal(reads, 1);
    assert.equal(host.querySelector('p'), null, 'Digest is not mounted yet');
    await act(async () => host.querySelector('button')!.click());
    assert.match(host.textContent!, /Clicks 1/);
    await act(async () => root.render(createElement(Shell, { open: true })));
    assert.equal(reads, 1, 'Entry joins the warmup already in progress');
    await act(async () => report.resolve(result));
    await act(async () => root.render(createElement(Shell)));
    await act(async () => root.render(createElement(Shell, { open: true })));
    assert.match(host.textContent!, /Digest cached/);
    assert.equal(reads, 1); assert.equal(calendars, 1);
    const routing = readFileSync(new URL('../src/app/MainContentSwitch.tsx', import.meta.url), 'utf8');
    assert.match(routing, /useDigestWarmup\(cloudSession\.account\?\.accountId\)/);
  } finally { await act(async () => root.unmount()); Object.assign(digestClient, original); cleanup(); }
});

test('warmup cancellation prevents late account work, foreground events are deduplicated and rate limited', async t => {
  const { dom, cleanup } = environment();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  const module = deferred<{ digestStoreFor: typeof digestStoreFor }>();
  let calls = 0;
  const load = async () => ({ digestStoreFor: (() => ({ refresh: async () => { calls++; } })) as unknown as typeof digestStoreFor });
  const stopped = scheduleDigestWarmup('old-account', () => module.promise);
  t.mock.timers.tick(0); stopped(); module.resolve(await load());
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 0);
  const stop = scheduleDigestWarmup('viewer', load);
  try {
    t.mock.timers.tick(0); await Promise.resolve(); await Promise.resolve();
    assert.equal(calls, 1);
    window.dispatchEvent(new dom.window.Event('focus'));
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    await Promise.resolve(); assert.equal(calls, 1);
    t.mock.timers.tick(30_001);
    window.dispatchEvent(new dom.window.Event('focus'));
    await Promise.resolve(); await Promise.resolve(); assert.equal(calls, 2);
    stop(); t.mock.timers.tick(30_001);
    window.dispatchEvent(new dom.window.Event('focus'));
    await Promise.resolve(); assert.equal(calls, 2);
  } finally { stop(); cleanup(); }
});
