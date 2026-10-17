import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { ChatProjectsContext, type ChatProject, type ChatProjects } from '../src/features/projects/chatProjects';
import { ChatWorkspaceControls } from '../src/features/projects/ChatWorkspaceControls';
import { __setRemoteProjectCatalogForTests } from '../src/features/projects/remoteProjectCatalog';
import type { GitWorkspace } from '../src/features/projects/gitWorkspace';
import type { Conversation } from '../src/kordi-app/types';

const ROOT = '/Users/example/example-project';
const TREE = '/Users/example/KordiWorktrees/chat-synced';
const CATALOG_ID = 'c'.repeat(64);
const WORKTREE_ID = 'd'.repeat(64);

function conversation(id: string, runtime: boolean): Conversation {
  return {
    id, canonicalSessionId: id, name: id, type: 'owned-agent', subtitle: '', unread: 0, desktopRuntimeBacked: runtime,
    localSessionCwd: null, collaborationSources: ['Local'], trust: 'Owned', directness: 'Agent chat', participants: ['Me', 'Kordi'], messages: [],
  } as unknown as Conversation;
}

async function render(
  projects: ChatProject[],
  chat: Conversation,
  invoke: (command: string, args?: Record<string, unknown>) => unknown = () => null,
) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator, Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string, args?: Record<string, unknown>) => invoke(command, args) } });
  const loads: Array<[string, string | undefined, string | undefined]> = [];
  const value: ChatProjects = {
    enabled: true, projects,
    gitWorkspace: async (root, cwd, workspaceId): Promise<GitWorkspace> => {
      loads.push([root, cwd, workspaceId]);
      const inTree = workspaceId === WORKTREE_ID;
      return { branch: inTree ? 'kordi/chat-synced' : 'main', branches: ['main'], worktrees: [{ path: root, branch: 'main' }, { path: TREE, branch: 'kordi/chat-synced' }], workspaceRoot: inTree ? TREE : root, isWorktree: inTree };
    },
    assign: async () => {}, create: async () => {},
  };
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(createElement(ChatProjectsContext.Provider, { value }, createElement(ChatWorkspaceControls, { conversation: chat, disabled: false }))));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return {
    dom, loads,
    text: () => document.getElementById('root')!.textContent ?? '',
    async cleanup() {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    },
  };
}

test('a synced worktree session shows its project, branch and worktree when the folder is on this Mac', async () => {
  __setRemoteProjectCatalogForTests([{ id: CATALOG_ID, name: 'example-project', sessions: ['synced'], localRoot: ROOT, workspaces: { synced: WORKTREE_ID } }]);
  const view = await render([{ id: `project:${ROOT}`, name: 'example-project', root: ROOT, sessions: [{ id: 'synced' }] }], conversation('synced', false));
  try {
    assert.match(view.text(), /Local/);
    assert.match(view.text(), /example-project/);
    assert.match(view.text(), /kordi\/chat-synced/);
    assert.doesNotMatch(view.text(), /Choose project|Locate folder/);
    assert.deepEqual(view.loads[0], [ROOT, undefined, WORKTREE_ID]);
    const worktree = document.querySelector<HTMLInputElement>('input[aria-label="Use worktree"]');
    assert.equal(worktree?.checked, true);
    // The session runs in another app profile, so its workspace is not changed from here.
    assert.equal(worktree?.disabled, true);
  } finally {
    await view.cleanup();
    __setRemoteProjectCatalogForTests([]);
  }
});

test('after a send, the runtime copy of a synced session keeps its project, branch and worktree', async () => {
  __setRemoteProjectCatalogForTests([{ id: CATALOG_ID, name: 'example-project', sessions: ['synced'], localRoot: ROOT, workspaces: { synced: WORKTREE_ID } }]);
  const copy = { ...conversation('synced', true), localSessionCwd: '/Users/example/chat-folder' } as Conversation;
  const view = await render([{ id: `project:${ROOT}`, name: 'example-project', root: ROOT, sessions: [{ id: 'synced' }] }], copy);
  try {
    assert.match(view.text(), /example-project/);
    assert.match(view.text(), /kordi\/chat-synced/);
    assert.doesNotMatch(view.text(), /Choose project/);
    // The copy runs in this profile's chat folder; the workspace comes from the owning Mac.
    assert.deepEqual(view.loads[0], [ROOT, undefined, WORKTREE_ID]);
    assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="Use worktree"]')?.disabled, true);
    assert.equal(document.querySelector('[aria-label^="Project:"]'), null);
  } finally {
    await view.cleanup();
    __setRemoteProjectCatalogForTests([]);
  }
});

test('a project whose folder is missing keeps its chip and offers Locate folder', async () => {
  const calls: string[] = [];
  const view = await render(
    [{ id: `remote-project:${CATALOG_ID}`, name: 'example-project', root: '', sessions: [{ id: 'synced' }] }],
    conversation('synced', false),
    (command, args) => {
      calls.push(command);
      if (command === 'desktop_project_choose_folder') return '/Users/example/elsewhere';
      if (command === 'desktop_project_locate_catalog') {
        assert.deepEqual(args, { catalogId: CATALOG_ID, folderPath: '/Users/example/elsewhere' });
        throw new Error("This folder is not the project's folder.");
      }
      return null;
    },
  );
  try {
    assert.match(view.text(), /example-project/);
    assert.equal(view.loads.length, 0);
    const locate = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Locate folder'));
    assert(locate);
    await act(async () => { locate.dispatchEvent(new view.dom.window.MouseEvent('click', { bubbles: true })); });
    for (let attempt = 0; !document.querySelector('[role="alert"]') && attempt < 100; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    assert.deepEqual(calls, ['desktop_project_choose_folder', 'desktop_project_locate_catalog']);
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /not the project's folder/);
    assert.match(view.text(), /example-project/);
  } finally {
    await view.cleanup();
  }
});

test('the chip row never vanishes for a project session and stays hidden for other synced chats', async () => {
  const project: ChatProject = { id: `project:${ROOT}`, name: 'example-project', root: ROOT, sessions: [{ id: 'synced' }, { id: 'local' }] };
  for (const [chat, expected] of [
    [conversation('synced', false), /example-project/],
    [conversation('local', true), /example-project/],
    [conversation('plain', true), /Choose project/],
  ] as const) {
    const view = await render([project], chat);
    try {
      assert.match(view.text(), /Local/);
      assert.match(view.text(), expected);
    } finally { await view.cleanup(); }
  }
  const view = await render([project], conversation('group-chat', false));
  try { assert.equal(view.text(), ''); } finally { await view.cleanup(); }
});
