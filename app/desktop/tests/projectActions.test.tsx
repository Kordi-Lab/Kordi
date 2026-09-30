import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useKordiProjectActions } from '../src/app/useKordiProjectActions';
import type { ComposerDraftState } from '../src/features/chat/composerDrafts';

for (const target of ['draft:local-chat', 'background-session', '']) {
  test(`project assignment keeps the right active session and draft (${target || 'new session'})`, async () => {
    const dom = new JSDOM('<div id="root"></div>');
    const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return { activeSessionId: target === 'background-session' ? target : 'new-project-session' };
    } } });
    const root = createRoot(document.getElementById('root')!);
    let actions!: ReturnType<typeof useKordiProjectActions>;
    let active = 'draft:local-chat';
    let drafts: ComposerDraftState = { chat: { 'draft:local-chat': { text: 'Keep my task', updatedAt: 1 } }, project: {} };
    const refreshed: (string | undefined)[] = [];
    const navigation: string[] = [];
    const noop = () => {};
    function Probe() {
      actions = useKordiProjectActions({ activeProject: { id: 'project', root: '/fixture/project' } as never,
        activeConversationId: active, isNativeShell: true,
        setActiveConversationId: (value) => { active = typeof value === 'function' ? value(active) : value; },
        setComposerDrafts: (value) => { drafts = typeof value === 'function' ? value(drafts) : value; },
        refreshCanonicalState: async () => {}, refreshDesktopChat: async (id) => { refreshed.push(id); },
        setActiveNav: (value) => navigation.push(value as string),
        setComposerAttachments: () => { assert.equal(target, '', 'Existing project assignments preserve attachments'); },
        setDesktopError: noop, setDesktopState: noop, setOpenComposerSelector: noop,
      });
      return null;
    }
    try {
      await act(async () => root.render(createElement(Probe)));
      await act(async () => actions.moveSessionToProject(target, '/fixture/project'));
      assert.equal(calls[0].command, target === 'background-session' ? 'desktop_chat_move_session_to_project' : 'desktop_chat_new_project_session');
      assert.equal(calls[0].args?.projectRoot, '/fixture/project');
      assert.equal(active, target === 'background-session' ? 'draft:local-chat' : 'new-project-session');
      assert.equal(refreshed[0], active);
      assert.deepEqual(navigation, ['chats']);
      assert.equal(drafts.chat[target === 'draft:local-chat' ? 'new-project-session' : 'draft:local-chat']?.text, 'Keep my task');
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    }
  });
}
