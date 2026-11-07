import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { backgroundSessionGroupSummary } from '../src/features/chat/backgroundSessionGroups';
import { RelatedAgentSessionLinks } from '../src/kordi-app/components/relatedAgentSessionLinks';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import type { RelatedAgentSession, RelatedAgentSessionRunStatus } from '../src/features/chat/relatedAgentSessions';

const statuses: RelatedAgentSessionRunStatus[] = ['running', 'done', 'stopped', 'failed', 'running'];
const sessions = (count: number): RelatedAgentSession[] => Array.from({ length: count }, (_, index) => ({
  sessionId: `child-${count}-${index}`, title: `Background task ${index + 1}`, status: statuses[index % statuses.length],
}));

test('the folded line counts the group, running and failed sessions', () => {
  assert.deepEqual(backgroundSessionGroupSummary(statuses), { text: '5 background sessions · 2 running · 1 failed', status: 'running' });
  assert.deepEqual(backgroundSessionGroupSummary(['done', 'failed']), { text: '2 background sessions · 1 failed', status: 'failed' });
  assert.deepEqual(backgroundSessionGroupSummary(['done']), { text: '1 background session', status: 'done' });
  assert.equal(backgroundSessionGroupSummary(['done', 'stopped']).status, 'stopped');
});

test('three rows start unfolded and more rows start folded', () => {
  const three = renderToStaticMarkup(<RelatedAgentSessionLinks sessions={sessions(3)} onOpen={() => undefined} />);
  assert.match(three, /data-related-agent-sessions-folded="false"/);
  assert.doesNotMatch(three, /data-related-agent-sessions-summary="true"/);
  assert.doesNotMatch(three, /<div[^>]*hidden=""[^>]*data-related-agent-session-id/);

  const five = renderToStaticMarkup(<RelatedAgentSessionLinks sessions={sessions(5)} onOpen={() => undefined} />);
  assert.match(five, /data-related-agent-sessions-folded="true"/);
  assert.match(five, /5 background sessions · 2 running · 1 failed/);
  assert.match(five, /data-related-agent-sessions-summary-status="running"/);
  // Folded rows stay mounted, so their live status still reaches the summary.
  assert.equal(five.match(/hidden=""/g)?.length, 5);
});

test('the chevron toggles the group and the choice is kept for that message', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const replacements = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  __setSessionBackendForTests({ load: async () => null, save: async () => {}, clear: async () => {} });
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  const group = sessions(5);
  const folded = () => host.querySelector('[data-related-agent-sessions]')?.getAttribute('data-related-agent-sessions-folded');
  try {
    await act(async () => root.render(<RelatedAgentSessionLinks sessions={group} onOpen={() => undefined} />));
    assert.equal(folded(), 'true');
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label^="Show 5 background sessions"]')!.click());
    assert.equal(folded(), 'false');
    assert.equal(host.querySelectorAll('[data-related-agent-session-id]:not([hidden])').length, 5);
    // The message renders again later in the session: it stays unfolded.
    await act(async () => root.render(<></>));
    await act(async () => root.render(<RelatedAgentSessionLinks sessions={group} onOpen={() => undefined} />));
    assert.equal(folded(), 'false');
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label^="Fold 5 background sessions"]')!.click());
    assert.equal(folded(), 'true');
  } finally {
    await act(async () => root.unmount());
    __setSessionBackendForTests(null);
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
