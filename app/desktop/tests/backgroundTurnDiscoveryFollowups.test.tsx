import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useBackgroundTurnDiscovery } from '../src/features/chat/useBackgroundTurnDiscovery';
import { __setSessionBackendForTests } from '../src/features/cloud/session';

// The discovery loop runs every second. Asking the server for subsession
// follow-ups on each tick sent 60 requests a minute from every idle Mac.
async function runDiscovery(subsessionIds: string[], waitMs: number) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const commands: string[] = [];
  const globals = {
    window: Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string) => {
      commands.push(command);
      if (command === 'desktop_chat_active_turns') return [];
      if (command === 'desktop_chat_subsession_ids') return subsessionIds;
      throw new Error(`offline test: ${command}`);
    } } }),
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true });
  __setSessionBackendForTests({
    load: async () => ({ accountId: 'test-account', token: 'test-token', expiresAt: '2099-01-01T00:00:00Z' }),
    save: async () => {}, clear: async () => {},
  });
  function Harness() {
    useBackgroundTurnDiscovery({ enabled: true, watchTurn: async () => {} });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await act(async () => { root.render(<Harness />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, waitMs)); });
  } finally {
    await act(async () => { root.unmount(); });
    __setSessionBackendForTests(null);
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
  return {
    ticks: commands.filter((command) => command === 'desktop_chat_subsession_ids').length,
    followupRequests: commands.filter((command) => command === 'plugin:http|fetch').length,
  };
}

test('a Mac without runtime subsessions never polls the server for follow-ups', async () => {
  const result = await runDiscovery([], 2_200);
  assert.ok(result.ticks >= 3, `discovery should keep running locally (${result.ticks} ticks)`);
  assert.equal(result.followupRequests, 0);
});

test('a Mac with runtime subsessions polls for follow-ups at most once per interval', async () => {
  const result = await runDiscovery(['runtime-subsession'], 2_200);
  assert.ok(result.ticks >= 3, `discovery should keep running locally (${result.ticks} ticks)`);
  assert.equal(result.followupRequests, 1, 'three one-second ticks share one follow-up request');
});
