import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { useKordiProjectActions } from '../src/app/useKordiProjectActions';
import { ChatProjectsProvider } from '../src/features/projects/ChatProjectsProvider';
import { ProjectSidebarHeading } from '../src/features/projects/ProjectSidebarHeading';
import { useChatProjects } from '../src/features/projects/chatProjects';
import { waitForReactCondition } from './helpers/waitForReactCondition';

test('the sidebar New project button imports a local folder and opens a new project session', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const globals = {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === 'desktop_project_choose_folder') return '/fixture/project';
    if (command === 'desktop_project_create_from_folder') return { root: '/fixture/project', name: 'Project' };
    if (command === 'desktop_chat_new_project_session') return { activeSessionId: 'new-project-session' };
    throw new Error(`Unexpected desktop command: ${command}`);
  } } });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  let active = 'existing-session';
  const refreshed: (string | undefined)[] = [];
  const navigation: string[] = [];
  const noop = () => {};
  function Heading() {
    const projects = useChatProjects()!;
    return createElement(ProjectSidebarHeading, {
      section: 'projects', first: true, expanded: true, onToggle: noop,
      onCreateProject: projects.openImporter,
    });
  }
  function Probe() {
    const actions = useKordiProjectActions({
      activeProject: { id: 'project', root: '/fixture/project' } as never,
      activeConversationId: active, isNativeShell: true,
      setActiveConversationId: (value) => { active = typeof value === 'function' ? value(active) : value; },
      refreshCanonicalState: async () => {}, refreshDesktopChat: async (id) => { refreshed.push(id); },
      setActiveNav: (value) => navigation.push(value as string),
      setComposerAttachments: noop, setComposerDrafts: noop, setDesktopError: noop,
      setDesktopState: noop, setOpenComposerSelector: noop,
    });
    return createElement(ChatProjectsProvider, {
      value: { enabled: true, projects: [], assign: actions.moveSessionToProject, create: async () => {} },
      children: createElement(Heading),
    });
  }
  const click = async (label: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
      element.getAttribute('aria-label') === label || element.textContent?.includes(label));
    assert(button, `Button ${label} exists`);
    await act(async () => button.click());
  };
  try {
    await act(async () => root.render(createElement(Probe)));
    await click('New project');
    await click('Open local folder');
    await click('Choose folder');
    await waitForReactCondition(() => document.querySelector<HTMLInputElement>('input')?.value === '/fixture/project', 'The chosen folder appears');
    await click('Add project');
    await waitForReactCondition(() => !document.querySelector('[role="dialog"]') || Boolean(document.querySelector('[role="alert"]')), 'Project import completes');
    assert.equal(document.querySelector('[role="alert"]')?.textContent, undefined, 'Importing a folder does not fail during session selection');
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.deepEqual(calls.map(({ command }) => command), [
      'desktop_project_choose_folder', 'desktop_project_create_from_folder', 'desktop_chat_new_project_session',
    ]);
    assert.equal(calls[1].args?.folderPath, '/fixture/project');
    assert.equal(calls[2].args?.projectRoot, '/fixture/project');
    assert.equal(active, 'new-project-session');
    assert.deepEqual(refreshed, ['new-project-session']);
    assert.deepEqual(navigation, ['agent-chats']);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
