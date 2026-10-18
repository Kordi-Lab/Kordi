import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useProjectSync } from '../src/features/projects/projectSync';
import { __setSessionBackendForTests } from '../src/features/cloud/session';

test('remote moves publish opaque membership before acknowledgement', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = new Map(['window', 'document', 'fetch', 'Event', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const events: string[] = [];
  let completed = false;
  let assigned = false;
  let id = '';
  const globals = { window: dom.window, document: dom.window.document, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const body = init.body ? JSON.parse(String(init.body)) : null;
      if (path.endsWith('/projects')) {
        assert(!String(init.body).includes('/fixture/private-project'));
        id = body.projects[0].id;
        assert.match(id, /^[a-f0-9]{64}$/);
        events.push(`published:${body.projects[0].sessions.length}`);
      } else if (path.endsWith('/commands/next')) {
        return Response.json({ command: { id: 'operation', request: { action: 'assign', projectId: id, sessionId: 'session' } } });
      } else if (path.endsWith('/commands/operation')) {
        assert.equal(body.failed, false);
        assert.equal(body.result.sessionId, 'session');
        events.push('acknowledged'); completed = true;
      } else { throw new Error('Unexpected request'); }
      return Response.json({ ok: true });
    },
  };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string) => {
    if (command === 'desktop_project_prepare_remote_session') { events.push('prepared'); return; }
    if (command === 'desktop_chat_move_session_to_project') { assigned = true; events.push('moved'); }
    return { activeSessionId: 'session', projects: [{ root: '/fixture/private-project', name: 'Example', sessions: assigned ? [{ id: 'session' }] : [] }] };
  } } });
  __setSessionBackendForTests({ load: async () => ({ token: 'synthetic-token', accountId: 'owner', deviceId: 'mac', expiresAt: '' }), save: async () => {}, clear: async () => {} });
  const root = createRoot(document.getElementById('root')!);
  function Probe() { useProjectSync(true, 'owner'); return null; }
  try {
    await act(async () => root.render(createElement(Probe)));
    for (let attempt = 0; !completed && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(completed, true);
    assert.deepEqual(events, ['published:0', 'prepared', 'moved', 'published:1', 'acknowledged']);
  } finally {
    await act(async () => root.unmount());
    __setSessionBackendForTests(null);
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

test('worktree sessions publish an opaque worktree ID and older servers still get membership', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = new Map(['window', 'document', 'fetch', 'Event', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const published: unknown[] = [];
  const worktreeId = 'f'.repeat(64);
  const globals = { window: dom.window, document: dom.window.document, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/projects') && init.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        published.push(body.projects[0]);
        assert(!String(init.body).includes('/fixture/'));
        // A server released before worktree IDs rejects the unknown field.
        if (body.projects[0].workspaces) return Response.json({ errorCode: 'project_unavailable' }, { status: 400 });
        return Response.json({ ok: true });
      }
      if (path.endsWith('/commands/next')) return Response.json({ command: null });
      return Response.json({ ok: true });
    },
  };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string, args?: { sessionIds?: string[] }) => {
    if (command === 'desktop_project_session_workspace_ids') {
      assert.deepEqual(args?.sessionIds, ['in-worktree', 'in-root']);
      return { 'in-worktree': worktreeId, 'in-root': 'not-an-id', unlisted: worktreeId };
    }
    return { projects: [{ root: '/fixture/private-project', name: 'Example', sessions: [{ id: 'in-worktree' }, { id: 'in-root' }] }] };
  } } });
  __setSessionBackendForTests({ load: async () => ({ token: 'synthetic-token', accountId: 'owner', deviceId: 'mac', expiresAt: '' }), save: async () => {}, clear: async () => {} });
  const root = createRoot(document.getElementById('root')!);
  function Probe() { useProjectSync(true, 'owner'); return null; }
  try {
    await act(async () => root.render(createElement(Probe)));
    for (let attempt = 0; published.length < 2 && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const [withWorktrees, membershipOnly] = published as Array<Record<string, unknown>>;
    assert.deepEqual(withWorktrees.workspaces, { 'in-worktree': worktreeId });
    assert.deepEqual(withWorktrees.sessions, ['in-worktree', 'in-root']);
    assert.equal('workspaces' in membershipOnly, false);
    assert.deepEqual(membershipOnly.sessions, ['in-worktree', 'in-root']);
  } finally {
    await act(async () => root.unmount());
    __setSessionBackendForTests(null);
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
