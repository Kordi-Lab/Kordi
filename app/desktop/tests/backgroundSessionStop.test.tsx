import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopChatTurnSnapshot } from '../src/kordi-app/types';
import { RelatedAgentSessionLinks } from '../src/kordi-app/components/relatedAgentSessionLinks';
import { BackgroundSessionHeaderControl } from '../src/kordi-app/components/backgroundSessionStopControl';
import { __setSessionBackendForTests, CLOUD_SESSION_CHANGED_EVENT } from '../src/features/cloud/session';
import { CloudAuthClient } from '../src/features/cloud/authClient';
import type { CloudAgentSubsession } from '../src/features/cloud/agentSubsessionTypes';

const initialTurn: DesktopChatTurnSnapshot = {
  id: 'actual-child-turn', sessionId: 'child-session', prompt: '', status: 'tooling', message: '',
  assistantText: '', thinkingText: '', tools: [], completed: false, succeeded: false,
};

async function fixture(invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>, accountId?: string) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const replacements = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke } });
  __setSessionBackendForTests({ load: async () => accountId ? { accountId, token: 'synthetic', expiresAt: '2099-01-01' } : null, save: async () => {}, clear: async () => {} });
  const host = document.getElementById('root')!;
  const root = createRoot(host);
  let opens = 0;
  await act(async () => {
    root.render(<>
      <RelatedAgentSessionLinks sessions={[{ sessionId: 'child-session', title: 'Review controls', status: 'running', turnId: 'stale-spawn-turn' }]} onOpen={() => { opens += 1; }} />
      <BackgroundSessionHeaderControl sessionId="child-session" title="Review controls" />
    </>);
  });
  return {
    host, dom, get opens() { return opens; },
    buttons: () => [...host.querySelectorAll<HTMLButtonElement>('button')].filter(button => /^Stop(?:ping)? background/.test(button.getAttribute('aria-label') ?? '')),
    async close() {
      await act(async () => root.unmount());
      __setSessionBackendForTests(null);
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      dom.window.close();
    },
  };
}

test('card and thread Stop target the actual child turn and show Stopped only after completion', async () => {
  let active: DesktopChatTurnSnapshot | null = { ...initialTurn };
  let stored = { ...initialTurn };
  const cancelled: unknown[] = [];
  const view = await fixture(async (command, args) => {
    if (command === 'desktop_chat_session_active_turn') {
      assert.equal(args?.sessionId, 'child-session');
      return active;
    }
    if (command === 'desktop_chat_turn_state') return stored;
    if (command === 'desktop_chat_cancel_turn') {
      cancelled.push(args?.turnId);
      active = stored = { ...initialTurn, status: 'cancelling' };
      return active;
    }
    throw Error(`Unexpected command: ${command}`);
  });
  try {
    assert.equal(view.buttons().length, 2, 'Stop is visible on both surfaces');
    assert.equal(view.host.querySelectorAll('button button').length, 0, 'Stop is separate from Open');
    await act(async () => { view.buttons()[0].click(); });
    assert.deepEqual(cancelled, ['actual-child-turn']);
    assert.equal(view.opens, 0);
    assert.equal(view.buttons()[0].disabled, true);
    assert.match(view.host.textContent!, /Stopping…/);
    assert.equal(view.host.querySelector('[data-related-agent-session-status]')?.getAttribute('data-related-agent-session-status'), 'running');
    stored = { ...initialTurn, status: 'cancelled', completed: true };
    active = null;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1600)); });
    assert.equal(view.buttons().length, 0);
    assert.match(view.host.textContent!, /Stopped/);
  } finally { await view.close(); }
});

test('failed Stop remains retryable and the thread header can cancel independently', async () => {
  let attempts = 0;
  const view = await fixture(async (command, args) => {
    if (command === 'desktop_chat_session_active_turn') return { ...initialTurn };
    if (command === 'desktop_chat_cancel_turn') {
      assert.equal(args?.turnId, initialTurn.id);
      if (++attempts === 1) throw Error('IPC unavailable');
      return { ...initialTurn, status: 'cancelling' };
    }
    throw Error(`Unexpected command: ${command}`);
  });
  try {
    await act(async () => { view.buttons()[1].click(); });
    assert.match(view.host.querySelector('[role="alert"]')?.textContent ?? '', /Could not stop this task/);
    assert.equal(view.buttons()[1].disabled, false);
    await act(async () => { view.buttons()[1].click(); });
    assert.equal(attempts, 2);
    assert.equal(view.buttons()[1].disabled, true);
  } finally { await view.close(); }
});

test('remote status alone never offers a local Stop, and switching accounts clears the control', async () => {
  let active: DesktopChatTurnSnapshot | null = null;
  const view = await fixture(async command => {
    assert.equal(command, 'desktop_chat_session_active_turn');
    return active;
  });
  try {
    assert.equal(view.buttons().length, 0);
    active = { ...initialTurn };
    await act(async () => { view.dom.window.dispatchEvent(new view.dom.window.Event(CLOUD_SESSION_CHANGED_EVENT)); });
    assert.equal(view.buttons().length, 2);
    active = null;
    await act(async () => { view.dom.window.dispatchEvent(new view.dom.window.Event(CLOUD_SESSION_CHANGED_EVENT)); });
    assert.equal(view.buttons().length, 0);
  } finally { await view.close(); }
});

test('an owner can stop a task in another window through the shared endpoint', async () => {
  let shared: CloudAgentSubsession = { sessionId: 'child-session', parentSessionId: 'parent', parentRequestId: 'request',
    ownerAccountId: 'owner', agentId: 'agent', ownerDisplayName: 'Owner', agentDisplayName: 'Kordi',
    title: 'Review controls', status: 'running', version: 1, messages: [], updatedAt: '', startedAtMs: 1000 };
  const get = CloudAuthClient.prototype.getAgentSubsession, stop = CloudAuthClient.prototype.stopAgentSubsession;
  CloudAuthClient.prototype.getAgentSubsession = async () => shared;
  let stops = 0;
  CloudAuthClient.prototype.stopAgentSubsession = async (token, id, startedAt) => {
    assert.equal(token, 'synthetic'); assert.equal(id, 'child-session'); assert.equal(startedAt, 1000);
    stops++;
    shared = { ...shared, status: 'stopped', version: 2 };
    return shared;
  };
  const view = await fixture(async command => {
    assert.equal(command, 'desktop_chat_session_active_turn', 'remote Stop must not target an unrelated local turn');
    return null;
  }, 'owner');
  try {
    assert.equal(view.buttons().length, 2);
    await act(async () => { view.buttons()[0].click(); });
    assert.equal(stops, 1);
    assert.equal(view.opens, 0);
    assert.match(view.host.textContent!, /Stopped/);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1600)); });
    assert.equal(view.buttons().length, 0);
  } finally {
    await view.close();
    CloudAuthClient.prototype.getAgentSubsession = get;
    CloudAuthClient.prototype.stopAgentSubsession = stop;
  }
});
