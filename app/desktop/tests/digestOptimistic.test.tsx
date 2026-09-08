import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { digestClient } from '../src/features/digest/client';
import { DigestStore } from '../src/features/digest/store';
import type { CalendarEvent, DigestResponse } from '../src/features/digest/types';

const css = registerHooks({ load(url, context, next) {
  return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
const { default: DigestPage } = await import('../src/features/digest/DigestPage');
css.deregister();

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const event: CalendarEvent = { id: 'event', title: 'Review meeting', startAt: '2099-09-08T12:00:00Z', endAt: '2099-09-08T12:30:00Z', sourceIds: ['source'], revision: 1, allDay: false, description: '' };
function response(): DigestResponse {
  return { accountId: 'viewer', status: 'ready', revision: 1, updatedAt: '2026-09-08T00:00:00Z', partial: false, feedback: [],
    sources: [{ id: 'source', conversationId: 'room', sessionId: 'room', sessionTitle: 'Planning', senderAccountId: 'viewer', senderName: 'Viewer', text: 'Please cancel the meeting.', createdAt: '2026-09-08T00:00:00Z', version: 1 }],
    snapshot: { claims: ['a', 'b'].map(id => ({ id, title: `Draft ${id}`, text: 'Review it.', kind: 'progress', sourceIds: ['source'] })), suggestions: [], commitments: [],
      calendarCandidates: [{ id: 'cancel', title: event.title, text: 'Cancel it.', kind: 'possible', sourceIds: ['source'], calendarAction: 'delete', existingEventId: event.id, existingEventRevision: 1 }] } };
}

test('dismiss is immediate, deduplicated, and immune to pre-write polls', async () => {
  const original = { ...digestClient }, server = response(), write = deferred<void>(), old = deferred<DigestResponse>();
  let writes = 0;
  digestClient.read = async () => structuredClone(server);
  digestClient.calendar = async () => ({ events: [] });
  digestClient.feedback = async () => { writes++; await write.promise; };
  const store = new DigestStore('viewer');
  try {
    await store.refresh();
    digestClient.read = () => old.promise;
    const poll = store.refresh(true);
    const saving = store.setFeedback('a', true);
    assert.deepEqual(store.getSnapshot().digest!.feedback, [{ id: 'a', status: 'dismissed' }]);
    assert.equal(store.setFeedback('a', true), saving);
    await Promise.resolve();
    assert.equal(writes, 1);
    old.resolve(response()); await poll;
    assert.equal(store.getSnapshot().digest!.feedback[0].id, 'a');
    assert.deepEqual(store.getSnapshot().pendingMutationKeys, ['feedback:a']);
    server.feedback = [{ id: 'a', status: 'dismissed' }];
    digestClient.read = async () => structuredClone(server);
    write.resolve(); await saving;
    assert.equal(store.getSnapshot().pendingMutationKeys.length, 0);
    assert.equal(store.getSnapshot().digest!.feedback[0].id, 'a');
  } finally { store.dispose(); Object.assign(digestClient, original); }
});

test('a failed dismissal rolls back only its item and remains retryable', async () => {
  const original = { ...digestClient }, server = response(), first = deferred<void>(), second = deferred<void>();
  digestClient.read = async () => structuredClone(server);
  digestClient.calendar = async () => ({ events: [] });
  digestClient.feedback = (_, id) => id === 'a' ? first.promise : second.promise;
  const store = new DigestStore('viewer');
  try {
    await store.refresh();
    const a = store.setFeedback('a', true), b = store.setFeedback('b', true);
    const rejected = assert.rejects(a, /offline/);
    assert.equal(store.getSnapshot().digest!.feedback.length, 2);
    first.reject(new Error('offline')); await rejected;
    assert.deepEqual(store.getSnapshot().digest!.feedback, [{ id: 'b', status: 'dismissed' }]);
    assert.equal(store.getSnapshot().canRetryMutation, true);
    server.feedback = [{ id: 'b', status: 'dismissed' }]; second.resolve(); await b;
    assert.match(store.getSnapshot().mutationError!, /restored/);
    digestClient.feedback = async (_, id) => { server.feedback.push({ id, status: 'dismissed' }); };
    await store.retryMutation();
    assert.deepEqual(store.getSnapshot().digest!.feedback.map(item => item.id).sort(), ['a', 'b']);
    assert.equal(store.getSnapshot().mutationError, null);
  } finally { store.dispose(); Object.assign(digestClient, original); }
});

test('confirmed removal hides only its targets and rolls back on write failure', async () => {
  const original = { ...digestClient }, write = deferred<void>();
  const other = { ...event, id: 'other', title: 'Other meeting' };
  digestClient.read = async () => response(); digestClient.calendar = async () => ({ events: [event, other] });
  digestClient.removeEvent = () => write.promise;
  const store = new DigestStore('viewer');
  try {
    await store.refresh();
    const saving = store.removeEvents([event]); const rejected = assert.rejects(saving, /offline/);
    assert.deepEqual(store.getSnapshot().events.map(item => item.id), ['other']);
    assert.equal(store.getSnapshot().digest!.snapshot!.calendarCandidates.length, 0);
    write.reject(new Error('offline')); await rejected;
    assert.deepEqual(store.getSnapshot().events.map(item => item.id), ['event', 'other']);
    assert.equal(store.getSnapshot().digest!.snapshot!.calendarCandidates.length, 1);
    assert.match(store.getSnapshot().mutationError!, /cancellation/);
  } finally { store.dispose(); Object.assign(digestClient, original); }
});

test('successful writes are not rolled back by failed reconciliation', async () => {
  const original = { ...digestClient };
  digestClient.read = async () => response(); digestClient.calendar = async () => ({ events: [event] });
  digestClient.removeEvent = async () => {};
  const store = new DigestStore('viewer');
  try {
    await store.refresh();
    digestClient.read = async () => { throw new Error('read failed'); };
    digestClient.calendar = async () => { throw new Error('read failed'); };
    await store.removeEvents([event]);
    await assert.rejects(store.refresh());
    assert.equal(store.getSnapshot().events.length, 0);
    assert.equal(store.getSnapshot().mutationError, null);
  } finally { store.dispose(); Object.assign(digestClient, original); }
});

test('revision conflicts require fresh calendar review instead of retrying stale revisions', async () => {
  const original = { ...digestClient };
  let writes = 0;
  digestClient.read = async () => response();
  digestClient.calendar = async () => ({ events: [event] });
  digestClient.removeEvent = async () => { writes++; throw Object.assign(new Error('changed'), { status: 409 }); };
  const store = new DigestStore('viewer');
  try {
    await store.refresh();
    digestClient.calendar = async () => ({ events: [{ ...event, revision: 2 }] });
    await assert.rejects(store.removeEvents([event]));
    await store.refresh();
    assert.equal(store.getSnapshot().events[0].revision, 2);
    assert.equal(store.getSnapshot().canRetryMutation, false);
    assert.match(store.getSnapshot().mutationError!, /Review its current details/);
    await store.retryMutation();
    assert.equal(writes, 1);
  } finally { store.dispose(); Object.assign(digestClient, original); }
});

test('series writes preserve reviewed revisions, reject overlaps, and cannot restore signed-out data', async () => {
  const original = { ...digestClient }, write = deferred<void>();
  const second = { ...event, id: 'second', revision: 2 };
  let signal: AbortSignal | undefined, writes = 0;
  digestClient.read = async () => response(); digestClient.calendar = async () => ({ events: [event, second] });
  digestClient.removeSeries = (_, id, events, cancel) => {
    assert.equal(id, 'series'); assert.deepEqual(events.map(item => item.revision), [1, 2]);
    signal = cancel; writes++; return write.promise;
  };
  const store = new DigestStore('viewer');
  try {
    await store.refresh();
    const saving = store.removeEvents([event, second], 'series');
    assert.equal(store.removeEvents([event, second], 'series'), saving);
    await assert.rejects(store.removeEvents([event]), /Another change/);
    await Promise.resolve(); assert.equal(writes, 1);
    assert.equal(store.getSnapshot().events.length, 0);
    store.dispose(); assert.equal(signal!.aborted, true);
    write.resolve(); await saving;
    assert.equal(store.getSnapshot().digest, null);
    assert.equal(store.getSnapshot().events.length, 0);
    assert.equal(store.getSnapshot().mutationError, null);
  } finally { store.dispose(); Object.assign(digestClient, original); }
});

test('calendar review remains required, then closes before the server responds and survives route reentry', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const original = { ...digestClient }, write = deferred<void>(), dismissal = deferred<void>();
  let writes = 0;
  digestClient.read = async () => response(); digestClient.calendar = async () => ({ events: [event] });
  digestClient.feedback = () => dismissal.promise;
  digestClient.removeEvent = () => { writes++; return write.promise; };
  const host = document.getElementById('root')!; let root = createRoot(host);
  const click = async (label: string) => { const button = [...host.querySelectorAll('button')].find(item => item.textContent === label); assert.ok(button, label); await act(async () => button.click()); };
  try {
    await act(async () => root.render(createElement(DigestPage, { accountId: 'viewer' })));
    await click('Dismiss');
    assert.doesNotMatch(host.querySelector('[aria-label="Brief"]')!.textContent!, /Draft a/);
    assert.equal(host.querySelector<HTMLButtonElement>('[aria-label="Dismiss Draft b"]')!.disabled, false);
    assert.match(host.textContent!, /Saving changes/);
    await act(async () => dismissal.reject(new Error('offline')));
    assert.match(host.querySelector('[aria-label="Brief"]')!.textContent!, /Draft a/);
    await click('Review cancellation'); assert.equal(writes, 0);
    await click('Keep event'); assert.equal(writes, 0);
    await click('Review cancellation'); await click('Confirm removal');
    assert.equal(writes, 1); assert.equal(host.querySelector('dialog'), null);
    assert.match(host.textContent!, /Saving changes/);
    assert.equal(host.querySelector('.digest-proposal'), null);
    await act(async () => root.unmount()); root = createRoot(host);
    await act(async () => root.render(createElement(DigestPage, { accountId: 'viewer' })));
    assert.match(host.textContent!, /Saving changes/);
    assert.equal(host.querySelector('.digest-proposal'), null);
    await act(async () => write.reject(new Error('offline')));
    assert.match(host.textContent!, /event was restored/);
    assert.ok(host.querySelector('.digest-proposal'));
  } finally {
    await act(async () => root.unmount()); Object.assign(digestClient, original); Object.assign(globalThis, previous); dom.window.close();
  }
});
