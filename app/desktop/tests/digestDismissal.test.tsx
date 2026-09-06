import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { digestClient } from '../src/features/digest/client';
import type { DigestResponse } from '../src/features/digest/types';

const css = registerHooks({ load(url, context, next) {
  return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
const { default: DigestPage } = await import('../src/features/digest/DigestPage');
css.deregister();

test('Brief dismissal persists across remounts, restores entries, and retains entries on failure', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const original = { ...digestClient };
  const response: DigestResponse = {
    accountId: 'viewer', status: 'ready', revision: 1, updatedAt: '2026-09-06T08:00:00Z', partial: false,
    sources: [], feedback: [], snapshot: { claims: [{ id: 'draft', title: 'Draft prepared', text: 'The draft is ready.', kind: 'progress', sourceIds: [] }], commitments: [], suggestions: [], calendarCandidates: [] },
  };
  let fail = false;
  digestClient.read = async () => structuredClone(response);
  digestClient.calendar = async () => ({ events: [] });
  digestClient.feedback = async (account, id, dismissed) => {
    assert.equal(account, 'viewer'); assert.equal(id, 'draft');
    if (fail) throw new Error('Could not save dismissal.');
    response.feedback = dismissed ? [{ id, status: 'dismissed' }] : [];
  };
  const host = dom.window.document.getElementById('root')!;
  let root = createRoot(host);
  const brief = () => host.querySelector('[aria-label="Brief"]')!;
  const click = async (label: string) => {
    const button = [...brief().querySelectorAll('button')].find(button => button.textContent === label);
    assert.ok(button, label);
    await act(async () => button.click());
  };
  try {
    await act(async () => root.render(createElement(DigestPage, { accountId: 'viewer' })));
    await click('Dismiss');
    assert.equal(brief().querySelector('article'), null);
    assert.doesNotMatch(host.querySelector('[aria-label="Next steps"]')?.textContent ?? '', /Restore dismissed suggestions/);
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(createElement(DigestPage, { accountId: 'viewer' })));
    assert.equal(brief().querySelector('article'), null);
    await click('Restore dismissed entries');
    assert.match(brief().textContent ?? '', /Draft prepared/);
    fail = true;
    await click('Dismiss');
    assert.match(brief().textContent ?? '', /Draft prepared/);
    assert.match(host.textContent ?? '', /Could not save dismissal/);
  } finally {
    await act(async () => root.unmount());
    Object.assign(digestClient, original);
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
