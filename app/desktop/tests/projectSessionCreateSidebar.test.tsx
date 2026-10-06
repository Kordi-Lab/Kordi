import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { useKordiProjectActions } from '../src/app/useKordiProjectActions';
import { ChatProjectsContext } from '../src/features/projects/chatProjects';
import { WorkspaceSidebar } from '../src/pages/WorkspaceSidebar';
import { agent, baseSidebarProps } from './helpers/workspaceSidebarParticipantSpacesFixtures';
import { waitForReactCondition } from './helpers/waitForReactCondition';

test('a project plus creates in that folder, expands it, and prevents duplicate pending creation', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  Object.defineProperty(dom.window.navigator, 'platform', { value: 'MacIntel' });
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  let finishCreation!: (value: unknown) => void;
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command.startsWith('plugin:event|')) return 1;
    assert.equal(command, 'desktop_chat_new_project_session');
    return new Promise((resolve) => { finishCreation = resolve; });
  } } });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  let active = 'existing-session';
  const refreshed: (string | undefined)[] = [];
  const noop = () => {};
  function Probe() {
    const actions = useKordiProjectActions({
      activeProject: { id: 'alpha', root: '/fixture/alpha' } as never,
      activeConversationId: active, isNativeShell: true,
      setActiveConversationId: (value) => { active = typeof value === 'function' ? value(active) : value; },
      refreshCanonicalState: async () => {}, refreshDesktopChat: async (id) => { refreshed.push(id); },
      setActiveNav: noop, setComposerAttachments: noop, setComposerDrafts: noop, setDesktopError: noop,
      setDesktopState: noop, setOpenComposerSelector: noop,
    });
    return createElement(ChatProjectsContext, {
      value: { enabled: true, projects: [
        { id: 'alpha', name: 'Alpha', root: '/fixture/alpha', sessions: [] },
        { id: 'beta', name: 'Beta', root: '/fixture/beta', sessions: [] },
      ], assign: actions.moveSessionToProject, create: async () => {} },
      children: createElement(WorkspaceSidebar, baseSidebarProps({
        initialChatChannel: 'agent', displayedAgents: [agent()],
      }) as never),
    });
  }
  const button = (label: string) => {
    const element = [...document.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
      candidate.getAttribute('aria-label') === label || candidate.textContent === label);
    assert(element, `Button ${label} exists`);
    return element;
  };
  try {
    await act(async () => root.render(createElement(Probe)));
    const folder = button('Beta');
    await act(async () => folder.click());
    assert.equal(folder.getAttribute('aria-expanded'), 'false');
    const create = button('New session in Beta');
    await act(async () => create.click());
    assert.equal(create.disabled, true);
    await act(async () => create.click());
    const creations = calls.filter(({ command }) => command === 'desktop_chat_new_project_session');
    assert.equal(creations.length, 1);
    assert.equal(creations[0].args?.projectRoot, '/fixture/beta', 'Create uses the clicked folder, even when another project is active');
    await act(async () => finishCreation({ activeSessionId: 'beta-new-session' }));
    await waitForReactCondition(() => !create.disabled, 'Project creation completes');
    assert.equal(folder.getAttribute('aria-expanded'), 'true');
    assert.equal(active, 'beta-new-session');
    assert.deepEqual(refreshed, ['beta-new-session']);
    const shortcut = new dom.window.KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true, cancelable: true });
    await act(async () => document.dispatchEvent(shortcut));
    assert.equal(shortcut.defaultPrevented, true);
    assert.ok(document.querySelector('[data-create-surface]')?.textContent?.includes('Chat with agent'), 'Command N opens the same agent picker as New');
    assert.equal(button('New session').getAttribute('aria-keyshortcuts'), 'Meta+N');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
