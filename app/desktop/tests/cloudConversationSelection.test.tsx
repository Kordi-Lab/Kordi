import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useDesktopSessionController } from '../src/features/chat/useDesktopSessionController';

test('cloud contact and agent selection never opens a local Agent runtime', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const root = createRoot(document.getElementById('root')!);
  const loaded: string[] = [];
  const refreshed: string[] = [];
  const hydrated: string[] = [];
  let selected = '';
  let error: string | null = 'Previous loading error';
  let actions!: ReturnType<typeof useDesktopSessionController>;
  const noop = () => {};
  function Harness() {
    actions = useDesktopSessionController({
      isNativeShell: true, activeConversationUsesCollaboration: false, activeConvId: 'local-session',
      desktopChatState: null, desktopSessionRenameDraft: '', selectProjectSession: noop,
      refreshDesktopChat: async id => { if (id) refreshed.push(id); },
      hydrateCanonicalSessionPage: async id => { hydrated.push(id); },
      isDesktopSessionTranscriptCached: () => false,
      preloadDesktopSessionTranscript: async id => {
        loaded.push(id);
        if (id.startsWith('cloud:')) throw new Error('No session matching cloud conversation');
        return true;
      },
      shouldAutoFollowChatRef: { current: false },
      setActiveConvId: update => { selected = typeof update === 'function' ? update(selected) : update; },
      setDesktopChatError: update => { error = typeof update === 'function' ? update(error) : update; },
      setPendingUserChatMessage: noop, setChatComposerAttachments: noop, setDesktopChatState: noop,
      setComposerDrafts: noop, setOpenComposerSelector: noop, setDesktopSessionRenameDraft: noop,
      setIsEditingDesktopSessionTitle: noop,
    });
    return null;
  }
  try {
    await act(async () => root.render(<Harness />));
    for (const id of [
      'cloud:conversation:acct_example:person',
      'cloud:conversation:acct_example:agent',
      'cloud:conversation:acct_example:agent:session:session%3Adirect-system-agent%3Aexample',
      'bridge:cloud:acct_example:person',
    ]) {
      await act(async () => {
        assert.equal(await actions.handlePrefetchChatSession(id), true, id);
        await actions.handleSelectChatSession(id);
      });
      assert.equal(selected, id);
      assert.equal(error, null);
      assert.deepEqual(loaded, [], 'Cloud IDs must not reach local transcript loading');
      assert.deepEqual(refreshed, [], 'Cloud IDs must not reach native session activation');
      assert.deepEqual(hydrated, [], 'Conversation IDs must not be passed as canonical session IDs');
    }
    await act(async () => {
      await actions.handleSelectChatSession('session:direct-person:example:peer');
    });
    assert.deepEqual(hydrated, ['session:direct-person:example:peer']);
    assert.deepEqual(loaded, []);
    await act(async () => { await actions.handleSelectChatSession('local-session'); });
    assert.deepEqual(loaded, ['local-session']);
    assert.deepEqual(refreshed, ['local-session']);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
