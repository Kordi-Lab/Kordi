import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { holdLeasedTurnSession } from '../src/features/cloud/cloudLeasedTurnSessions';
import { useBackgroundTurnDiscovery } from '../src/features/chat/useBackgroundTurnDiscovery';
import type { DesktopChatTurnSnapshot } from '../src/kordi-app/types';

const activeTurn = (id: string, sessionId: string): DesktopChatTurnSnapshot => ({
  id, sessionId, prompt: 'Hi', status: 'running', message: 'Replying…', assistantText: '',
  thinkingText: '', tools: [], completed: false, succeeded: false, startedAtMs: 1,
});

test('discovery leaves an Ask Agent leased turn to its reply row', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const turns = [activeTurn('leased-turn', 'ask-agent-session'), activeTurn('local-turn', 'local-session')];
  const globals = {
    window: Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string) => {
      if (command === 'desktop_chat_active_turns') return turns;
      if (command === 'desktop_chat_subsession_ids') return [];
      return null;
    } } }),
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true });
  const release = holdLeasedTurnSession('ask-agent-session');
  const watched: string[] = [];
  function Harness() {
    useBackgroundTurnDiscovery({ enabled: true, watchTurn: async (turn) => { watched.push(turn.id); } });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await act(async () => { root.render(<Harness />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    assert.deepEqual(watched, ['local-turn']);
    release();
  } finally {
    release();
    await act(async () => { root.unmount(); });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
