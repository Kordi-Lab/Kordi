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
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const original = { ...digestClient };
  const response: DigestResponse = {
    accountId: 'viewer', status: 'ready', revision: 1, updatedAt: '2026-09-06T08:00:00Z', partial: true,
    sources: [{ id: 'source', conversationId: 'conversation', sessionId: 'session', sessionTitle: 'Planning', senderAccountId: 'viewer', senderName: 'Viewer', text: '### Prepared draft\n\n**Ready** for review.\n\n- First item\n- Second item\n\n[Reference](https://example.com/reference) and `code`.\n\n<img src=x onerror=alert(1)>\n\n[Unsafe](javascript:alert(1))', createdAt: '2026-09-06T08:00:00Z', version: 1 }],
    feedback: [], snapshot: { claims: [{ id: 'draft', title: 'Draft prepared', text: 'The draft is ready.', kind: 'progress', sourceIds: ['source'] }], commitments: [], suggestions: [{ id: 'suggestion', title: 'Review the draft', text: 'Consider a review.', kind: 'possible', sourceIds: ['source'] }], calendarCandidates: [] },
  };
  let fail = false;
  response.snapshot!.commitments = [{ id: 'agent-execution', title: 'Agent already finished analysis', text: 'Completed Agent work is not a suggestion for the viewer.', kind: 'open', sourceIds: ['source'] }];
  digestClient.read = async () => structuredClone(response);
  digestClient.calendar = async () => ({ events: [] });
  digestClient.feedback = async (account, id, dismissed) => {
    assert.equal(account, 'viewer'); assert.ok(['draft', 'suggestion'].includes(id));
    if (fail) throw new Error('Could not save dismissal.');
    response.feedback = response.feedback.filter(item => item.id !== id);
    if (dismissed) response.feedback.push({ id, status: 'dismissed' });
  };
  const host = dom.window.document.getElementById('root')!;
  let root = createRoot(host);
  const brief = () => host.querySelector('[aria-label="Brief"]')!;
  const nextSteps = () => host.querySelector('[aria-label="Next steps"]')!;
  const click = async (label: string, section: Element = brief()) => {
    const button = [...section.querySelectorAll('button')].find(button => button.textContent === label);
    assert.ok(button, label);
    await act(async () => button.click());
  };
  try {
    await act(async () => root.render(createElement(DigestPage, { accountId: 'viewer' })));
    assert.doesNotMatch(host.textContent ?? '', /Partial coverage|bounded selection/);
    assert.doesNotMatch(nextSteps().textContent ?? '', /Commitments|Agent already finished analysis|Review task/);
    await click('↗ Planning');
    const details = host.querySelector('dialog')!;
    assert.equal(details.querySelector('strong')?.textContent, 'Ready');
    assert.equal(details.querySelectorAll('ul li').length, 2);
    assert.equal(details.querySelector('a')?.getAttribute('href'), 'https://example.com/reference');
    assert.equal(details.querySelector('code')?.textContent, 'code');
    assert.equal(details.querySelector('img, [onerror], a[href^="javascript:"]'), null);
    assert.doesNotMatch(details.textContent ?? '', /###|\*\*Ready\*\*/);
    await click('Close', details);
    await click('Dismiss');
    assert.equal(brief().querySelector('article'), null);
    assert.match(brief().textContent ?? '', /No brief entries to show/);
    assert.doesNotMatch(host.querySelector('[aria-label="Next steps"]')?.textContent ?? '', /Restore dismissed suggestions/);
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(createElement(DigestPage, { accountId: 'viewer' })));
    assert.equal(brief().querySelector('article'), null);
    await click('Next steps', host.querySelector('nav')!);
    await click('Dismiss', nextSteps());
    assert.match(nextSteps().textContent ?? '', /No suggestions to show/);
    await click('Restore dismissed suggestions', nextSteps());
    assert.equal(brief().querySelector('article'), null);
    assert.deepEqual(response.feedback, [{ id: 'draft', status: 'dismissed' }]);
    await click('Dismiss', nextSteps());
    await click('Brief', host.querySelector('nav')!);
    await click('Restore dismissed entries');
    assert.match(brief().textContent ?? '', /Draft prepared/);
    assert.deepEqual(response.feedback, [{ id: 'suggestion', status: 'dismissed' }]);
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
