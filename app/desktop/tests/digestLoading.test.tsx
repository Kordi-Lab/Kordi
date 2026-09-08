import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { digestClient } from '../src/features/digest/client';
import { DigestStore, digestStoreFor } from '../src/features/digest/store';
import { CLOUD_SESSION_CHANGED_EVENT } from '../src/features/cloud/session';
import type { DigestResponse } from '../src/features/digest/types';

const css = registerHooks({ load(url, context, next) {
  return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
const { default: DigestPage } = await import('../src/features/digest/DigestPage');
css.deregister();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response(accountId = 'viewer'): DigestResponse {
  return {
    accountId, status: 'ready', revision: 1, updatedAt: '2026-09-08T00:00:00Z', partial: false, feedback: [],
    sources: [{ id: 'source', conversationId: 'conversation', sessionId: 'session', sessionTitle: 'Planning', senderAccountId: accountId, senderName: 'Viewer', text: 'Already loaded source message.', createdAt: '2026-09-08T00:00:00Z', version: 1 }],
    snapshot: { claims: [{ id: 'claim', title: 'Prepared draft', text: 'Ready for review.', kind: 'progress', sourceIds: ['source'] }], commitments: [], suggestions: [], calendarCandidates: [] },
  };
}

test('digest publishes before a delayed calendar and survives its failure', async () => {
  const original = { ...digestClient }, calendar = deferred<{ events: [] }>();
  digestClient.read = async () => response();
  digestClient.calendar = () => calendar.promise;
  const store = new DigestStore('viewer');
  try {
    const read = store.refresh();
    const failure = assert.rejects(read, /calendar unavailable/);
    await Promise.resolve();
    assert.equal(store.getSnapshot().digest?.revision, 1);
    assert.equal(store.getSnapshot().calendarLoaded, false);
    calendar.reject(new Error('calendar unavailable'));
    await failure;
    assert.equal(store.getSnapshot().digest?.revision, 1);
    assert.equal(store.getSnapshot().digestError, null);
    assert.match(store.getSnapshot().calendarError!, /calendar/);
  } finally { store.dispose(); Object.assign(digestClient, original); }
});

test('calendar publishes even when the digest is delayed', async () => {
  const original = { ...digestClient }, digest = deferred<DigestResponse>();
  digestClient.read = () => digest.promise;
  digestClient.calendar = async () => ({ events: [] });
  const store = new DigestStore('viewer');
  try {
    const read = store.refresh();
    await Promise.resolve();
    assert.equal(store.getSnapshot().calendarLoaded, true);
    assert.equal(store.getSnapshot().digest, null);
    digest.resolve(response());
    await read;
  } finally { store.dispose(); Object.assign(digestClient, original); }
});

test('concurrent reads and fresh reentries share one request pair', async () => {
  const original = { ...digestClient }, digest = deferred<DigestResponse>();
  let reads = 0, calendars = 0, now = 100;
  digestClient.read = () => { reads++; return digest.promise; };
  digestClient.calendar = async () => { calendars++; return { events: [] }; };
  const store = new DigestStore('viewer', () => now);
  try {
    const first = store.refresh();
    assert.equal(store.refresh(), first);
    digest.resolve(response());
    await first;
    await store.refresh();
    assert.deepEqual([reads, calendars], [1, 1]);
    now += 5_001;
    await store.refresh();
    assert.deepEqual([reads, calendars], [2, 2]);
  } finally { store.dispose(); Object.assign(digestClient, original); }
});

test('mutation refresh queues one fresh read after an older poll', async () => {
  const original = { ...digestClient }, old = deferred<DigestResponse>();
  let reads = 0;
  digestClient.read = () => ++reads === 1 ? old.promise : Promise.resolve({ ...response(), revision: 2 });
  digestClient.calendar = async () => ({ events: [] });
  const store = new DigestStore('viewer');
  try {
    const poll = store.refresh();
    const mutation = store.refresh(true);
    assert.equal(store.refresh(true), mutation);
    old.resolve(response());
    await Promise.all([poll, mutation]);
    assert.equal(reads, 2);
    assert.equal(store.getSnapshot().digest?.revision, 2);
  } finally { store.dispose(); Object.assign(digestClient, original); }
});

test('disposed account ignores a late response and aborts its reads', async () => {
  const original = { ...digestClient }, digest = deferred<DigestResponse>();
  let signal: AbortSignal | undefined;
  digestClient.read = (_, value) => { signal = value; return digest.promise; };
  digestClient.calendar = async () => ({ events: [] });
  const store = new DigestStore('viewer');
  try {
    const pending = store.refresh();
    store.dispose();
    assert.equal(signal?.aborted, true);
    digest.resolve(response());
    await pending;
    assert.equal(store.getSnapshot().digest, null);
    assert.equal(store.getSnapshot().calendarLoaded, false);
  } finally { Object.assign(digestClient, original); }
});

test('authorization failure removes cached source content', async () => {
  const original = { ...digestClient };
  digestClient.read = async () => response();
  digestClient.calendar = async () => ({ events: [] });
  const store = new DigestStore('viewer');
  try {
    await store.refresh();
    digestClient.read = async () => { throw Object.assign(new Error('denied'), { status: 403 }); };
    await assert.rejects(store.refresh(true));
    assert.equal(store.getSnapshot().digest, null);
    assert.equal(store.getSnapshot().calendarLoaded, false);
    assert.match(store.getSnapshot().digestError!, /Sign in again/);
  } finally { store.dispose(); Object.assign(digestClient, original); }
});

test('returning to Digest renders cached content and source clicks issue zero reads', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const original = { ...digestClient };
  let reads = 0, calendars = 0;
  digestClient.read = async () => { reads++; return response(); };
  digestClient.calendar = async () => { calendars++; return { events: [] }; };
  const host = document.getElementById('root')!;
  let root = createRoot(host);
  const click = async (selector: string) => {
    const button = host.querySelector<HTMLButtonElement>(selector);
    assert.ok(button, selector);
    await act(async () => button.click());
  };
  try {
    await act(async () => root.render(createElement(DigestPage, { accountId: 'viewer' })));
    assert.deepEqual([reads, calendars], [1, 1]);
    await act(async () => root.unmount());
    root = createRoot(host);
    // If a network request is accidentally added, it will never finish.
    digestClient.read = () => { reads++; return new Promise(() => {}); };
    digestClient.calendar = () => { calendars++; return new Promise(() => {}); };
    await act(async () => root.render(createElement(DigestPage, { accountId: 'viewer' })));
    assert.match(host.textContent!, /Prepared draft/);
    await click('.digest-evidence button');
    assert.match(host.querySelector('dialog')!.textContent!, /Already loaded source message/);
    await click('dialog header button');
    await click('.digest-person');
    assert.match(host.querySelector('dialog')!.textContent!, /Already loaded source message/);
    assert.deepEqual([reads, calendars], [1, 1]);
    const cached = digestStoreFor('viewer');
    assert.notEqual(digestStoreFor('another-viewer'), cached);
    await act(async () => { window.dispatchEvent(new dom.window.Event(CLOUD_SESSION_CHANGED_EVENT)); });
    assert.equal(cached.getSnapshot().digest, null);
    assert.doesNotMatch(host.textContent!, /Prepared draft|Already loaded source message/);
    assert.notEqual(digestStoreFor('viewer'), cached);
  } finally {
    await act(async () => root.unmount());
    Object.assign(digestClient, original);
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
