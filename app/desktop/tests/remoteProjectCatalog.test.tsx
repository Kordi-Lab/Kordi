import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { buildProjectRoutingGroups, type RemoteProjectMembership } from '../src/features/canonical/sessionResolver';
import { localProjectSessionHints } from '../src/features/projects/localProjectSessions';
import { projectChatGroups } from '../src/features/projects/projectChatGroups';
import { projectID } from '../src/features/projects/projectSync';
import { remoteProjectsFromCatalog, useRemoteProjectCatalog } from '../src/features/projects/remoteProjectCatalog';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import type { ChatSidebarRow } from '../src/pages/sidebar/chatSidebarRows';
import type { CanonicalSessionState, DesktopChatState } from '../src/kordi-app/types';

const ROOT = '/Users/example/example-project';
const CATALOG_ID = 'a'.repeat(64);

/** A fresh app profile: no local projects, only plain chats; agent sessions arrive through cloud sync. */
function freshProfile(projects: DesktopChatState['projects'] = []): DesktopChatState {
  const plain = { id: 'plain', title: 'plain', subtitle: '', updatedAtLabel: 'Now', updatedAtMs: 1, messageCount: 1, draft: false };
  return {
    cwd: '/Users/example', activeSessionId: 'plain', sessions: [plain], projects,
    activeSession: { ...plain, cwd: '/Users/example', messages: [] },
  } as unknown as DesktopChatState;
}

function synced(...sessions: Array<[string, number, string?]>): CanonicalSessionState {
  return {
    sessions: sessions.map(([id, at, status = 'active']) => ({
      id, kind: 'self-agent', title: id, status, createdByIdentityId: 'me', createdAtMs: at, updatedAtMs: at, lastMessageAtMs: at,
    })),
    messages: [],
  } as unknown as CanonicalSessionState;
}

function route(state: DesktopChatState, canonical: CanonicalSessionState, remoteProjects?: RemoteProjectMembership[]) {
  const hints = localProjectSessionHints(state, canonical);
  return buildProjectRoutingGroups(state.projects, canonical, {
    sessionHints: hints.sessionHints, unboundSessionIds: hints.unboundSessionIds, remoteProjects,
  });
}

function sidebar(groups: ReturnType<typeof route>, sessionIds: string[]) {
  const rows: ChatSidebarRow[] = sessionIds.map((sessionId) => ({
    kind: 'session', key: `session:${sessionId}`, sessionId, spaceId: 'agent', depth: 0, activePath: false,
  }));
  const projects = groups.map((group) => ({ id: group.id, name: group.name ?? group.id, sessions: group.sessions }));
  const grouped = projectChatGroups(rows, projects, new Set());
  return {
    projects: [...grouped.groups.values()].map((group) => [group.name, group.rows.map((row) => row.sessionId)]),
    recents: grouped.rows.filter((row) => row.key.startsWith('recent:')).map((row) => (row as { sessionId: string }).sessionId),
  };
}

const remote: RemoteProjectMembership = { id: CATALOG_ID, name: 'example-project', sessions: ['worktree-status', 'fork', 'gone'] };

test('synced sessions of a project from another Mac are grouped under it on a fresh profile', () => {
  const canonical = synced(['worktree-status', 3], ['fork', 2], ['plain', 1]);
  assert.deepEqual(sidebar(route(freshProfile(), canonical), ['worktree-status', 'fork', 'plain']).projects, []);

  const groups = route(freshProfile(), canonical, [remote]);
  const group = groups.find((entry) => entry.remote);
  assert.equal(group?.name, 'example-project');
  assert.equal(group?.persisted, false);
  assert.deepEqual(sidebar(groups, ['worktree-status', 'fork', 'plain']), {
    projects: [['example-project', ['worktree-status', 'fork']]],
    recents: ['plain'],
  });
});

test('a catalog project this Mac also has merges into the local project', () => {
  const local = [{ id: `project:${ROOT}`, name: 'example-project', root: ROOT, summary: '', sharedSources: [], sessions: [] }];
  const groups = route(freshProfile(local), synced(['worktree-status', 3]), [{ ...remote, localRoot: ROOT }]);
  assert.deepEqual(groups.map((group) => [group.id, group.remote ?? false, group.sessions.map((session) => session.id)]), [
    [`project:${ROOT}`, false, ['worktree-status']],
  ]);
});

test('archived and unknown sessions never join a catalog project', () => {
  const groups = route(freshProfile(), synced(['worktree-status', 3, 'archived']), [{ ...remote, sessions: ['worktree-status', 'gone'] }]);
  assert.deepEqual(groups, []);
});

test('sending in a synced project session keeps it in its project', () => {
  // Opening or sending loads a plain runtime copy of the session in this profile's chat folder.
  const afterSend = {
    ...freshProfile(),
    activeSessionId: 'worktree-status',
    sessions: [
      { id: 'worktree-status', title: 'Check the worktree status', subtitle: '', updatedAtLabel: 'Now', updatedAtMs: 9, messageCount: 2, draft: false },
      { id: 'plain', title: 'plain', subtitle: '', updatedAtLabel: 'Now', updatedAtMs: 1, messageCount: 1, draft: false },
    ],
    activeSession: { id: 'worktree-status', title: 'Check the worktree status', cwd: '/Users/example', messages: [] },
  } as unknown as DesktopChatState;
  const canonical = synced(['worktree-status', 9], ['fork', 2], ['plain', 1]);
  const groups = route(afterSend, canonical, [remote]);
  assert.deepEqual(sidebar(groups, ['worktree-status', 'fork', 'plain']), {
    projects: [['example-project', ['worktree-status', 'fork']]],
    recents: ['plain'],
  });
});

test('catalogs from this device are ignored and duplicates merge', () => {
  const devices = [
    { id: 'this-mac', projects: [{ id: CATALOG_ID, name: 'mine', sessions: ['local'] }] },
    { id: 'other-mac', projects: [{ id: CATALOG_ID, name: 'example-project', sessions: ['a'] }, { id: '', name: 'bad', sessions: [] }] },
    { id: 'third-mac', projects: [{ id: CATALOG_ID, name: 'example-project', sessions: ['a', 'b', 7] }] },
  ];
  assert.deepEqual(remoteProjectsFromCatalog(devices, 'this-mac', new Map([[CATALOG_ID, ROOT]])), [
    { id: CATALOG_ID, name: 'example-project', sessions: ['a', 'b'], localRoot: ROOT, workspaces: {} },
  ]);
  assert.deepEqual(remoteProjectsFromCatalog({ unexpected: true }, null, new Map()), []);
});

for (const bound of [false, true]) test(`unresolved catalog projects are searched once on this Mac (${bound ? 'found' : 'missing'})`, async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = new Map(['window', 'document', 'fetch', 'Event', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const requests: string[] = [];
  const invoked: Array<[string, Record<string, unknown> | undefined]> = [];
  let updates = 0;
  const localId = await projectID(ROOT);
  const globals = { window: dom.window, document: dom.window.document, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url: string, init: RequestInit) => {
      requests.push(`${init.method ?? 'GET'} ${new URL(url).pathname}`);
      return Response.json({ devices: [
        { id: 'this-mac', projects: [] },
        { id: 'other-mac', projects: [{ id: localId, name: 'example-project', sessions: ['s'] }, { id: CATALOG_ID, name: 'elsewhere', sessions: ['t'], workspaces: { t: 'e'.repeat(64), unlisted: 'e'.repeat(64) } }] },
      ] });
    },
  };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string, args?: Record<string, unknown>) => {
    invoked.push([command, args]);
    return command === 'desktop_project_resolve_catalog' && bound ? { root: '/Users/example/elsewhere', name: 'elsewhere' } : null;
  } } });
  dom.window.addEventListener('kordi-projects-updated', () => { updates += 1; });
  __setSessionBackendForTests({ load: async () => ({ token: 'synthetic-token', accountId: 'owner', deviceId: 'this-mac', expiresAt: '' }), save: async () => {}, clear: async () => {} });
  let result: RemoteProjectMembership[] | undefined;
  function Probe() { result = useRemoteProjectCatalog(true, [ROOT], ['/Users/example/chat-folder']); return null; }
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(createElement(Probe)));
    for (let attempt = 0; !result && attempt < 100; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    assert.deepEqual(result, [
      { id: localId, name: 'example-project', sessions: ['s'], localRoot: ROOT, workspaces: {} },
      { id: CATALOG_ID, name: 'elsewhere', sessions: ['t'], localRoot: null, workspaces: { t: 'e'.repeat(64) } },
    ]);
    for (let attempt = 0; invoked.length === 0 && attempt < 100; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    assert.deepEqual([...new Set(requests)], ['GET /v1/cloud/projects']);
    // Only the project without a local folder is searched, and only through the archive-aware command.
    assert.deepEqual(invoked, [['desktop_project_resolve_catalog', {
      catalogId: CATALOG_ID, name: 'elsewhere', hints: [ROOT, '/Users/example/chat-folder'],
    }]]);
    assert.equal(updates > 0, bound);
  } finally {
    await act(async () => root.unmount());
    __setSessionBackendForTests(null);
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
