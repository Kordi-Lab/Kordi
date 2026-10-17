import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { bindClaimedProjectSession, claimedProjectFromLease } from '../src/features/projects/claimedProjectSession';
import { adoptedProjectSessionIds } from '../src/features/projects/adoptedProjectSessions';
import { projectID, useProjectSync } from '../src/features/projects/projectSync';
import { __setSessionBackendForTests } from '../src/features/cloud/session';

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

async function withDesktop(invoke: Invoke, run: (dom: JSDOM) => Promise<void>, fetch?: typeof globalThis.fetch) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const keys = ['window', 'document', 'fetch', 'Event', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const globals: Record<string, unknown> = { window: dom.window, document: dom.window.document, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true };
  if (fetch) globals.fetch = fetch;
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke } });
  try { await run(dom); } finally {
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}

test('claim responses name a project only by a valid catalog ID', () => {
  const id = 'a'.repeat(64);
  assert.equal(claimedProjectFromLease(undefined), undefined);
  assert.equal(claimedProjectFromLease({ id: '/fixture/private/project', name: 'Leak' }), undefined);
  assert.deepEqual(claimedProjectFromLease({ id, name: ' Trust ', workspaceId: 'not-an-id' }), { id, name: 'Trust' });
  assert.deepEqual(claimedProjectFromLease({ id, name: 'Trust', workspaceId: 'b'.repeat(64) }), { id, name: 'Trust', workspaceId: 'b'.repeat(64) });
});

test('a claimed session moves into the local folder and worktree of its project before it runs', async () => {
  const root = '/fixture/trust';
  const id = await projectID(root);
  const calls: string[] = [];
  let moved: Record<string, unknown> | undefined;
  await withDesktop(async (command, args) => {
    calls.push(command);
    if (command === 'desktop_project_git_workspace') return { branch: 'design', branches: [], worktrees: [], workspaceRoot: '/fixture/trust-design', isWorktree: true };
    if (command === 'desktop_chat_move_session_to_project') { moved = args; }
    return { projects: [{ root, name: 'Trust', sessions: [] }, { root: '/fixture/other', name: 'Other', sessions: [] }] };
  }, async () => {
    assert.equal(await bindClaimedProjectSession('synced', { id, name: 'Trust', workspaceId: 'c'.repeat(64) }), true);
    assert.deepEqual(calls.slice(-2), ['desktop_project_prepare_remote_session', 'desktop_chat_move_session_to_project']);
    assert.equal(moved?.projectRoot, root);
    assert.deepEqual(moved?.workspace, { worktree: true, workspaceRoot: '/fixture/trust-design', branch: 'design' });
    assert.deepEqual([...adoptedProjectSessionIds()], ['synced']);
  });
});

test('a claimed session never runs when its project folder is not on this Mac', async () => {
  const calls: string[] = [];
  await withDesktop(async (command) => {
    calls.push(command);
    return { projects: [{ root: '/fixture/other', name: 'Other', sessions: [] }] };
  }, async () => {
    assert.equal(await bindClaimedProjectSession('synced', { id: 'd'.repeat(64), name: 'Trust' }), false);
    assert(!calls.includes('desktop_chat_move_session_to_project'));
    assert(!calls.includes('desktop_project_prepare_remote_session'));
  });
});

test('sessions run for an offline project Mac stay out of this Mac catalog', async () => {
  const published: string[][] = [];
  await withDesktop(async () => ({ projects: [{ root: '/fixture/trust', name: 'Trust', sessions: [{ id: 'own' }, { id: 'adopted' }] }] }), async (dom) => {
    dom.window.localStorage.setItem('kordi.projects.adoptedSessions', JSON.stringify(['adopted']));
    __setSessionBackendForTests({ load: async () => ({ token: 'synthetic-token', accountId: 'owner', deviceId: 'mac', expiresAt: '' }), save: async () => {}, clear: async () => {} });
    const root = createRoot(document.getElementById('root')!);
    function Probe() { useProjectSync(true, 'owner'); return null; }
    try {
      await act(async () => root.render(createElement(Probe)));
      for (let attempt = 0; published.length === 0 && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(published[0], ['own']);
    } finally {
      await act(async () => root.unmount());
      __setSessionBackendForTests(null);
    }
  }, async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/projects') && init?.method === 'PUT') published.push(JSON.parse(String(init.body)).projects[0].sessions);
    return Response.json(path.endsWith('/commands/next') ? { command: null } : { ok: true });
  });
});
