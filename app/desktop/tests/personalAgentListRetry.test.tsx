import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';

import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { loadUntilSuccess, PERSONAL_AGENT_RETRY_DELAYS_MS } from '../src/features/personalAgent/personalAgentListRetry';
import { getPersonalAgentEntries, setPersonalAgentEntries } from '../src/features/personalAgent/personalAgentStore';
import { usePersonalAgentSync } from '../src/features/personalAgent/usePersonalAgentSync';
import type { Agent } from '../src/kordi-app/types';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `ready` holds, so timer-based steps do not depend on machine load. */
async function until(ready: () => boolean, timeoutMs = 5_000) {
  for (let waited = 0; !ready(); waited += 5) {
    if (waited >= timeoutMs) return;
    await wait(5);
  }
}

function eventTarget() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: (type: string, listener: () => void) => { listeners.set(type, (listeners.get(type) ?? new Set()).add(listener)); },
    removeEventListener: (type: string, listener: () => void) => { listeners.get(type)?.delete(listener); },
    fire: (type: string) => { for (const listener of listeners.get(type) ?? []) listener(); },
    count: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

test('the default backoff is 5 s, 30 s, then every 2 min', () => {
  assert.deepEqual(PERSONAL_AGENT_RETRY_DELAYS_MS, [5_000, 30_000, 120_000]);
});

test('a failed load retries with backoff until it succeeds, then stops', async () => {
  const errors: unknown[] = [];
  let calls = 0;
  const win = eventTarget();
  const doc = eventTarget();
  const stop = loadUntilSuccess(async () => {
    calls += 1;
    if (calls < 4) throw new Error(`down ${calls}`);
    return true;
  }, { onError: (error) => errors.push(error), delaysMs: [5, 10, 20], windowTarget: win as never, documentTarget: doc as never });
  await until(() => calls >= 4);
  await wait(30);
  assert.equal(calls, 4);
  assert.equal(errors.length, 3);
  win.fire('focus');
  await wait(5);
  assert.equal(calls, 4, 'no reload after success');
  stop();
  assert.equal(win.count() + doc.count(), 0);
});

test('focus, coming online, or becoming visible retries a failed load at once', async () => {
  let calls = 0;
  const win = eventTarget();
  const doc = eventTarget();
  const stop = loadUntilSuccess(async () => {
    calls += 1;
    if (calls < 3) throw new Error('down');
    return true;
  }, { onError: () => undefined, delaysMs: [60_000], windowTarget: win as never, documentTarget: doc as never });
  await until(() => calls >= 1);
  assert.equal(calls, 1);
  win.fire('online');
  await until(() => calls >= 2);
  assert.equal(calls, 2);
  doc.visibilityState = 'hidden';
  doc.fire('visibilitychange');
  await wait(5);
  assert.equal(calls, 2, 'a hidden window waits');
  doc.visibilityState = 'visible';
  win.fire('focus');
  await until(() => calls >= 3);
  assert.equal(calls, 3);
  stop();
});

test('the sync retries a failed personal agents list and reports each failure', async () => {
  __setSessionBackendForTests({ load: async () => ({ token: 'token', accountId: 'acct_alex', expiresAt: '2099-01-01T00:00:00Z' }), save: async () => undefined, clear: async () => undefined });
  const warnings: string[] = [];
  let calls = 0;
  const agents: Agent[] = [];
  function Harness() {
    usePersonalAgentSync({
      accountId: 'acct_alex', agents, canonicalState: null, setCanonicalState: () => undefined, canCreateSessions: false,
      reportWarning: (message) => warnings.push(message), retryDelaysMs: [5, 5],
      loadCachedConversations: async () => [],
      list: async () => {
        calls += 1;
        if (calls < 3) throw new Error('503');
        return [{ agentId: 'cloud-agent:acct_alex', conversationId: 'conv', sessionId: 'session:personal', proactive: false }];
      },
    });
    return null;
  }
  try {
    await withJsdomRoot(async (mount) => {
      await mount(createElement(Harness));
      await act(async () => { await until(() => getPersonalAgentEntries().length > 0); });
      assert.equal(calls, 3);
      assert.deepEqual(warnings, ['[personal-agent] could not load personal agents', '[personal-agent] could not load personal agents']);
      assert.deepEqual(getPersonalAgentEntries().map((entry) => entry.sessionId), ['session:personal']);
    });
  } finally {
    __setSessionBackendForTests(null);
    setPersonalAgentEntries([]);
  }
});
